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
export async function executeCommand(
  db: Db,
  input: {
    commandId: string;
    payload: Record<string, unknown>;
    handler: (ctx: CommandContext, payload: Record<string, unknown>) => Promise<CommandResult>;
  },
): Promise<CommandResult> {
  const hash = payloadSha256(input.payload);

  return await db.transaction(async (tx) => {
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
    case "ArtifactRegistered":
      await tx.insert(dopaiosArtifacts).values({
        id: d["artifactId"],
        revision: d["revision"],
        sha256: d["sha256"],
        artifactState: d["artifactState"],
        impactStatus: d["impactStatus"],
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
        runId: d["runId"],
        state: d["state"],
        executor: d["executor"] ?? null,
      });
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
      });
      break;
    case "DecisionPackageStateChanged":
      await tx
        .update(dopaiosDecisionPackages)
        .set({ state: d["state"] })
        .where(eq(dopaiosDecisionPackages.id, d["packageId"]));
      break;
    case "ApprovalRecorded":
      await tx.insert(dopaiosApprovalRecords).values({
        id: d["recordId"],
        packageId: d["packageId"],
        packageRevision: d["packageRevision"],
        outcome: d["outcome"],
        pinnedRefs: d["pinnedRefs"],
        actor: d["actor"],
      });
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
