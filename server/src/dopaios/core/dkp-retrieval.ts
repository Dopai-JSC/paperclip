import { sql } from "drizzle-orm";
import {
  type CommandContext,
  type Db,
  CommandRejectedError,
  payloadSha256,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";
import { sha256Utf8 } from "./context-package.js";
import {
  KC08_STRUCTURED_MARKDOWN_INDEX_VERSION,
  structuredMarkdownChunks,
} from "./dkp-chunking.js";

type Json = Record<string, unknown>;
type ExactRef = { id: string; revision: number; sha256: string };
type Vector4 = [number, number, number, number];

export type FourDimensionalEmbedder = {
  modelRef: ExactRef;
  dimensions: 4;
  embed(content: string): Promise<Vector4>;
};

export type RetrievalProvenance = {
  queryId: string;
  sessionId: string;
  projectId: string;
  contextPackage: ExactRef;
  source: ExactRef;
  chunk: { id: string; charStart: number; charEnd: number; rangeUnit: "utf16-code-unit" };
  excerpt: string;
  method: "rrf-lexical-vector";
  indexVersion: string;
  embeddingModelRef: ExactRef;
  score: number;
  policyDecision: "allow";
};

function assertEmbedding(value: number[], embedder: FourDimensionalEmbedder): asserts value is Vector4 {
  if (
    embedder.dimensions !== 4 ||
    value.length !== 4 ||
    value.some((component) => !Number.isFinite(component)) ||
    value.every((component) => component === 0)
  ) {
    throw new CommandRejectedError("ERR-RETRIEVAL-EMBEDDING", "Pinned embedding fixture must return four finite, non-zero dimensions");
  }
}

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return ((await ctx.tx.execute(query)) as unknown as T[])[0];
}

async function requirePgvector(ctx: CommandContext): Promise<void> {
  const capability = await one<{ available: boolean; version: string | null }>(
    ctx,
    sql`SELECT available, version FROM dopaios_kc08_capabilities WHERE name = 'pgvector'`,
  );
  if (!capability?.available || capability.version !== "0.8.6") {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-PGVECTOR",
      "KC-08 retrieval requires the pinned pgvector 0.8.6 capability",
    );
  }
}

async function requireRunningRetrievalSession(
  ctx: CommandContext,
  input: { sessionId: string; projectId: string; packageRef: ExactRef },
): Promise<void> {
  const session = await one<{
    state: string;
    project_id: string | null;
    context_package_id: string | null;
    context_package_revision: number | null;
    context_package_sha256: string | null;
  }>(
    ctx,
    sql`SELECT s.state, w.project_id,
               s.context_package_id, s.context_package_revision, s.context_package_sha256
        FROM dopaios_ai_sessions s
        JOIN dopaios_work_items w ON w.id = s.work_item_id
        WHERE s.id = ${input.sessionId}`,
  );
  if (!session || session.state !== "RUNNING") {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-SESSION",
      "Retrieval requires an existing RUNNING AI session",
    );
  }
  if (session.project_id !== input.projectId) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-CONTEXT",
      "Retrieval session work item is outside the requested Project",
    );
  }
  if (
    session.context_package_id !== input.packageRef.id ||
    session.context_package_revision !== input.packageRef.revision ||
    session.context_package_sha256 !== input.packageRef.sha256
  ) {
    throw new CommandRejectedError(
      "ERR-RETRIEVAL-SESSION",
      "Retrieval Context Package must equal the RUNNING session's exact pin",
    );
  }
}

type MountedSource = {
  content: string | null;
  source_sha256: string;
  source_type: string;
  artifact_state: string | null;
  impact_status: string | null;
  artifact_sha256: string | null;
  scope_state: string | null;
};

