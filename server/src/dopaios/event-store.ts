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
  dopaiosSessionUsage,
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
  dopaiosContextPackages,
  dopaiosContextPackageSources,
  dopaiosArtifactProjectScopes,
  dopaiosConnectorPolicies,
  dopaiosConnectorCredentials,
  dopaiosConnectorAuditEvents,
  dopaiosDkpChunks,
  dopaiosRetrievalQueries,
  dopaiosRetrievalHits,
  dopaiosQualityContracts,
  dopaiosRunSteps,
  dopaiosWorkItemDependencies,
  dopaiosWorkspaces,
  dopaiosWorkspaceResources,
  dopaiosBootstrapWorkflows,
  dopaiosCutoverReadiness,
  dopaiosRuntimeActivationSnapshots,
  dopaiosCutoverRecords,
  dopaiosCutoverReconciliations,
} from "@paperclipai/db";
import {
  KC08_STRUCTURED_MARKDOWN_INDEX_VERSION,
  structuredMarkdownChunks,
} from "./dkp-chunking.js";

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

// KC-05: xuất dạng chuỗi canonical để tầng fs ghi nội dung có sha256 khớp
// đúng công thức payloadSha256 (credential fixture, artifact tạm) — thuần
// cộng, không đổi hành vi KC-01.
export function canonicalJsonString(value: unknown): string {
  return canonicalJson(value);
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
      // KC-15 B5 (minor review lens 2): 23505 trên bảng KHÁC dopaios_commands
      // trong đua song song cũng retry — lần chạy lại đọc snapshot mới và
      // guard tương ứng trả rejection sạch (an toàn vì idempotency theo
      // command_id và handler thuần đọc-tx + emit).
      if (code === "40001" || code === "40P01" || code === "23505") {
        if (attempt < SERIALIZATION_RETRIES) {
          // KC-05 B7 (finding hậu regression): retry tức thời làm hai chuỗi
          // lệnh song song nhịp nhau thua lặp (livelock) tới cạn lượt —
          // backoff ngắn tăng dần kèm jitter phá nhịp; idempotency theo
          // command_id giữ an toàn cho mọi lần chạy lại.
          await new Promise((resolveRetry) =>
            setTimeout(resolveRetry, attempt * 15 + Math.floor(Math.random() * 20)),
          );
          continue;
        }
        // KC-05 B7 (minor review lens 2): cạn retry thì trả rejection có mã
        // thay vì lỗi PG thô — caller qua executeAuditedCommand để lại vệt
        // audit như mọi đường chặn khác (SQR-001).
        throw new CommandRejectedError(
          "ERR-CONTENTION",
          `Command ${input.commandId} thua tranh chấp serialize ${SERIALIZATION_RETRIES} lần liên tiếp (mã PG ${code})`,
        );
      }
      throw error;
    }
  }
}

// Single projector shared by live execution and replay (SQR-003).
async function requirePinnedPgvectorProjection(tx: Db | Tx): Promise<void> {
  const capabilities = (await tx.execute(sql`
    SELECT available, version
    FROM dopaios_kc08_capabilities
    WHERE name = 'pgvector'
  `)) as unknown as Array<{ available: boolean; version: string | null }>;
  if (!capabilities[0]?.available || capabilities[0].version !== "0.8.6") {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-PGVECTOR",
      "KC-08 cannot project vector index events without the pinned pgvector 0.8.6 capability",
    );
  }
}

function assertContextPackageProjection(data: Record<string, unknown>): void {
  const sources = data["sources"];
  const maxBytes = data["maxBytes"];
  const maxTokens = data["maxTokens"];
  const totalBytes = data["totalBytes"];
  const totalTokens = data["totalTokens"];
  if (
    !Array.isArray(sources) ||
    !Number.isInteger(maxBytes) || (maxBytes as number) < 0 ||
    !Number.isInteger(maxTokens) || (maxTokens as number) < 0 ||
    !Number.isInteger(totalBytes) || (totalBytes as number) < 0 ||
    !Number.isInteger(totalTokens) || (totalTokens as number) < 0
  ) {
    throw new CommandRejectedError(
      "ERR-CONTEXT-PROJECTION",
      "Context Package event carries malformed caps, totals, or sources",
    );
  }

  let mountedBytes = 0;
  let mountedTokens = 0;
  for (const rawSource of sources) {
    const source = rawSource as Record<string, unknown>;
    const mountState = source["mountState"];
    const content = source["content"];
    const contentBytes = source["contentBytes"];
    const tokenCount = source["tokenCount"];
    const sourceSha256 = source["sha256"];
    const required = source["required"];
    const omissionReason = source["omissionReason"];
    const validCounts =
      Number.isInteger(contentBytes) && (contentBytes as number) >= 0 &&
      Number.isInteger(tokenCount) && (tokenCount as number) >= 0;
    const mounted =
      mountState === "mounted" &&
      typeof content === "string" &&
      omissionReason === null &&
      validCounts &&
      Buffer.byteLength(content, "utf8") === contentBytes &&
      typeof sourceSha256 === "string" &&
      createHash("sha256").update(content, "utf8").digest("hex") === sourceSha256;
    const omitted =
      mountState === "omitted" &&
      content === null &&
      typeof omissionReason === "string" && omissionReason.length > 0 &&
      required === false &&
      validCounts;
    if (!mounted && !omitted) {
      throw new CommandRejectedError(
        "ERR-CONTEXT-PROJECTION",
        "Context Package source bytes, hash, mount state, or omission are incoherent",
      );
    }
    if (mounted) {
      mountedBytes += contentBytes as number;
      mountedTokens += tokenCount as number;
    }
  }
  if (
    mountedBytes !== totalBytes ||
    mountedTokens !== totalTokens ||
    mountedBytes > (maxBytes as number) ||
    mountedTokens > (maxTokens as number)
  ) {
    throw new CommandRejectedError(
      "ERR-CONTEXT-PROJECTION",
      "Context Package declared totals do not equal its mounted source totals and caps",
    );
  }
}

