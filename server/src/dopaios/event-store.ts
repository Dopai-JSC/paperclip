import { createHash } from "node:crypto";
import { sql, eq, getTableName } from "drizzle-orm";
import {
  createDb,
  dopaiosCommands,
  dopaiosActors,
  dopaiosProjects,
  dopaiosArtifacts,
  dopaiosSopDefinitions,
  dopaiosSopRuns,
  dopaiosWorkItems,
  dopaiosOutputVersions,
  dopaiosActionRequests,
  dopaiosDecisionPackages,
  dopaiosApprovalRecords,
  dopaiosProductBaselines,
  dopaiosAiSessions,
  dopaiosSessionArtifacts,
  dopaiosActivations,
  dopaiosAuthBreakers,
  dopaiosSeparationPolicies,
  dopaiosConditions,
  dopaiosImpactRecords,
  dopaiosGateRecords,
  dopaiosStaffAi,
  dopaiosStartupPools,
  dopaiosTeamManifests,
  dopaiosExecutionContracts,
  dopaiosQualityContracts,
  dopaiosRunSteps,
} from "@paperclipai/db";

// KC-01 spike: event-store adapter over the message-db blueprint schema
// (migration 0501) with the Dopaios command contract:
//  - events are written before projections, in the same transaction;
//  - idempotency per command_id: same id + same payload returns the stored
//    result, same id + different payload is rejected (PRD Mục 3 / FS-002);
//  - guards read projections inside the same transaction snapshot
//    (FS-003 SFR-048/049/057/058);
//  - projections are rebuilt from events by the same projector used live,
//    so replay reconstruction (FS-003 SQR-003) holds by construction.

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DopaiosEvent = {
  id: string;
  streamName: string;
  type: string;
  position: number;
  globalPosition: number;
  time: Date;
  data: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
};

export class CommandPayloadMismatchError extends Error {
  constructor(commandId: string) {
    super(`Command ${commandId} was already executed with a different payload`);
    this.name = "CommandPayloadMismatchError";
  }
}

export class CommandRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandRejectedError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function payloadSha256(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

export async function writeEvent(
  tx: Tx,
  input: {
    streamName: string;
    type: string;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    expectedVersion?: number;
  },
): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT message_store.write_message(
      gen_random_uuid()::text,
      ${input.streamName},
      ${input.type},
      ${JSON.stringify(input.data)}::jsonb,
      ${input.metadata ? JSON.stringify(input.metadata) : null}::jsonb,
      ${input.expectedVersion ?? null}::bigint
    ) AS position
  `)) as unknown as Array<{ position: string | number }>;
  return Number(rows[0]?.position);
}

function mapMessageRow(row: {
  id: string;
  stream_name: string;
  type: string;
  position: string | number;
  global_position: string | number;
  time: Date | string;
  data: unknown;
  metadata: unknown;
}): DopaiosEvent {
  return {
    id: row.id,
    streamName: row.stream_name,
    type: row.type,
    position: Number(row.position),
    globalPosition: Number(row.global_position),
    time: row.time instanceof Date ? row.time : new Date(row.time),
    data: (row.data ?? {}) as Record<string, unknown>,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
  };
}

export async function readStream(db: Db | Tx, streamName: string): Promise<DopaiosEvent[]> {
  const rows = (await db.execute(sql`
    SELECT id, stream_name, type, position, global_position, time, data, metadata
    FROM message_store.messages
    WHERE stream_name = ${streamName}
    ORDER BY position
  `)) as unknown as Parameters<typeof mapMessageRow>[0][];
  return rows.map(mapMessageRow);
}

export async function readAllEvents(db: Db | Tx): Promise<DopaiosEvent[]> {
  const rows = (await db.execute(sql`
    SELECT id, stream_name, type, position, global_position, time, data, metadata
    FROM message_store.messages
    ORDER BY global_position
  `)) as unknown as Parameters<typeof mapMessageRow>[0][];
  return rows.map(mapMessageRow);
}

export async function countAllEvents(db: Db | Tx): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::bigint AS n FROM message_store.messages`,
  )) as unknown as Array<{ n: string | number }>;
  return Number(rows[0]?.n ?? 0);
}