async function requireMountedSource(
  ctx: CommandContext,
  input: { projectId: string; packageRef: ExactRef; sourceRef: ExactRef },
): Promise<MountedSource> {
  const context = await one<{ state: string; sha256: string; project_id: string }>(
    ctx,
    sql`SELECT state, sha256, project_id FROM dopaios_context_packages
        WHERE id = ${input.packageRef.id} AND revision = ${input.packageRef.revision}`,
  );
  if (
    !context ||
    context.state !== "approved" ||
    context.sha256 !== input.packageRef.sha256 ||
    context.project_id !== input.projectId
  ) {
    throw new CommandRejectedError("ERR-RETRIEVAL-CONTEXT", "Retrieval context package pin is stale, unapproved, or out of Project scope");
  }
  const packageLedger = await one<{
    artifact_state: string;
    impact_status: string;
    sha256: string;
    artifact_type: string | null;
  }>(
    ctx,
    sql`SELECT artifact_state, impact_status, sha256, artifact_type FROM dopaios_artifacts
        WHERE id = ${input.packageRef.id} AND revision = ${input.packageRef.revision}`,
  );
  if (
    !packageLedger ||
    packageLedger.artifact_state !== "approved" ||
    (packageLedger.impact_status !== "clear" && packageLedger.impact_status !== "reaffirmed") ||
    packageLedger.sha256 !== input.packageRef.sha256 ||
    packageLedger.artifact_type !== "context-package"
  ) {
    throw new CommandRejectedError("ERR-RETRIEVAL-CONTEXT", "Current context package ledger state blocks retrieval");
  }
  const source = await one<MountedSource>(
    ctx,
    sql`SELECT s.content, s.source_sha256, s.source_type,
               a.artifact_state, a.impact_status, a.sha256 AS artifact_sha256,
               scope.scope_state
        FROM dopaios_context_package_sources s
        LEFT JOIN dopaios_artifacts a
          ON a.id = s.source_id AND a.revision = s.source_revision
        LEFT JOIN dopaios_artifact_project_scopes scope
          ON scope.artifact_id = s.source_id AND scope.artifact_revision = s.source_revision
         AND scope.project_id = ${input.projectId}
        WHERE s.context_package_id = ${input.packageRef.id}
          AND s.context_package_revision = ${input.packageRef.revision}
          AND s.project_id = ${input.projectId}
          AND s.source_id = ${input.sourceRef.id}
          AND s.source_revision = ${input.sourceRef.revision}
          AND s.mount_state = 'mounted'`,
  );
  if (!source || source.source_sha256 !== input.sourceRef.sha256 || source.artifact_sha256 !== input.sourceRef.sha256) {
    throw new CommandRejectedError("ERR-RETRIEVAL-SOURCE", "Source is unmounted, missing, stale, or hash-mismatched");
  }
  if (source.impact_status === "impact-pending") {
    throw new CommandRejectedError("ERR-RETRIEVAL-IMPACT", "Current source impact state blocks retrieval");
  }
  if (
    source.artifact_state !== "approved" ||
    (source.impact_status !== "clear" && source.impact_status !== "reaffirmed") ||
    source.scope_state !== "active" ||
    source.content === null ||
    sha256Utf8(source.content) !== input.sourceRef.sha256
  ) {
    throw new CommandRejectedError("ERR-RETRIEVAL-SOURCE", "Source is unapproved, retired, out of scope, or missing verified content");
  }
  return source;
}