async function assertRetrievalQueryProvenance(
  tx: Db | Tx,
  data: Record<string, unknown>,
): Promise<void> {
  const matches = (await tx.execute(sql`
    SELECT 1 AS matched
    FROM dopaios_ai_sessions s
    JOIN dopaios_work_items w ON w.id = s.work_item_id
    WHERE s.id = ${data["sessionId"]}
      AND s.state = 'RUNNING'
      AND w.project_id = ${data["projectId"]}
      AND s.context_package_id = ${data["contextPackageId"]}
      AND s.context_package_revision = ${data["contextPackageRevision"]}
      AND s.context_package_sha256 = ${data["contextPackageSha256"]}
  `)) as unknown as unknown[];
  if (matches.length !== 1) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-SESSION",
      "Retrieval query event does not match a RUNNING session's exact Project and Context Package pin",
    );
  }
}

async function assertDkpChunkProvenance(
  tx: Db | Tx,
  data: Record<string, unknown>,
): Promise<void> {
  const projectId = data["projectId"];
  const contextPackageId = data["contextPackageId"];
  const contextPackageRevision = data["contextPackageRevision"];
  const sourceId = data["sourceId"];
  const sourceRevision = data["sourceRevision"];
  const chunkId = data["chunkId"];
  const ordinal = data["ordinal"];
  const charStart = data["charStart"];
  const charEnd = data["charEnd"];
  const content = data["content"];
  const embedding = data["embedding"];
  const embeddingModelRef = data["embeddingModelRef"] as Record<string, unknown> | null;
  const indexVersion = data["indexVersion"];
  const validShape =
    typeof projectId === "string" && projectId.length > 0 &&
    typeof contextPackageId === "string" && contextPackageId.length > 0 &&
    Number.isInteger(contextPackageRevision) &&
    typeof sourceId === "string" && sourceId.length > 0 &&
    Number.isInteger(sourceRevision) &&
    typeof chunkId === "string" && chunkId.length > 0 &&
    Number.isInteger(ordinal) && (ordinal as number) >= 0 &&
    Number.isInteger(charStart) && (charStart as number) >= 0 &&
    Number.isInteger(charEnd) && (charEnd as number) > (charStart as number) &&
    data["rangeUnit"] === "utf16-code-unit" &&
    typeof content === "string" && content.length > 0 &&
    Array.isArray(embedding) && embedding.length === 4 &&
    embedding.every((component) => typeof component === "number" && Number.isFinite(component)) &&
    embedding.some((component) => component !== 0) &&
    embeddingModelRef !== null &&
    typeof embeddingModelRef === "object" &&
    typeof embeddingModelRef["id"] === "string" &&
    Number.isInteger(embeddingModelRef["revision"]) &&
    typeof embeddingModelRef["sha256"] === "string" &&
    /^[0-9a-f]{64}$/u.test(embeddingModelRef["sha256"] as string) &&
    indexVersion === KC08_STRUCTURED_MARKDOWN_INDEX_VERSION;
  if (!validShape) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-CHUNK",
      "DKP chunk event carries malformed or incomplete provenance",
    );
  }

  const sources = (await tx.execute(sql`
    SELECT p.sha256 AS package_sha256, p.state AS package_state,
           s.source_sha256, s.source_type, s.mount_state, s.content
    FROM dopaios_context_packages p
    JOIN dopaios_context_package_sources s
      ON s.project_id = p.project_id
     AND s.context_package_id = p.id
     AND s.context_package_revision = p.revision
    WHERE p.project_id = ${projectId}
      AND p.id = ${contextPackageId}
      AND p.revision = ${contextPackageRevision}
      AND s.source_id = ${sourceId}
      AND s.source_revision = ${sourceRevision}
  `)) as unknown as Array<{
    package_sha256: string;
    package_state: string;
    source_sha256: string;
    source_type: string;
    mount_state: string;
    content: string | null;
  }>;
  const source = sources[0];
  const sourceContentSha256 = source?.content === null || source?.content === undefined
    ? null
    : createHash("sha256").update(source.content, "utf8").digest("hex");
  const expectedChunkId = source
    ? `CHUNK-${payloadSha256({
        packageRef: {
          id: contextPackageId,
          revision: contextPackageRevision,
          sha256: source.package_sha256,
        },
        sourceRef: { id: sourceId, revision: sourceRevision, sha256: source.source_sha256 },
        ordinal,
        content,
      }).slice(0, 24)}`
    : null;
  const canonicalChunk = source?.content === null || source?.content === undefined
    ? undefined
    : structuredMarkdownChunks(source.content)[ordinal as number];
  if (
    !source ||
    source.package_state !== "approved" ||
    source.source_type !== "dkp" ||
    source.mount_state !== "mounted" ||
    source.content === null ||
    sourceContentSha256 !== source.source_sha256 ||
    (charEnd as number) > source.content.length ||
    source.content.slice(charStart as number, charEnd as number) !== content ||
    canonicalChunk?.charStart !== charStart ||
    canonicalChunk?.charEnd !== charEnd ||
    canonicalChunk?.content !== content ||
    expectedChunkId !== chunkId
  ) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-CHUNK",
      "DKP chunk does not match its approved package, mounted source bytes, UTF-16 range, and deterministic ID",
    );
  }
}