export type CommandResult = Record<string, unknown>;

export type CommandContext = {
  tx: Tx;
  emit: (input: {
    streamName: string;
    type: string;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    expectedVersion?: number;
  }) => Promise<number>;
};

// Executes a command exactly once per command_id. The handler receives an
// `emit` that writes the event AND applies the shared projector inside the
// same transaction — the event row is always written before the projection
// update, and both commit or roll back together (REC-001: no partial records).
//
// KC-14 B7 (blocker vòng review đối kháng — write-skew): transaction chạy ở
// SERIALIZABLE. Với READ COMMITTED, guard đọc projection TRƯỚC khi chiếm khóa
// category của message-db, nên hai lệnh hợp lệ riêng lẻ chạy song song có thể
// cùng commit và tạo trạng thái cấm (approve × nộp bản sửa, cancel × nộp,
// hai quyết định trên một yêu cầu…). SSI của Postgres phát hiện các đan xen
// đó và hủy một bên (40001); deadlock advisory-lock đa-category (40P01) cũng
// được giải cùng cơ chế: executeCommand retry trọn transaction — an toàn vì
// idempotency theo command_id, handler thuần đọc-tx + emit. Hai thực thi song
// song CÙNG command_id đều thấy 0 hàng (FOR UPDATE không khóa hàng chưa có):
// bên thua vỡ unique 23505 trên dopaios_commands và được quy đổi thành
// idempotent replay / payload mismatch thay vì lỗi thô.
const SERIALIZATION_RETRIES = 5;

function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return (error as { code?: string })?.code ?? cause?.code;
}

export async function executeCommand(
  db: Db,
  input: {
    commandId: string;
    payload: Record<string, unknown>;
    handler: (ctx: CommandContext, payload: Record<string, unknown>) => Promise<CommandResult>;
  },
): Promise<CommandResult> {
  const hash = payloadSha256(input.payload);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
        const existing = (await tx.execute(sql`
          SELECT payload_sha256, result FROM dopaios_commands
          WHERE command_id = ${input.commandId}
          FOR UPDATE
        `)) as unknown as Array<{ payload_sha256: string; result: CommandResult }>;

        if (existing.length > 0) {
          if (existing[0].payload_sha256 !== hash) {
            throw new CommandPayloadMismatchError(input.commandId);
          }
          return { ...existing[0].result, idempotentReplay: true };
        }

        const emit: CommandContext["emit"] = async (eventInput) => {
          const position = await writeEvent(tx, eventInput);
          const events = await readStream(tx, eventInput.streamName);
          const written = events.find((event) => event.position === position);
          if (!written) {
            throw new Error(`Event just written to ${eventInput.streamName} not readable in-transaction`);
          }
          await projectEvent(tx, written);
          return position;
        };

        const result = await input.handler({ tx, emit }, input.payload);

        await tx.insert(dopaiosCommands).values({
          commandId: input.commandId,
          payloadSha256: hash,
          result,
        });

        return result;
      });
    } catch (error) {
      const code = pgErrorCode(error);
      // Bên thua của cuộc đua cùng command_id: quy đổi thành replay/mismatch.
      if (code === "23505" && String((error as Error).message ?? error).includes("dopaios_commands")) {
        const stored = (await db.execute(sql`
          SELECT payload_sha256, result FROM dopaios_commands WHERE command_id = ${input.commandId}
        `)) as unknown as Array<{ payload_sha256: string; result: CommandResult }>;
        if (stored.length > 0) {
          if (stored[0].payload_sha256 !== hash) {
            throw new CommandPayloadMismatchError(input.commandId);
          }
          return { ...stored[0].result, idempotentReplay: true };
        }
      }
      // Serialization failure / deadlock: thử lại trọn transaction.
      if ((code === "40001" || code === "40P01") && attempt < SERIALIZATION_RETRIES) {
        continue;
      }
      throw error;
    }
  }
}