export async function indexDkpSource(
  db: Db,
  commandId: string,
  input: {
    projectId: string;
    packageRef: ExactRef;
    sourceRef: ExactRef;
    indexVersion: string;
    embedder: FourDimensionalEmbedder;
  },
): Promise<{ chunkCount: number; indexVersion: string }> {
  const commandPayload = {
    projectId: input.projectId,
    packageRef: input.packageRef,
    sourceRef: input.sourceRef,
    indexVersion: input.indexVersion,
    embeddingModelRef: input.embedder.modelRef,
    dimensions: input.embedder.dimensions,
  };
  const result = await executeAuditedCommand(db, {
    commandId,
    payload: commandPayload as unknown as Json,
    handler: async (ctx) => {
      await requirePgvector(ctx);
      const source = await requireMountedSource(ctx, input);
      if (source.source_type !== "dkp") {
        throw new CommandRejectedError("ERR-RETRIEVAL-SOURCE", "Only mounted DKP sources can be indexed by the KC-08 retrieval path");
      }
      if (input.indexVersion !== KC08_STRUCTURED_MARKDOWN_INDEX_VERSION) {
        throw new CommandRejectedError(
          "ERR-RETRIEVAL-INDEX-VERSION",
          `Unsupported DKP index version ${input.indexVersion}`,
        );
      }
      const chunks = structuredMarkdownChunks(source.content!);
      if (chunks.length === 0) {
        throw new CommandRejectedError("ERR-RETRIEVAL-CHUNKS", "Structured Markdown source produced no chunks");
      }
      for (const chunk of chunks) {
        const embedding = await input.embedder.embed(chunk.content);
        assertEmbedding(embedding, input.embedder);
        const chunkId = `CHUNK-${payloadSha256({
          packageRef: input.packageRef,
          sourceRef: input.sourceRef,
          ordinal: chunk.ordinal,
          content: chunk.content,
        }).slice(0, 24)}`;
        await ctx.emit({
          streamName: `dopaiosDkpIndex-${input.packageRef.id}-${input.packageRef.revision}-${input.sourceRef.id}`,
          type: "DkpChunkIndexed",
          data: {
            projectId: input.projectId,
            contextPackageId: input.packageRef.id,
            contextPackageRevision: input.packageRef.revision,
            sourceId: input.sourceRef.id,
            sourceRevision: input.sourceRef.revision,
            chunkId,
            ordinal: chunk.ordinal,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            rangeUnit: "utf16-code-unit",
            content: chunk.content,
            embedding,
            embeddingModelRef: input.embedder.modelRef,
            indexVersion: input.indexVersion,
          },
          metadata: { commandId, audit: true },
        });
      }
      return { chunkCount: chunks.length, indexVersion: input.indexVersion };
    },
  });
  return result as unknown as { chunkCount: number; indexVersion: string };
}

type RankedChunk = {
  source_id: string;
  source_revision: number;
  source_sha256: string;
  chunk_id: string;
  char_start: number;
  char_end: number;
  content: string;
};

function redactedQuerySummary(query: string): string {
  return `[query:${Buffer.byteLength(query, "utf8")} bytes sha256:${sha256Utf8(query).slice(0, 12)}]`;
}