async function assertRetrievalHitProvenance(
  tx: Db | Tx,
  data: Record<string, unknown>,
  contextPackage: { id: string; revision: number; sha256: string },
  source: { id: string; revision: number; sha256: string },
  chunk: { id: string; charStart: number; charEnd: number; rangeUnit: string },
): Promise<void> {
  const embeddingModelRef = data["embeddingModelRef"];
  const validShape =
    typeof data["sessionId"] === "string" &&
    typeof contextPackage?.id === "string" &&
    Number.isInteger(contextPackage?.revision) &&
    typeof contextPackage?.sha256 === "string" &&
    typeof source?.id === "string" &&
    Number.isInteger(source?.revision) &&
    typeof source?.sha256 === "string" &&
    typeof chunk?.id === "string" &&
    Number.isInteger(chunk?.charStart) &&
    Number.isInteger(chunk?.charEnd) &&
    chunk?.rangeUnit === "utf16-code-unit" &&
    Number.isInteger(data["rank"]) &&
    (data["rank"] as number) > 0 &&
    typeof data["score"] === "number" &&
    Number.isFinite(data["score"]) &&
    data["policyDecision"] === "allow" &&
    embeddingModelRef !== null &&
    typeof embeddingModelRef === "object";
  if (!validShape) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-PROVENANCE",
      "Retrieval hit event carries malformed or incomplete provenance",
    );
  }
  const matches = (await tx.execute(sql`
    SELECT 1 AS matched
    FROM dopaios_retrieval_queries q
    JOIN dopaios_context_packages p
      ON p.id = q.context_package_id
     AND p.revision = q.context_package_revision
     AND p.sha256 = q.context_package_sha256
    JOIN dopaios_context_package_sources s
      ON s.project_id = q.project_id
     AND s.context_package_id = q.context_package_id
     AND s.context_package_revision = q.context_package_revision
     AND s.source_id = ${source.id}
     AND s.source_revision = ${source.revision}
     AND s.source_sha256 = ${source.sha256}
    JOIN dopaios_dkp_chunks c
      ON c.project_id = s.project_id
     AND c.context_package_id = s.context_package_id
     AND c.context_package_revision = s.context_package_revision
     AND c.source_id = s.source_id
     AND c.source_revision = s.source_revision
     AND c.chunk_id = ${chunk.id}
     AND c.index_version = ${data["indexVersion"]}
    WHERE q.id = ${data["queryId"]}
      AND q.session_id = ${data["sessionId"]}
      AND q.project_id = ${data["projectId"]}
      AND q.context_package_id = ${contextPackage.id}
      AND q.context_package_revision = ${contextPackage.revision}
      AND q.context_package_sha256 = ${contextPackage.sha256}
      AND q.method = ${data["method"]}
      AND q.index_version = ${data["indexVersion"]}
      AND q.embedding_model_ref = ${JSON.stringify(embeddingModelRef)}::jsonb
      AND q.policy_decision = 'allow'
      AND c.char_start = ${chunk.charStart}
      AND c.char_end = ${chunk.charEnd}
      AND c.range_unit = ${chunk.rangeUnit}
      AND c.content = ${data["excerpt"]}
      AND c.embedding_model_ref = ${JSON.stringify(embeddingModelRef)}::jsonb
  `)) as unknown as unknown[];
  if (matches.length !== 1) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-PROVENANCE",
      "Retrieval hit does not match its exact query, Context Package, source, and indexed chunk",
    );
  }
}

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
        // KC-04 (0515): provenance FS-002 — event trước KC-04 không mang
        // hai trường này nên projection giữ null, không suy ra [].
        sourceRefs: d["sourceRefs"] ?? null,
        storageRef: d["storageRef"] ?? null,
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
    case "ArtifactProjectScopeBound":
      await tx.insert(dopaiosArtifactProjectScopes).values({
        artifactId: d["artifactId"],
        artifactRevision: d["artifactRevision"],
        projectId: d["projectId"],
        scopeState: d["scopeState"],
        boundBy: d["boundBy"],
      });
      break;
    case "ContextPackageBuilt":
      assertContextPackageProjection(d);
      await tx.insert(dopaiosContextPackages).values({
        id: d["packageId"],
        revision: d["revision"],
        projectId: d["projectId"],
        workItemId: d["workItemId"],
        state: d["state"],
        sha256: d["sha256"],
        manifest: d["manifest"],
        maxBytes: d["maxBytes"],
        maxTokens: d["maxTokens"],
        totalBytes: d["totalBytes"],
        totalTokens: d["totalTokens"],
        approvedBy: "pending",
        approvalRef: {},
        createdBy: d["createdBy"],
        createdAt: event.time,
      });
      for (const source of d["sources"] as Array<Record<string, never>>) {
        await tx.insert(dopaiosContextPackageSources).values({
          contextPackageId: d["packageId"],
          contextPackageRevision: d["revision"],
          projectId: d["projectId"],
          sourceId: source["id"],
          sourceRevision: source["revision"],
          sourceSha256: source["sha256"],
          sourceType: source["type"],
          required: source["required"],
          priority: source["priority"],
          mountState: source["mountState"],
          omissionReason: source["omissionReason"],
          contentBytes: source["contentBytes"],
          tokenCount: source["tokenCount"],
          content: source["content"],
        });
      }
      break;
    case "ContextPackageApproved":
      await tx.execute(sql`
        UPDATE dopaios_context_packages
        SET state = 'approved',
            approved_by = ${d["approvedBy"]},
            approval_ref = ${JSON.stringify(d["approvalRef"])}::jsonb,
            manifest = jsonb_set(
              manifest,
              '{approval}',
              ${JSON.stringify({ ...(d["approvalRef"] as Record<string, unknown>), approvedBy: d["approvedBy"] })}::jsonb,
              true
            )
        WHERE id = ${d["packageId"]} AND revision = ${d["revision"]}
      `);
      break;
    case "ConnectorPolicyMaterialized": {
      const connector = d["connector"] as { id: string; version: string };
      const auth = d["auth"] as { type: string; credentialRef: Record<string, unknown> };
      await tx.insert(dopaiosConnectorPolicies).values({
        policyId: d["policyId"],
        policyRevision: d["policyRevision"],
        configuration: d["configuration"] as Record<string, unknown>,
        scopeLevel: d["scopeLevel"],
        precedence: d["precedence"] as string[],
        approverCapability: d["approverCapability"],
        effectiveAt: new Date(d["effectiveAt"] as string),
        invalidation: d["invalidation"] as Record<string, unknown>,
        connectorId: connector.id,
        connectorVersion: connector.version,
        projectId: d["projectId"],
        purpose: d["purpose"],
        action: d["action"],
        direction: d["direction"],
        authType: auth.type,
        credentialRef: auth.credentialRef,
        runtime: d["runtime"],
        environment: d["environment"],
        dataClasses: d["dataClasses"] as Array<{
          name: string;
          policyRef: Record<string, unknown>;
        }>,
        lifecyclePolicyRef: d["lifecyclePolicyRef"] as Record<string, unknown>,
        retentionPolicyRef: d["retentionPolicyRef"] as Record<string, unknown>,
        scopes: d["scopes"] as string[],
        rateLimit: d["rateLimit"] as Record<string, unknown>,
        timeoutMs: d["timeoutMs"],
        interruption: d["interruption"] as Record<string, unknown>,
        retry: d["retry"] as Record<string, unknown>,
        backoff: d["backoff"] as Record<string, unknown>,
        circuitBreaker: d["circuitBreaker"] as Record<string, unknown>,
        idempotency: d["idempotency"] as Record<string, unknown>,
        reconciliation: d["reconciliation"] as Record<string, unknown>,
        fallback: d["fallback"] as Record<string, unknown>,
        audit: d["audit"] as Record<string, unknown>,
        redaction: d["redaction"] as Record<string, unknown>,
        approvalRef: d["approvalRef"] as Record<string, unknown>,
        state: d["state"],
        sha256: d["sha256"],
        createdBy: d["createdBy"],
        createdAt: event.time,
      });
      if (typeof auth.credentialRef["rotationEpoch"] === "number") {
        await tx.insert(dopaiosConnectorCredentials).values({
          secretRef: auth.credentialRef["secretRef"] as string,
          rotationEpoch: auth.credentialRef["rotationEpoch"] as number,
          issuedAt: new Date(auth.credentialRef["issuedAt"] as string),
          expiresAt: new Date(auth.credentialRef["expiresAt"] as string),
          revokedAt: auth.credentialRef["revokedAt"]
            ? new Date(auth.credentialRef["revokedAt"] as string)
            : null,
          lastActorId: d["createdBy"],
        }).onConflictDoNothing();
      }
      break;
    }
    case "ConnectorCredentialRevoked":
      await tx
        .update(dopaiosConnectorCredentials)
        .set({ revokedAt: new Date(d["revokedAt"] as string), lastActorId: d["actorId"] })
        .where(sql`${dopaiosConnectorCredentials.secretRef} = ${d["secretRef"]}
          AND ${dopaiosConnectorCredentials.rotationEpoch} = ${d["rotationEpoch"]}`);
      break;
    case "ConnectorAuditRecorded":
      await tx.insert(dopaiosConnectorAuditEvents).values({
        id: d["auditId"],
        projectId: d["projectId"],
        actorId: d["actorId"],
        sessionId: d["sessionId"],
        connectorId: d["connectorId"],
        connectorVersion: d["connectorVersion"],
        purpose: d["purpose"],
        action: d["action"],
        direction: d["direction"],
        policyId: (d["policyId"] as string | null) ?? null,
        policyRevision: (d["policyRevision"] as number | null) ?? null,
        policySha256: (d["policySha256"] as string | null) ?? null,
        runtime: (d["runtime"] as string | null) ?? null,
        environment: (d["environment"] as string | null) ?? null,
        approvalRef: (d["approvalRef"] as Record<string, unknown> | null) ?? null,
        fallbackContextRef: (d["fallbackContextRef"] as Record<string, unknown> | null) ?? null,
        decision: d["decision"],
        reasonCode: d["reasonCode"],
        requestId: d["requestId"],
        requestSummary: d["requestSummary"] as Record<string, unknown>,
        responseSummary: (d["responseSummary"] as Record<string, unknown> | null) ?? null,
        retryClass: d["retryClass"],
        attempt: d["attempt"],
        createdAt: new Date(d["createdAt"] as string),
      });
      break;
    case "DkpChunkIndexed":
      await requirePinnedPgvectorProjection(tx);
      await assertDkpChunkProvenance(tx, d);
      await tx.insert(dopaiosDkpChunks).values({
        sourceId: d["sourceId"],
        sourceRevision: d["sourceRevision"],
        chunkId: d["chunkId"],
        projectId: d["projectId"],
        contextPackageId: d["contextPackageId"],
        contextPackageRevision: d["contextPackageRevision"],
        ordinal: d["ordinal"],
        charStart: d["charStart"],
        charEnd: d["charEnd"],
        rangeUnit: d["rangeUnit"],
        content: d["content"],
        embedding: d["embedding"],
        embeddingModelRef: d["embeddingModelRef"] as Record<string, unknown>,
        indexVersion: d["indexVersion"],
      });
      break;
    case "RetrievalQueryRecorded":
      await assertRetrievalQueryProvenance(tx, d);
      await tx.insert(dopaiosRetrievalQueries).values({
        id: d["queryId"],
        sessionId: d["sessionId"],
        projectId: d["projectId"],
        contextPackageId: d["contextPackageId"],
        contextPackageRevision: d["contextPackageRevision"],
        contextPackageSha256: d["contextPackageSha256"],
        querySha256: d["querySha256"],
        queryRedacted: d["queryRedacted"],
        method: d["method"],
        indexVersion: d["indexVersion"],
        embeddingModelRef: d["embeddingModelRef"] as Record<string, unknown>,
        policyDecision: d["policyDecision"],
        createdAt: new Date(d["createdAt"] as string),
      });
      break;
    case "RetrievalHitRecorded": {
      const contextPackage = d["contextPackage"] as {
        id: string;
        revision: number;
        sha256: string;
      };
      const source = d["source"] as { id: string; revision: number; sha256: string };
      const chunk = d["chunk"] as {
        id: string;
        charStart: number;
        charEnd: number;
        rangeUnit: string;
      };
      await assertRetrievalHitProvenance(tx, d, contextPackage, source, chunk);
      await tx.insert(dopaiosRetrievalHits).values({
        queryId: d["queryId"],
        rank: d["rank"],
        projectId: d["projectId"],
        contextPackageId: contextPackage.id,
        contextPackageRevision: contextPackage.revision,
        contextPackageSha256: contextPackage.sha256,
        sourceId: source.id,
        sourceRevision: source.revision,
        sourceSha256: source.sha256,
        chunkId: chunk.id,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        rangeUnit: chunk.rangeUnit,
        excerpt: d["excerpt"],
        method: d["method"],
        indexVersion: d["indexVersion"],
        embeddingModelRef: d["embeddingModelRef"] as Record<string, unknown>,
        score: d["score"],
        policyDecision: d["policyDecision"],
      });
      break;
    }
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
        contextPackageId: d["contextPackageId"] ?? null,
        contextPackageRevision: d["contextPackageRevision"] ?? null,
        contextPackageSha256: d["contextPackageSha256"] ?? null,
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
    case "AiSessionUsageRecorded": {
      await tx.insert(dopaiosSessionUsage).values({
        sessionId: d["sessionId"],
        seq: d["seq"],
        step: d["step"],
        model: d["model"],
        billingType: d["billingType"],
        inputTokens: d["inputTokens"],
        cachedInputTokens: d["cachedInputTokens"],
        outputTokens: d["outputTokens"],
        costUsdReported: (d["costUsdReported"] as string | null) ?? null,
        costUsdComputed: d["costUsdComputed"] as string,
        priceSource: d["priceSource"],
      });
      const reportedDelta = (d["costUsdReported"] as string | null) ?? "0";
      await tx
        .update(dopaiosAiSessions)
        .set({
          usageInputTokens: sql`${dopaiosAiSessions.usageInputTokens} + ${d["inputTokens"]}`,
          usageCachedInputTokens: sql`${dopaiosAiSessions.usageCachedInputTokens} + ${d["cachedInputTokens"]}`,
          usageOutputTokens: sql`${dopaiosAiSessions.usageOutputTokens} + ${d["outputTokens"]}`,
          usageCostUsdReported: sql`${dopaiosAiSessions.usageCostUsdReported} + ${reportedDelta}::numeric`,
          usageCostUsdComputed: sql`${dopaiosAiSessions.usageCostUsdComputed} + ${d["costUsdComputed"]}::numeric`,
        })
        .where(eq(dopaiosAiSessions.id, d["sessionId"]));
      break;
    }
    case "AiSessionBudgetWarned":
      await tx
        .update(dopaiosAiSessions)
        .set({ budgetState: sql`COALESCE(${dopaiosAiSessions.budgetState}, 'warned')` })
        .where(eq(dopaiosAiSessions.id, d["sessionId"]));
      break;
    case "AiSessionBudgetStopped":
      await tx
        .update(dopaiosAiSessions)
        .set({ budgetState: "stopped" })
        .where(eq(dopaiosAiSessions.id, d["sessionId"]));
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
        contextPackageId: d["contextPackageId"] ?? null,
        contextPackageRevision: d["contextPackageRevision"] ?? null,
        contextPackageSha256: d["contextPackageSha256"] ?? null,
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
        // KC-15: pin danh sách nguồn của phiên bản (0514).
        sourceRefs: d["sourceRefs"] ?? null,
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
        contextPackageId: (d["contextPackageRef"] as { id?: string } | null)?.id ?? null,
        contextPackageRevision:
          (d["contextPackageRef"] as { revision?: number } | null)?.revision ?? null,
        contextPackageSha256:
          (d["contextPackageRef"] as { sha256?: string } | null)?.sha256 ?? null,
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
    // ===== KC-15: đồ thị phụ thuộc dùng chung =====
    // Cạnh phụ thuộc là event (QD-1) — bảng cạnh dựng thuần từ log, replay
    // byte-identical; guard chu trình/trùng cạnh nằm ở tầng lệnh (graph-repo).
    case "WorkItemDependencyDeclared":
      await tx.insert(dopaiosWorkItemDependencies).values({
        workItemId: d["workItemId"],
        dependsOnWorkItemId: d["dependsOnWorkItemId"],
        runId: d["runId"],
        declaredBy: d["declaredBy"],
        basis: d["basis"] ?? null,
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
    // ===== KC-05: workspace song song theo Release =====
    case "WorkspaceProvisioned":
      await tx.insert(dopaiosWorkspaces).values({
        id: d["workspaceId"],
        releaseId: d["releaseId"],
        projectId: d["projectId"] ?? null,
        state: "PROVISIONED",
        relPath: d["relPath"],
        cacheRelPath: d["cacheRelPath"],
        port: d["port"],
        credentialRef: d["credentialRef"],
        baseRef: d["baseRef"],
      });
      break;
    // Tài nguyên theo (loại, giá trị): tái cấp sau khi release là UPDATE cùng
    // hàng — bất biến "một giá trị chỉ một chủ sống" do guard tầng lệnh đọc
    // projection trong cùng transaction SERIALIZABLE giữ; lịch sử ở event log.
    // KC-05 B7 (minor review lens 2): upsert CÓ ĐIỀU KIỆN — chỉ đè hàng đã
    // 'released'; event Reserved đè chủ đang 'reserved' (log bị bơm ngoài
    // đường lệnh) làm projector NỔ để lộ lệch, cả sống lẫn replay.
    case "WorkspaceResourceReserved": {
      const upserted = (await tx.execute(sql`
        INSERT INTO dopaios_workspace_resources (resource_type, value, workspace_id, release_id, state)
        VALUES (${d["resourceType"]}, ${d["value"]}, ${d["workspaceId"]}, ${d["releaseId"]}, 'reserved')
        ON CONFLICT (resource_type, value) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id, release_id = EXCLUDED.release_id, state = 'reserved'
          WHERE dopaios_workspace_resources.state = 'released'
        RETURNING value
      `)) as unknown as unknown[];
      if (upserted.length === 0) {
        throw new Error(
          `WorkspaceResourceReserved đè chủ đang 'reserved' của ${d["resourceType"]}=${d["value"]} — event log lệch bất biến`,
        );
      }
      break;
    }
    case "WorkspaceActivated":
      await tx
        .update(dopaiosWorkspaces)
        .set({ state: "ACTIVE", materialized: d["materialized"] })
        .where(eq(dopaiosWorkspaces.id, d["workspaceId"]));
      break;
    case "WorkspaceCloseStarted":
      await tx
        .update(dopaiosWorkspaces)
        .set({ state: "CLOSING", closeReason: d["reason"] })
        .where(eq(dopaiosWorkspaces.id, d["workspaceId"]));
      break;
    case "WorkspaceRetentionControlRecorded":
      await tx
        .update(dopaiosWorkspaces)
        .set({ retentionControl: d["control"] })
        .where(eq(dopaiosWorkspaces.id, d["workspaceId"]));
      break;
    case "WorkspacePurged":
      await tx
        .update(dopaiosWorkspaces)
        .set({ state: "PURGED", purgeReport: d["report"] })
        .where(eq(dopaiosWorkspaces.id, d["workspaceId"]));
      // KC-05 B7: purge thành công sau PURGE_BLOCKED đóng hành động khắc phục
      // của hồ sơ thất bại (FR-17 — trạng thái của corrective action).
      if (d["resolvesCorrectiveAction"]) {
        await tx.execute(sql`
          UPDATE dopaios_workspaces
          SET purge_failure = coalesce(purge_failure, '{}'::jsonb) || '{"correctiveActionState":"closed"}'::jsonb
          WHERE id = ${d["workspaceId"]}
        `);
      }
      break;
    // KC-05 B7 (major review lens 2 — ngõ cụt PROVISIONED): hủy cấp phát khi
    // vật chất hóa thất bại/không diễn ra; dùng chung nhãn PURGED (không có
    // gì trên đĩa để purge) với purge_report ghi aborted.
    case "WorkspaceAborted":
      await tx
        .update(dopaiosWorkspaces)
        .set({ state: "PURGED", purgeReport: d["report"] })
        .where(eq(dopaiosWorkspaces.id, d["workspaceId"]));
      break;
    // Lỗi purge: trạng thái chặn, KHÔNG release tài nguyên (FR-17/ADR-012);
    // hồ sơ thất bại mang hành động khắc phục owner–hạn–phạm vi còn sót.
    case "WorkspacePurgeFailed":
      await tx
        .update(dopaiosWorkspaces)
        .set({ state: "PURGE_BLOCKED", purgeFailure: d["failure"] })
        .where(eq(dopaiosWorkspaces.id, d["workspaceId"]));
      break;
    case "WorkspaceResourceReleased":
      await tx
        .update(dopaiosWorkspaceResources)
        .set({ state: "released" })
        .where(
          sql`${dopaiosWorkspaceResources.resourceType} = ${d["resourceType"]} AND ${dopaiosWorkspaceResources.value} = ${d["value"]}`,
        );
      break;
    // ===== KC-17 (0518/0519): cutover bootstrap→runtime (PRD Mục 6.1) =====
    // BootstrapStateWritten là event audit-only (đường ghi bootstrap hợp lệ
    // trước cutover) — đi qua default như các event audit khác.
    case "BootstrapWorkflowRegistered":
      await tx.insert(dopaiosBootstrapWorkflows).values({
        id: d["workflowId"],
        featureId: d["featureId"],
        state: "ACTIVE",
        disabledByRef: null,
      });
      break;
    // Chỉ executeCutover (Cutover Record `effective` hợp lệ) phát event này —
    // PRD d.318; record rolled-back/completed không bao giờ phát nó (C08).
    case "BootstrapWorkflowDisabled":
      await tx
        .update(dopaiosBootstrapWorkflows)
        .set({ state: "DISABLED", disabledByRef: d["byRecordRef"] })
        .where(eq(dopaiosBootstrapWorkflows.id, d["workflowId"]));
      break;
    // Rollback target của Plan: khôi phục bootstrap làm nguồn duy nhất —
    // chỉ nhánh rollback (Cutover Record `rolled-back`) phát event này.
    case "BootstrapWorkflowReactivated":
      await tx
        .update(dopaiosBootstrapWorkflows)
        .set({ state: "ACTIVE", disabledByRef: null })
        .where(eq(dopaiosBootstrapWorkflows.id, d["workflowId"]));
      break;
    case "CutoverReadinessSet":
      await tx.execute(sql`
        INSERT INTO dopaios_cutover_readiness (feature_id, flag, ready)
        VALUES (${d["featureId"]}, ${d["flag"]}, ${d["ready"]})
        ON CONFLICT (feature_id, flag) DO UPDATE SET ready = EXCLUDED.ready
      `);
      break;
    case "RuntimeActivationSnapshotCreated":
      await tx.insert(dopaiosRuntimeActivationSnapshots).values({
        id: d["snapshotId"],
        revision: d["revision"],
        sha256: d["sha256"],
        featureId: d["featureId"],
        planRef: d["planRef"],
        approvalRef: d["approvalRef"],
        authorityActor: d["authorityActor"],
        systemActor: d["systemActor"],
        activationKey: d["activationKey"],
        bootstrapWorkflowRef: d["bootstrapWorkflowRef"],
        bootstrapDisabled: d["bootstrapDisabled"],
        sourceStateResults: d["sourceStateResults"],
        runtimeWorkflowRef: d["runtimeWorkflowRef"],
        firstWorkItemRef: d["firstWorkItemRef"],
      });
      break;
    case "CutoverRecordAppended":
      await tx.insert(dopaiosCutoverRecords).values({
        id: d["recordId"],
        revision: d["revision"],
        sha256: d["sha256"],
        featureId: d["featureId"],
        state: d["state"],
        effectiveAt: d["effectiveAt"] ? new Date(d["effectiveAt"] as string) : null,
        authorityActor: d["authorityActor"],
        executionActor: d["executionActor"],
        approvalRecordRef: d["approvalRecordRef"],
        firstRuntimeWorkItemRef: d["firstRuntimeWorkItemRef"],
        runtimeActivationSnapshotRef: d["runtimeActivationSnapshotRef"],
        reconciliationRef: d["reconciliationRef"] ?? null,
      });
      break;
    case "CutoverReconciliationCreated":
      await tx.insert(dopaiosCutoverReconciliations).values({
        id: d["reconciliationId"],
        revision: d["revision"],
        sha256: d["sha256"],
        featureId: d["featureId"],
        rolledBackRecordRef: d["rolledBackRecordRef"],
        mappingArtifactRef: d["mappingArtifactRef"],
        mappings: d["mappings"],
        residuals: d["residuals"],
        // 0520 (B6): event trước B6 không mang executionActor — giữ null,
        // không suy ra giá trị.
        executionActor: d["executionActor"] ?? null,
        reviewEvidenceRef: null,
        closure: null,
      });
      break;
    case "ReconciliationReviewPinned":
      await tx
        .update(dopaiosCutoverReconciliations)
        .set({ reviewEvidenceRef: d["reviewEvidenceRef"] })
        .where(
          sql`${dopaiosCutoverReconciliations.id} = ${d["reconciliationId"]} AND ${dopaiosCutoverReconciliations.revision} = ${d["revision"]}`,
        );
      break;
    case "ReconciliationClosed":
      await tx
        .update(dopaiosCutoverReconciliations)
        .set({ closure: d["closure"] })
        .where(
          sql`${dopaiosCutoverReconciliations.id} = ${d["reconciliationId"]} AND ${dopaiosCutoverReconciliations.revision} = ${d["revision"]}`,
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
  dopaiosRetrievalHits,
  dopaiosRetrievalQueries,
  dopaiosAiSessions,
  dopaiosSessionArtifacts,
  dopaiosSessionUsage,
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
  dopaiosConnectorAuditEvents,
  dopaiosDkpChunks,
  dopaiosContextPackageSources,
  dopaiosContextPackages,
  dopaiosArtifactProjectScopes,
  dopaiosConnectorPolicies,
  dopaiosConnectorCredentials,
  dopaiosQualityContracts,
  dopaiosRunSteps,
  dopaiosWorkItemDependencies,
  dopaiosWorkspaces,
  dopaiosWorkspaceResources,
  dopaiosBootstrapWorkflows,
  dopaiosCutoverReadiness,
  dopaiosRuntimeActivationSnapshots,
  dopaiosCutoverRecords,
  dopaiosCutoverReconciliations,
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