// Single projector shared by live execution and replay (SQR-003).
export async function projectEvent(tx: Db | Tx, event: DopaiosEvent): Promise<void> {
  const d = event.data as Record<string, never>;
  switch (event.type) {
    case "ActorRegistered":
      await tx.insert(dopaiosActors).values({
        id: d["actorId"],
        kind: d["kind"],
        active: d["active"],
        capabilities: d["capabilities"],
      });
      break;
    case "ProjectShellCreated":
      await tx.insert(dopaiosProjects).values({
        id: d["projectId"],
        state: "PREPARING",
        templateRef: d["templateRef"],
        orchestrator: d["orchestrator"],
        createdBy: d["createdBy"],
      });
      break;
    // KC-13: P0-01 stub theo nguồn PRD (UJ-10/FR-1/AC-FR-69.2 — FS-001 chủ đích
    // không có command dương ra khỏi PREPARING, đường đó thuộc DS-2; spike dựng
    // để có bối cảnh P0, ghi giới hạn tại hồ sơ).
    case "ProjectEnteredP0":
      await tx
        .update(dopaiosProjects)
        .set({ state: "P0_ACTIVE" })
        .where(eq(dopaiosProjects.id, d["projectId"]));
      break;
    case "ArtifactRegistered":
      await tx.insert(dopaiosArtifacts).values({
        id: d["artifactId"],
        revision: d["revision"],
        sha256: d["sha256"],
        artifactState: d["artifactState"],
        impactStatus: d["impactStatus"],
        createdBy: d["createdBy"] ?? null,
        artifactType: d["artifactType"] ?? null,
        hasRegionSchema: d["hasRegionSchema"] ?? null,
      });
      break;
    case "ArtifactStateChanged":
      await tx
        .update(dopaiosArtifacts)
        .set({ artifactState: d["artifactState"] })
        .where(sql`${dopaiosArtifacts.id} = ${d["artifactId"]} AND ${dopaiosArtifacts.revision} = ${d["revision"]}`);
      break;
    case "ArtifactImpactChanged":
      await tx
        .update(dopaiosArtifacts)
        .set({ impactStatus: d["impactStatus"] })
        .where(sql`${dopaiosArtifacts.id} = ${d["artifactId"]} AND ${dopaiosArtifacts.revision} = ${d["revision"]}`);
      break;
    case "AiSessionStarted":
      await tx.insert(dopaiosAiSessions).values({
        id: d["sessionId"],
        workItemId: d["workItemId"],
        agentId: d["agentId"],
        engine: d["engine"],
        state: "RUNNING",
        predecessorId: d["predecessorId"] ?? null,
        relation: d["relation"] ?? null,
        lastSignalAt: event.time,
      });
      break;
    case "AiSessionSignal":
      await tx
        .update(dopaiosAiSessions)
        .set({ lastSignalAt: event.time })
        .where(eq(dopaiosAiSessions.id, d["sessionId"]));
      break;
    case "AiSessionArtifactRecorded":
      await tx.insert(dopaiosSessionArtifacts).values({
        sessionId: d["sessionId"],
        seq: d["seq"],
        kind: d["kind"],
        ref: d["ref"],
        sha256: d["sha256"],
        confirmed: d["confirmed"],
      });
      break;
    case "AiSessionInterrupted":
      await tx
        .update(dopaiosAiSessions)
        .set({ state: "INTERRUPTED", detectionLatencyMs: d["detectionLatencyMs"] })
        .where(eq(dopaiosAiSessions.id, d["sessionId"]));
      break;
    case "AiSessionTerminal":
      await tx
        .update(dopaiosAiSessions)
        .set({ state: "TERMINAL", outcome: d["outcome"] })
        .where(eq(dopaiosAiSessions.id, d["sessionId"]));
      break;
    case "ActivationRequested":
      await tx.insert(dopaiosActivations).values({
        id: d["activationId"],
        workItemId: d["workItemId"],
        agentId: d["agentId"],
        engine: d["engine"],
        state: "QUEUED",
        contractId: d["contractId"] ?? null,
        contractRevision: d["contractRevision"] ?? null,
      });
      break;
    case "ActivationClaimed":
      await tx
        .update(dopaiosActivations)
        .set({
          state: "RUNNING",
          claimedBy: d["claimedBy"],
          claimLeaseUntil: d["leaseUntil"] ? new Date(d["leaseUntil"] as string) : null,
        })
        .where(eq(dopaiosActivations.id, d["activationId"]));
      break;
    // KC-13 B5: thu hồi claim mồ côi — lease hết hạn, activation quay về hàng
    // đợi với epoch tăng (claimer cũ ghi muộn bị ERR-LEASE-EPOCH chặn).
    case "ActivationRequeued":
      await tx
        .update(dopaiosActivations)
        .set({
          state: "QUEUED",
          claimedBy: null,
          claimLeaseUntil: null,
          leaseEpoch: d["newEpoch"],
        })
        .where(eq(dopaiosActivations.id, d["activationId"]));
      break;
    case "ActivationCompleted":
      await tx
        .update(dopaiosActivations)
        .set({ state: "DONE", outcome: d["outcome"] })
        .where(eq(dopaiosActivations.id, d["activationId"]));
      break;
    case "AuthFailureRecorded":
      await tx
        .insert(dopaiosAuthBreakers)
        .values({ id: d["breakerId"], state: "CLOSED", consecutiveFailures: d["count"] })
        .onConflictDoUpdate({
          target: dopaiosAuthBreakers.id,
          set: { consecutiveFailures: d["count"] },
        });
      break;
    case "BreakerTripped":
      await tx
        .update(dopaiosAuthBreakers)
        .set({ state: "OPEN" })
        .where(eq(dopaiosAuthBreakers.id, d["breakerId"]));
      break;
    case "BreakerReset":
      await tx
        .insert(dopaiosAuthBreakers)
        .values({ id: d["breakerId"], state: "CLOSED", consecutiveFailures: 0 })
        .onConflictDoUpdate({
          target: dopaiosAuthBreakers.id,
          set: { state: "CLOSED", consecutiveFailures: 0 },
        });
      break;
    case "BaselinePinned":
      await tx.insert(dopaiosProductBaselines).values({
        id: d["baselineId"],
        revision: d["revision"],
        state: "pinned",
        items: d["items"],
        pinnedBy: d["pinnedBy"],
      });
      break;
    case "SopDefinitionCreated":
      await tx.insert(dopaiosSopDefinitions).values({
        id: d["definitionId"],
        revision: d["revision"],
        state: "draft",
        sopPin: d["sopPin"],
      });
      break;
    case "SopDefinitionPublished":
      await tx
        .update(dopaiosSopDefinitions)
        .set({ state: "published", contractSuiteEvidence: d["contractSuiteEvidence"] })
        .where(eq(dopaiosSopDefinitions.id, d["definitionId"]));
      break;
    case "TestRunRequested":
      await tx.insert(dopaiosSopRuns).values({
        id: d["runId"],
        label: "test",
        state: "NOT_ACTIVATED",
        definitionRef: d["definitionRef"],
        decider: d["decider"],
        pod: d["pod"],
      });
      break;
    case "SopRunStateChanged":
      // completed_at arrived with migration 0503 (schema evolution drill):
      // derived from the immutable event time, so replay backfills rows that
      // were projected before the column existed.
      await tx
        .update(dopaiosSopRuns)
        .set({
          state: d["state"],
          ...((d["state"] as string) === "COMPLETED" ? { completedAt: event.time } : {}),
        })
        .where(eq(dopaiosSopRuns.id, d["runId"]));
      break;
    case "WorkItemCreated":
      await tx.insert(dopaiosWorkItems).values({
        id: d["workItemId"],
        runId: d["runId"] ?? null,
        state: d["state"],
        executor: d["executor"] ?? null,
        projectId: d["projectId"] ?? null,
        role: d["role"] ?? null,
        // KC-14: biến thể rework của SFR-022 mang liên kết bản trước.
        reworkOfWorkItemId: d["reworkOfWorkItemId"] ?? null,
        reworkOfOutputRef: d["reworkOfOutputRef"] ?? null,
      });
      break;
    // KC-13 B4: kết quả định tuyến — đích + căn cứ chọn (FR-42).
    case "WorkItemRouted":
      await tx
        .update(dopaiosWorkItems)
        .set({ routedTo: d["staffId"], routingBasis: d["basis"] })
        .where(eq(dopaiosWorkItems.id, d["workItemId"]));
      break;
    case "WorkItemStateChanged":
      await tx
        .update(dopaiosWorkItems)
        .set({ state: d["state"], ...(d["executor"] ? { executor: d["executor"] } : {}) })
        .where(eq(dopaiosWorkItems.id, d["workItemId"]));
      break;
    case "OutputVersionRecorded":
      await tx.insert(dopaiosOutputVersions).values({
        id: d["outputId"],
        revision: d["revision"],
        workItemId: d["workItemId"],
        state: d["state"],
        contentSha256: d["contentSha256"],
        // KC-14: pin Hợp đồng chất lượng lúc nộp + quan hệ thay thế (SFR-030).
        qualityContractRef: d["qualityContractRef"] ?? null,
        checkEvidence: d["checkEvidence"] ?? null,
        replacesRevision: d["replacesRevision"] ?? null,
      });
      break;
    case "OutputVersionStateChanged":
      await tx
        .update(dopaiosOutputVersions)
        .set({ state: d["state"] })
        .where(
          sql`${dopaiosOutputVersions.id} = ${d["outputId"]} AND ${dopaiosOutputVersions.revision} = ${d["revision"]}`,
        );
      break;
    case "ActionRequestCreated":
      await tx.insert(dopaiosActionRequests).values({
        id: d["requestId"],
        kind: d["kind"],
        state: "OPEN",
        runId: d["runId"],
        // KC-14: yêu cầu link gói để vô hiệu theo target đổi (SFR-031).
        packageId: d["packageId"] ?? null,
        packageRevision: d["packageRevision"] ?? null,
      });
      break;
    case "ActionRequestStateChanged":
      await tx
        .update(dopaiosActionRequests)
        .set({ state: d["state"], ...(d["decidedBy"] ? { decidedBy: d["decidedBy"] } : {}) })
        .where(eq(dopaiosActionRequests.id, d["requestId"]));
      break;
    case "DecisionPackageAssembled":
      await tx.insert(dopaiosDecisionPackages).values({
        id: d["packageId"],
        revision: d["revision"],
        state: "OPEN",
        refs: d["refs"],
        target: d["target"] ?? null,
        fields: d["fields"] ?? null,
      });
      break;
    case "DecisionPackageStateChanged":
      await tx
        .update(dopaiosDecisionPackages)
        .set({ state: d["state"] })
        .where(eq(dopaiosDecisionPackages.id, d["packageId"]));
      break;
    // KC-03: đổi trạng thái ĐÚNG một revision của gói (khóa id+revision) —
    // case cũ theo id giữ nguyên cho replay event KC-01.
    case "DecisionPackageRevisionStateChanged":
      await tx
        .update(dopaiosDecisionPackages)
        .set({ state: d["state"] })
        .where(
          sql`${dopaiosDecisionPackages.id} = ${d["packageId"]} AND ${dopaiosDecisionPackages.revision} = ${d["revision"]}`,
        );
      break;
    case "ApprovalRecorded":
      await tx.insert(dopaiosApprovalRecords).values({
        id: d["recordId"],
        packageId: d["packageId"],
        packageRevision: d["packageRevision"],
        outcome: d["outcome"],
        pinnedRefs: d["pinnedRefs"],
        actor: d["actor"],
        targetId: d["targetId"] ?? null,
        targetRevision: d["targetRevision"] ?? null,
        targetSha256: d["targetSha256"] ?? null,
        approvedScope: d["approvedScope"] ?? null,
        findings: d["findings"] ?? null,
        nonWaivableBlockers: d["nonWaivableBlockers"] ?? null,
        impactSet: d["impactSet"] ?? null,
        downstreamChecked: d["downstreamChecked"] ?? null,
        openedStep: d["openedStep"] ?? null,
        reEntryPoint: d["reEntryPoint"] ?? null,
        expiry: d["expiry"] ?? null,
        requestedBy: d["requestedBy"] ?? null,
      });
      break;
    // ===== KC-03: approval engine =====
    case "SeparationPolicyPinned":
      await tx
        .insert(dopaiosSeparationPolicies)
        .values({
          id: d["policyId"],
          artifactType: d["artifactType"],
          revision: d["revision"],
          policy: d["policy"],
          pinnedBy: d["pinnedBy"],
        })
        .onConflictDoUpdate({
          target: dopaiosSeparationPolicies.id,
          set: { revision: d["revision"], policy: d["policy"], pinnedBy: d["pinnedBy"] },
        });
      break;
    case "ConditionOpened":
      await tx.insert(dopaiosConditions).values({
        id: d["conditionId"],
        recordId: d["recordId"],
        scope: d["scope"],
        risk: d["risk"],
        owner: d["owner"],
        deadline: new Date(d["deadline"] as string),
        closureCriteria: d["closureCriteria"],
        compensatingObligation: d["compensatingObligation"] ?? null,
        blocksNextStep: d["blocksNextStep"],
        state: "open",
      });
      break;
    case "ConditionClosed":
      await tx
        .update(dopaiosConditions)
        .set({
          state: "closed",
          closedBy: d["closedBy"],
          closedAt: event.time,
          closureEvidence: d["closureEvidence"],
        })
        .where(eq(dopaiosConditions.id, d["conditionId"]));
      break;
    case "ConditionOverdueDeclared":
      await tx
        .update(dopaiosConditions)
        .set({ state: "overdue" })
        .where(eq(dopaiosConditions.id, d["conditionId"]));
      break;
    case "ImpactRecordOpened":
      await tx.insert(dopaiosImpactRecords).values({
        id: d["impactId"],
        artifactId: d["artifactId"],
        artifactRevision: d["artifactRevision"],
        source: d["source"],
        sourceRef: d["sourceRef"] ?? null,
        state: "open",
      });
      break;
    case "ImpactRecordDispositioned":
      await tx
        .update(dopaiosImpactRecords)
        .set({
          state: "dispositioned",
          conclusion: d["conclusion"],
          dispositionedBy: d["dispositionedBy"],
          basis: d["basis"],
        })
        .where(eq(dopaiosImpactRecords.id, d["impactId"]));
      break;
    case "GateRecordCreated":
      await tx.insert(dopaiosGateRecords).values({
        id: d["gateRecordId"],
        gateName: d["gateName"],
        pointId: d["pointId"],
        runId: d["runId"] ?? null,
        approvalRecordId: d["approvalRecordId"],
      });
      break;
    // ===== KC-13: định tuyến + kích hoạt =====
    case "StaffAiRegistered":
      await tx.insert(dopaiosStaffAi).values({
        id: d["staffId"],
        workStatus: d["workStatus"],
        capabilities: d["capabilities"],
        skills: d["skills"],
        permissions: d["permissions"],
        resources: d["resources"],
        autonomyLimits: d["autonomyLimits"] ?? null,
        modelVersion: d["modelVersion"] ?? null,
        capacityLimit: d["capacityLimit"],
        profileRevision: d["profileRevision"],
      });
      break;
    case "StaffAiStatusChanged":
      await tx
        .update(dopaiosStaffAi)
        .set({ workStatus: d["workStatus"] })
        .where(eq(dopaiosStaffAi.id, d["staffId"]));
      break;
    case "StartupPoolPinned":
      await tx.insert(dopaiosStartupPools).values({
        id: d["poolId"],
        revision: d["revision"],
        roles: d["roles"],
        readiness: d["readiness"],
        state: "active",
        pinnedBy: d["pinnedBy"],
      });
      break;
    case "StartupPoolRevisionStateChanged":
      await tx
        .update(dopaiosStartupPools)
        .set({ state: d["state"] })
        .where(
          sql`${dopaiosStartupPools.id} = ${d["poolId"]} AND ${dopaiosStartupPools.revision} = ${d["revision"]}`,
        );
      break;
    case "TeamManifestProposed":
      await tx.insert(dopaiosTeamManifests).values({
        id: d["manifestId"],
        revision: d["revision"],
        stage: d["stage"],
        projectId: d["projectId"],
        state: "proposed",
        poolRef: d["poolRef"],
        roleAssignments: d["roleAssignments"],
        orchestrator: d["orchestrator"],
        pod: d["pod"],
        capacity: d["capacity"],
        permissions: d["permissions"],
        resources: d["resources"],
        routingRules: d["routingRules"],
        timeouts: d["timeouts"] ?? null,
        escalation: d["escalation"] ?? null,
        fallbackPaths: d["fallbackPaths"] ?? null,
        costLimits: d["costLimits"] ?? null,
        autonomy: d["autonomy"] ?? null,
        createdBy: d["createdBy"],
        sha256: d["sha256"],
      });
      break;
    case "TeamManifestApproved":
      // effective_at lấy từ event time bất biến — replay dựng lại đúng mốc.
      await tx
        .update(dopaiosTeamManifests)
        .set({
          state: "approved",
          approvedBy: d["approvedBy"],
          approvedAt: event.time,
          effectiveAt: event.time,
        })
        .where(
          sql`${dopaiosTeamManifests.id} = ${d["manifestId"]} AND ${dopaiosTeamManifests.revision} = ${d["revision"]}`,
        );
      break;
    case "TeamManifestRevisionStateChanged":
      await tx
        .update(dopaiosTeamManifests)
        .set({ state: d["state"] })
        .where(
          sql`${dopaiosTeamManifests.id} = ${d["manifestId"]} AND ${dopaiosTeamManifests.revision} = ${d["revision"]}`,
        );
      break;
    case "ExecutionContractCompiled":
      await tx.insert(dopaiosExecutionContracts).values({
        id: d["contractId"],
        revision: d["revision"],
        workItemId: d["workItemId"],
        sources: d["sources"],
        fields: d["fields"],
        state: "active",
        sha256: d["sha256"],
        compiledBy: d["compiledBy"],
      });
      break;
    case "ExecutionContractRevisionStateChanged":
      await tx
        .update(dopaiosExecutionContracts)
        .set({ state: d["state"] })
        .where(
          sql`${dopaiosExecutionContracts.id} = ${d["contractId"]} AND ${dopaiosExecutionContracts.revision} = ${d["revision"]}`,
        );
      break;
    // ===== KC-14: hai vòng đời thực hiện và chất lượng =====
    // Nội dung Hợp đồng chất lượng theo (id, revision); hiệu lực do guard đọc
    // sổ artifact FS-002 trong cùng transaction (QD-2 kế hoạch KC-14).
    case "QualityContractRegistered":
      await tx.insert(dopaiosQualityContracts).values({
        id: d["contractId"],
        revision: d["revision"],
        outputType: d["outputType"],
        requiredChecks: d["requiredChecks"],
        sha256: d["sha256"],
        registeredBy: d["registeredBy"],
      });
      break;
    // Bằng chứng của MỘT loại kiểm gắn vào đúng phiên bản đầu ra; merge jsonb
    // tuần tự theo global_position nên replay tái dựng đúng (SQR-003).
    case "OutputVersionCheckEvidenceAdded":
      await tx
        .update(dopaiosOutputVersions)
        .set({
          checkEvidence: sql`coalesce(${dopaiosOutputVersions.checkEvidence}, '{}'::jsonb) || ${JSON.stringify({ [d["checkKey"] as string]: d["evidence"] })}::jsonb`,
        })
        .where(
          sql`${dopaiosOutputVersions.id} = ${d["outputId"]} AND ${dopaiosOutputVersions.revision} = ${d["revision"]}`,
        );
      break;
    // Approval hết hiệu lực (SFR-031/034): lifecycle của phiên bản KHÔNG đổi,
    // chỉ record mang invalidated_at/invalidation_reason từ event bất biến.
    case "ApprovalInvalidated":
      await tx
        .update(dopaiosApprovalRecords)
        .set({ invalidatedAt: event.time, invalidationReason: d["reason"] })
        .where(eq(dopaiosApprovalRecords.id, d["recordId"]));
      break;
    // Yêu cầu liên kết gói vô hiệu do target đổi (SFR-031, DEV-009): terminal
    // của revision, KHÔNG ghi quan hệ tới record tương lai.
    case "ActionRequestInvalidated":
      await tx
        .update(dopaiosActionRequests)
        .set({ state: "SUPERSEDED-TARGET-CHANGED", invalidation: d["invalidation"] })
        .where(eq(dopaiosActionRequests.id, d["requestId"]));
      break;
    // Bước mở theo approval (SFR-029) — upsert để tái mở sau tái chặn giữ
    // đúng một hàng theo (run, step).
    case "RunStepOpened":
      await tx
        .insert(dopaiosRunSteps)
        .values({
          runId: d["runId"],
          stepId: d["stepId"],
          state: "open",
          openedByRecordId: d["recordId"] ?? null,
        })
        .onConflictDoUpdate({
          target: [dopaiosRunSteps.runId, dopaiosRunSteps.stepId],
          set: { state: "open", openedByRecordId: (d["recordId"] ?? null) as string | null },
        });
      break;
    case "RunStepReblocked":
      await tx
        .update(dopaiosRunSteps)
        .set({ state: "reblocked" })
        .where(
          sql`${dopaiosRunSteps.runId} = ${d["runId"]} AND ${dopaiosRunSteps.stepId} = ${d["stepId"]}`,
        );
      break;
    default:
      // Unknown event types are tolerated: audit-only events have no
      // projection, and replay of a newer log through an older projector is a
      // schema-evolution concern out of scope for this spike slice.
      break;
  }
}