export async function retrieveDkp(
  db: Db,
  commandId: string,
  input: {
    queryId: string;
    sessionId: string;
    projectId: string;
    packageRef: ExactRef;
    query: string;
    limit: number;
    indexVersion: string;
    embedder: FourDimensionalEmbedder;
  },
): Promise<{ hits: Array<{ excerpt: string; provenance: RetrievalProvenance }> }> {
  const commandPayload = {
    queryId: input.queryId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    packageRef: input.packageRef,
    querySha256: sha256Utf8(input.query),
    limit: input.limit,
    indexVersion: input.indexVersion,
    embeddingModelRef: input.embedder.modelRef,
    dimensions: input.embedder.dimensions,
  };
  const result = await executeAuditedCommand(db, {
    commandId,
    payload: commandPayload as unknown as Json,
    handler: async (ctx) => {
      await requirePgvector(ctx);
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50 || input.query.trim().length === 0) {
        throw new CommandRejectedError("ERR-RETRIEVAL-QUERY", "Query and result limit are invalid");
      }
      if (input.indexVersion !== KC08_STRUCTURED_MARKDOWN_INDEX_VERSION) {
        throw new CommandRejectedError(
          "ERR-RETRIEVAL-INDEX-VERSION",
          `Unsupported DKP index version ${input.indexVersion}`,
        );
      }
      await requireRunningRetrievalSession(ctx, input);
      const mounted = (await ctx.tx.execute(sql`
        SELECT s.source_id, s.source_revision, s.source_sha256,
               package_artifact.artifact_state AS package_artifact_state,
               package_artifact.impact_status AS package_impact_status,
               package_artifact.sha256 AS package_artifact_sha256,
               package_artifact.artifact_type AS package_artifact_type,
               a.artifact_state, a.impact_status, a.sha256 AS artifact_sha256,
               scope.scope_state
        FROM dopaios_context_packages p
        JOIN dopaios_context_package_sources s
          ON s.context_package_id = p.id AND s.context_package_revision = p.revision
        LEFT JOIN dopaios_artifacts a
          ON a.id = s.source_id AND a.revision = s.source_revision
        LEFT JOIN dopaios_artifacts package_artifact
          ON package_artifact.id = p.id AND package_artifact.revision = p.revision
        LEFT JOIN dopaios_artifact_project_scopes scope
          ON scope.artifact_id = s.source_id AND scope.artifact_revision = s.source_revision
         AND scope.project_id = ${input.projectId}
        WHERE p.id = ${input.packageRef.id} AND p.revision = ${input.packageRef.revision}
          AND p.sha256 = ${input.packageRef.sha256} AND p.state = 'approved'
          AND p.project_id = ${input.projectId} AND s.mount_state = 'mounted'
      `)) as unknown as Array<{
        source_id: string;
        source_revision: number;
        source_sha256: string;
        package_artifact_state: string | null;
        package_impact_status: string | null;
        package_artifact_sha256: string | null;
        package_artifact_type: string | null;
        artifact_state: string | null;
        impact_status: string | null;
        artifact_sha256: string | null;
        scope_state: string | null;
      }>;
      let denied: { code: string; decision: string } | null = null;
      if (mounted.length === 0) denied = { code: "ERR-RETRIEVAL-CONTEXT", decision: "deny-context-pin" };
      else if (mounted.some((source) => source.package_impact_status === "impact-pending")) {
        denied = { code: "ERR-RETRIEVAL-IMPACT", decision: "deny-current-impact" };
      } else if (
        mounted.some(
          (source) =>
            source.package_artifact_state !== "approved" ||
            (source.package_impact_status !== "clear" && source.package_impact_status !== "reaffirmed") ||
            source.package_artifact_sha256 !== input.packageRef.sha256 ||
            source.package_artifact_type !== "context-package",
        )
      ) {
        denied = { code: "ERR-RETRIEVAL-CONTEXT", decision: "deny-current-context-policy" };
      } else if (mounted.some((source) => source.impact_status === "impact-pending")) {
        denied = { code: "ERR-RETRIEVAL-IMPACT", decision: "deny-current-impact" };
      } else if (
        mounted.some(
          (source) =>
            source.artifact_state !== "approved" ||
            (source.impact_status !== "clear" && source.impact_status !== "reaffirmed") ||
            source.artifact_sha256 !== source.source_sha256 ||
            source.scope_state !== "active",
        )
      ) {
        denied = { code: "ERR-RETRIEVAL-SOURCE", decision: "deny-current-source-policy" };
      }
      if (!denied) {
        const indexed = await one<{ n: number }>(
          ctx,
          sql`SELECT count(*)::int AS n FROM dopaios_dkp_chunks
              WHERE project_id = ${input.projectId}
                AND context_package_id = ${input.packageRef.id}
                AND context_package_revision = ${input.packageRef.revision}
                AND index_version = ${input.indexVersion}
                AND embedding_model_ref = ${JSON.stringify(input.embedder.modelRef)}::jsonb`,
        );
        if (Number(indexed?.n ?? 0) === 0) {
          denied = { code: "ERR-RETRIEVAL-INDEX", decision: "deny-index-missing" };
        }
      }
      const createdAt = new Date().toISOString();
      await ctx.emit({
        streamName: `dopaiosRetrieval-${input.queryId}`,
        type: "RetrievalQueryRecorded",
        data: {
          queryId: input.queryId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          contextPackageId: input.packageRef.id,
          contextPackageRevision: input.packageRef.revision,
          contextPackageSha256: input.packageRef.sha256,
          querySha256: sha256Utf8(input.query),
          queryRedacted: redactedQuerySummary(input.query),
          method: "rrf-lexical-vector",
          indexVersion: input.indexVersion,
          embeddingModelRef: input.embedder.modelRef,
          policyDecision: denied?.decision ?? "allow",
          createdAt,
        },
        metadata: { commandId, audit: true },
        expectedVersion: -1,
      });
      if (denied) return { denied };

      const queryEmbedding = await input.embedder.embed(input.query);
      assertEmbedding(queryEmbedding, input.embedder);
      const vectorLiteral = `[${queryEmbedding.join(",")}]`;
      const lexical = (await ctx.tx.execute(sql`
        SELECT c.source_id, c.source_revision, s.source_sha256, c.chunk_id,
               c.char_start, c.char_end, c.content,
               ts_rank_cd(c.search_vector, plainto_tsquery('simple', ${input.query})) AS lexical_score
        FROM dopaios_dkp_chunks c
        JOIN dopaios_context_package_sources s
          ON s.context_package_id = c.context_package_id
         AND s.context_package_revision = c.context_package_revision
         AND s.source_id = c.source_id AND s.source_revision = c.source_revision
        WHERE c.project_id = ${input.projectId}
          AND c.context_package_id = ${input.packageRef.id}
          AND c.context_package_revision = ${input.packageRef.revision}
          AND c.index_version = ${input.indexVersion}
          AND c.embedding_model_ref = ${JSON.stringify(input.embedder.modelRef)}::jsonb
          AND c.search_vector @@ plainto_tsquery('simple', ${input.query})
        ORDER BY lexical_score DESC, c.source_id, c.chunk_id
        LIMIT 50
      `)) as unknown as RankedChunk[];
      const vector = (await ctx.tx.execute(sql`
        SELECT c.source_id, c.source_revision, s.source_sha256, c.chunk_id,
               c.char_start, c.char_end, c.content,
               1 - (c.embedding <=> ${vectorLiteral}::vector) AS vector_score
        FROM dopaios_dkp_chunks c
        JOIN dopaios_context_package_sources s
          ON s.context_package_id = c.context_package_id
         AND s.context_package_revision = c.context_package_revision
         AND s.source_id = c.source_id AND s.source_revision = c.source_revision
        WHERE c.project_id = ${input.projectId}
          AND c.context_package_id = ${input.packageRef.id}
          AND c.context_package_revision = ${input.packageRef.revision}
          AND c.index_version = ${input.indexVersion}
          AND c.embedding_model_ref = ${JSON.stringify(input.embedder.modelRef)}::jsonb
        ORDER BY vector_score DESC, c.source_id, c.chunk_id
        LIMIT 50
      `)) as unknown as RankedChunk[];
      const fused = new Map<string, { row: RankedChunk; score: number }>();
      for (const [rank, row] of lexical.entries()) {
        fused.set(row.chunk_id, { row, score: 1 / (60 + rank + 1) });
      }
      for (const [rank, row] of vector.entries()) {
        const prior = fused.get(row.chunk_id);
        fused.set(row.chunk_id, { row, score: (prior?.score ?? 0) + 1 / (60 + rank + 1) });
      }
      const ranked = [...fused.values()]
        .sort((left, right) =>
          right.score - left.score ||
          left.row.source_id.localeCompare(right.row.source_id) ||
          left.row.chunk_id.localeCompare(right.row.chunk_id),
        )
        .slice(0, input.limit);
      const hits: Array<{ excerpt: string; provenance: RetrievalProvenance }> = [];
      for (const [rank, item] of ranked.entries()) {
        const provenance: RetrievalProvenance = {
          queryId: input.queryId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          contextPackage: input.packageRef,
          source: {
            id: item.row.source_id,
            revision: item.row.source_revision,
            sha256: item.row.source_sha256,
          },
          chunk: {
            id: item.row.chunk_id,
            charStart: item.row.char_start,
            charEnd: item.row.char_end,
            rangeUnit: "utf16-code-unit",
          },
          excerpt: item.row.content,
          method: "rrf-lexical-vector",
          indexVersion: input.indexVersion,
          embeddingModelRef: input.embedder.modelRef,
          score: item.score,
          policyDecision: "allow",
        };
        await ctx.emit({
          streamName: `dopaiosRetrieval-${input.queryId}`,
          type: "RetrievalHitRecorded",
          data: { ...provenance, rank: rank + 1 },
          metadata: { commandId, audit: true },
        });
        hits.push({ excerpt: item.row.content, provenance });
      }
      return { hits };
    },
  });
  const denied = result["denied"] as { code: string; decision: string } | undefined;
  if (denied) {
    throw new CommandRejectedError(denied.code, `Retrieval denied by ${denied.decision}`);
  }
  return result as unknown as { hits: Array<{ excerpt: string; provenance: RetrievalProvenance }> };
}