const PROJECTION_TABLES = [
  dopaiosActors,
  dopaiosProjects,
  dopaiosArtifacts,
  dopaiosSopDefinitions,
  dopaiosSopRuns,
  dopaiosWorkItems,
  dopaiosOutputVersions,
  dopaiosActionRequests,
  dopaiosDecisionPackages,
  dopaiosApprovalRecords,
  dopaiosProductBaselines,
  dopaiosAiSessions,
  dopaiosSessionArtifacts,
  dopaiosActivations,
  dopaiosAuthBreakers,
  dopaiosSeparationPolicies,
  dopaiosConditions,
  dopaiosImpactRecords,
  dopaiosGateRecords,
  dopaiosStaffAi,
  dopaiosStartupPools,
  dopaiosTeamManifests,
  dopaiosExecutionContracts,
  dopaiosQualityContracts,
  dopaiosRunSteps,
] as const;

export async function snapshotProjections(db: Db): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of PROJECTION_TABLES) {
    const rows = (await db.execute(
      sql`SELECT * FROM ${table} ORDER BY 1, 2`,
    )) as unknown as unknown[];
    snapshot[getTableName(table)] = [...rows];
  }
  return snapshot;
}

// Wipes every projection table and rebuilds it from the event log alone.
// Reads happen strictly in global_position order (SQR-004 total order).
export async function replayProjections(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const table of PROJECTION_TABLES) {
      await tx.execute(sql`DELETE FROM ${table}`);
    }
    const events = await readAllEvents(tx);
    for (const event of events) {
      await projectEvent(tx, event);
    }
  });
}
