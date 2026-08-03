import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  executeCommand,
  payloadSha256,
  projectEvent,
  replayProjections,
  snapshotProjections,
} from "../dopaios/event-store.js";
import { markArtifactImpact, registerApprovedArtifact } from "../dopaios/commands.js";
import { startAiSession } from "../dopaios/sessions.js";
import {
  approveContextPackage,
  bindArtifactProjectScope,
  buildContextPackage,
  sha256Utf8,
  type TokenCounter,
} from "../dopaios/context-package.js";
import {
  indexDkpSource,
  retrieveDkp,
  type FourDimensionalEmbedder,
} from "../dopaios/dkp-retrieval.js";
import { startKc08VectorTestDatabase } from "./helpers/dopaios-kc08-postgres.js";

const vectorBaseUrl = process.env.DOPAIOS_KC08_DATABASE_URL;
const describeVector = vectorBaseUrl ? describe : describe.skip;
const tokenCounter: TokenCounter = {
  id: "words-v1",
  count: (text) => text.trim().split(/\s+/u).length,
};
const embeddingModelRef = { id: "fixture-embedder-4d", revision: 1, sha256: "e".repeat(64) };
const embedder: FourDimensionalEmbedder = {
  modelRef: embeddingModelRef,
  dimensions: 4,
  embed: async (text) => {
    const normalized = text.toLowerCase();
    if (normalized.includes("renewal") || normalized.includes("webhook")) return [1, 0.1, 0.1, 0.1];
    if (normalized.includes("invoice") || normalized.includes("billing")) return [0.8, 0.4, 0.1, 0.1];
    if (normalized.includes("warehouse") || normalized.includes("logistics")) return [0.1, 0.1, 1, 0.1];
    return [0.1, 0.1, 0.1, 1];
  },
};

describeVector("dopaios KC-08 scoped hybrid DKP retrieval", () => {
  let fixture: Awaited<ReturnType<typeof startKc08VectorTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let seq = 0;
  const cmd = (label: string) => `KC08-RET-${label}-${(seq += 1)}`;
  const projectId = "PROJECT-KC08-RETRIEVAL";
  const workItemId = "WI-KC08-RETRIEVAL";
  const sessionId = "SESSION-KC08-RETRIEVAL";
  const dkpId = "DKP-KC08-HYBRID";
  let contextPackageSha256 = "";
  let alternateContextPackageRef!: { id: string; revision: number; sha256: string };
  const dkpContent = [
    "# Payments",
    "Renewal webhook events carry the subscription object and tenant key.",
    "",
    "## Billing retry",
    "A failed invoice enters the bounded billing retry queue.",
    "",
    "# Logistics",
    "Warehouse dispatch uses a separate logistics reconciliation feed.",
  ].join("\n");

  beforeAll(async () => {
    fixture = await startKc08VectorTestDatabase(vectorBaseUrl!);
    db = createDb(fixture.connectionString);
    await executeCommand(db, {
      commandId: cmd("base"),
      payload: { projectId, workItemId },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosProject-${projectId}`,
          type: "ProjectShellCreated",
          data: {
            projectId,
            templateRef: { id: "PROJECT-TEMPLATE", revision: 1, sha256: "a".repeat(64) },
            orchestrator: "ORCH-KC08",
            createdBy: "ORCH-KC08",
          },
        });
        await ctx.emit({
          streamName: `dopaiosProject-${projectId}`,
          type: "ProjectEnteredP0",
          data: { projectId },
        });
        await ctx.emit({
          streamName: `dopaiosWorkItem-${workItemId}`,
          type: "WorkItemCreated",
          data: { workItemId, projectId, role: "AI-Build", state: "ACCEPTED" },
        });
        return {};
      },
    });
    for (const artifact of [
      { id: dkpId, type: "dkp", content: dkpContent },
      { id: "APR-KC08-RETRIEVAL", type: "approval-record", content: "retrieval package approval" },
    ]) {
      await registerApprovedArtifact(db, cmd(`artifact-${artifact.id}`), {
        artifactId: artifact.id,
        revision: 1,
        sha256: sha256Utf8(artifact.content),
        artifactType: artifact.type,
        storageRef: `fixture://${artifact.id}`,
      });
      await bindArtifactProjectScope(db, cmd(`scope-${artifact.id}`), {
        artifactId: artifact.id,
        revision: 1,
        projectId,
        boundBy: "ORCH-KC08",
      });
    }
    const built = await buildContextPackage(db, cmd("context"), {
      packageId: "CTX-KC08-RETRIEVAL",
      projectId,
      workItemId,
      createdBy: "AI-LEAD-KC08",
      caps: { maxBytes: 10_000, maxTokens: 1_000 },
      tokenCounter,
      sources: [
        {
          id: dkpId,
          revision: 1,
          sha256: sha256Utf8(dkpContent),
          type: "dkp",
          content: dkpContent,
          required: true,
        },
      ],
    });
    contextPackageSha256 = built.sha256;
    await registerApprovedArtifact(db, cmd("context-ledger"), {
      artifactId: built.packageId,
      revision: built.revision,
      sha256: built.sha256,
      artifactType: "context-package",
      storageRef: `db://dopaios_context_packages/${built.packageId}/${built.revision}`,
    });
    await approveContextPackage(db, cmd("approve-context"), {
      packageRef: { id: built.packageId, revision: built.revision, sha256: built.sha256 },
      approvalRef: {
        id: "APR-KC08-RETRIEVAL",
        revision: 1,
        sha256: sha256Utf8("retrieval package approval"),
      },
      approvedBy: "ORCH-KC08",
    });
    await indexDkpSource(db, cmd("index"), {
      projectId,
      packageRef: { id: built.packageId, revision: built.revision, sha256: built.sha256 },
      sourceRef: { id: dkpId, revision: 1, sha256: sha256Utf8(dkpContent) },
      indexVersion: "kc08-structured-markdown-v1",
      embedder,
    });
    const alternate = await buildContextPackage(db, cmd("context-alternate"), {
      packageId: "CTX-KC08-RETRIEVAL-ALTERNATE",
      projectId,
      workItemId,
      createdBy: "AI-LEAD-KC08",
      caps: { maxBytes: 10_000, maxTokens: 1_000 },
      tokenCounter,
      sources: [
        {
          id: dkpId,
          revision: 1,
          sha256: sha256Utf8(dkpContent),
          type: "dkp",
          content: dkpContent,
          required: true,
        },
      ],
    });
    alternateContextPackageRef = {
      id: alternate.packageId,
      revision: alternate.revision,
      sha256: alternate.sha256,
    };
    await registerApprovedArtifact(db, cmd("context-alternate-ledger"), {
      artifactId: alternate.packageId,
      revision: alternate.revision,
      sha256: alternate.sha256,
      artifactType: "context-package",
      storageRef: `db://dopaios_context_packages/${alternate.packageId}/${alternate.revision}`,
    });
    await approveContextPackage(db, cmd("approve-context-alternate"), {
      packageRef: alternateContextPackageRef,
      approvalRef: {
        id: "APR-KC08-RETRIEVAL",
        revision: 1,
        sha256: sha256Utf8("retrieval package approval"),
      },
      approvedBy: "ORCH-KC08",
    });
    await indexDkpSource(db, cmd("index-alternate"), {
      projectId,
      packageRef: alternateContextPackageRef,
      sourceRef: { id: dkpId, revision: 1, sha256: sha256Utf8(dkpContent) },
      indexVersion: "kc08-structured-markdown-v1",
      embedder,
    });
    await startAiSession(db, cmd("session"), {
      sessionId,
      workItemId,
      agentId: "AI-LEAD-KC08",
      engine: "fixture-retrieval",
      contextPackageRef: {
        id: "CTX-KC08-RETRIEVAL",
        revision: 1,
        sha256: contextPackageSha256,
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await db.$client.end();
    await fixture?.cleanup();
  });

  it("runs exact pgvector plus GIN lexical scans, fuses deterministically, and stores full provenance", async () => {
    const result = await retrieveDkp(db, cmd("query"), {
      queryId: "QUERY-KC08-RENEWAL",
      sessionId,
      projectId,
      packageRef: { id: "CTX-KC08-RETRIEVAL", revision: 1, sha256: contextPackageSha256 },
      query: "renewal webhook",
      limit: 3,
      indexVersion: "kc08-structured-markdown-v1",
      embedder,
    });
    expect(result.hits[0]?.excerpt).toContain("Renewal webhook");
    expect(result.hits[0]?.provenance).toMatchObject({
      queryId: "QUERY-KC08-RENEWAL",
      sessionId,
      projectId,
      contextPackage: { id: "CTX-KC08-RETRIEVAL", revision: 1, sha256: contextPackageSha256 },
      source: { id: dkpId, revision: 1, sha256: sha256Utf8(dkpContent) },
      method: "rrf-lexical-vector",
      indexVersion: "kc08-structured-markdown-v1",
      embeddingModelRef,
      policyDecision: "allow",
      chunk: { rangeUnit: "utf16-code-unit" },
    });
    expect(result.hits[0]?.provenance.chunk.charEnd).toBeGreaterThan(
      result.hits[0]?.provenance.chunk.charStart ?? 0,
    );
    expect(result.hits.map((hit) => hit.provenance.score)).toEqual(
      [...result.hits.map((hit) => hit.provenance.score)].sort((a, b) => b - a),
    );
    const capability = await db.execute(sql`
      SELECT available, version, detail FROM dopaios_kc08_capabilities WHERE name = 'pgvector'
    `);
    expect(capability).toEqual([
      { available: true, version: "0.8.6", detail: "exact-scan vector(4) enabled" },
    ]);
    const rows = await db.execute(sql`
      SELECT context_package_sha256, source_sha256, char_start, char_end, range_unit, excerpt, method, index_version,
             embedding_model_ref, score, policy_decision
      FROM dopaios_retrieval_hits WHERE query_id = 'QUERY-KC08-RENEWAL' ORDER BY rank
    `);
    expect(rows).toHaveLength(result.hits.length);
    expect(rows).toContainEqual(expect.objectContaining({ context_package_sha256: contextPackageSha256 }));
  });

  it("rejects an approved same-Project package that is not the RUNNING session pin before embedding", async () => {
    let embedCalls = 0;
    const observedEmbedder: FourDimensionalEmbedder = {
      ...embedder,
      embed: async (text) => {
        embedCalls += 1;
        return embedder.embed(text);
      },
    };
    await expect(retrieveDkp(db, cmd("alternate-session-pin"), {
      queryId: "QUERY-KC08-ALTERNATE-SESSION-PIN",
      sessionId,
      projectId,
      packageRef: alternateContextPackageRef,
      query: "renewal webhook",
      limit: 3,
      indexVersion: "kc08-structured-markdown-v1",
      embedder: observedEmbedder,
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-SESSION" });
    expect(embedCalls).toBe(0);
    expect(await db.execute(sql`
      SELECT id FROM dopaios_retrieval_queries WHERE id = 'QUERY-KC08-ALTERNATE-SESSION-PIN'
    `)).toEqual([]);
  });

  it("rejects a forged query event and direct row that pair a session with another same-Project package", async () => {
    const queryData = {
      queryId: "QUERY-KC08-FORGED-SESSION-PACKAGE",
      sessionId,
      projectId,
      contextPackageId: alternateContextPackageRef.id,
      contextPackageRevision: alternateContextPackageRef.revision,
      contextPackageSha256: alternateContextPackageRef.sha256,
      querySha256: sha256Utf8("renewal webhook"),
      queryRedacted: "[query:15 bytes]",
      method: "rrf-lexical-vector",
      indexVersion: "kc08-structured-markdown-v1",
      embeddingModelRef,
      policyDecision: "allow",
      createdAt: "2026-08-03T00:00:00.000Z",
    };
    await expect(db.transaction(async (tx) => {
      await projectEvent(tx, {
        id: "KC08-FORGED-SESSION-PACKAGE-EVENT",
        streamName: "dopaiosRetrieval-QUERY-KC08-FORGED-SESSION-PACKAGE",
        type: "RetrievalQueryRecorded",
        position: 999,
        globalPosition: 999,
        time: new Date("2026-08-03T00:00:00.000Z"),
        data: queryData,
        metadata: { commandId: "KC08-FORGED-SESSION-PACKAGE" },
      });
      throw new Error("PROJECTOR_ACCEPTED_FORGED_SESSION_PACKAGE_QUERY");
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-SESSION" });

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO dopaios_retrieval_queries (
          id, session_id, project_id, context_package_id, context_package_revision,
          context_package_sha256, query_sha256, query_redacted, method,
          index_version, embedding_model_ref, policy_decision, created_at
        ) VALUES (
          'QUERY-KC08-FORGED-SESSION-PACKAGE-DIRECT', ${sessionId}, ${projectId},
          ${alternateContextPackageRef.id}, ${alternateContextPackageRef.revision},
          ${alternateContextPackageRef.sha256}, ${sha256Utf8("renewal webhook")},
          '[redacted]', 'rrf-lexical-vector', 'kc08-structured-markdown-v1',
          ${JSON.stringify(embeddingModelRef)}::jsonb, 'allow', now()
        )
      `);
      throw new Error("DATABASE_ACCEPTED_FORGED_SESSION_PACKAGE_QUERY");
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("audits a pgvector capability rejection with the command payload hash", async () => {
    const commandId = cmd("capability-audit");
    await db.execute(sql`
      UPDATE dopaios_kc08_capabilities SET available = false WHERE name = 'pgvector'
    `);
    try {
      await expect(retrieveDkp(db, commandId, {
        queryId: "QUERY-KC08-CAPABILITY-AUDIT",
        sessionId,
        projectId,
        packageRef: { id: "CTX-KC08-RETRIEVAL", revision: 1, sha256: contextPackageSha256 },
        query: "renewal webhook",
        limit: 3,
        indexVersion: "kc08-structured-markdown-v1",
        embedder,
      })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-PGVECTOR" });
      const rejected = await db.execute(sql`
        SELECT data->>'code' AS code, data->>'payloadSha256' AS payload_sha256
        FROM message_store.messages
        WHERE type = 'CommandRejected' AND data->>'commandId' = ${commandId}
      `);
      expect(rejected).toEqual([{
        code: "ERR-RETRIEVAL-PGVECTOR",
        payload_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }]);
    } finally {
      await db.execute(sql`
        UPDATE dopaios_kc08_capabilities SET available = true WHERE name = 'pgvector'
      `);
    }
  });

  it("rejects a forged indexed chunk whose bytes do not match the mounted source range", async () => {
    const [chunk] = (await db.execute(sql`
      SELECT source_id, source_revision, ordinal, char_start, char_end,
             embedding_model_ref, index_version
      FROM dopaios_dkp_chunks
      WHERE project_id = ${projectId}
        AND context_package_id = 'CTX-KC08-RETRIEVAL'
        AND context_package_revision = 1
      ORDER BY ordinal
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    expect(chunk).toBeDefined();
    await expect(db.transaction(async (tx) => {
      await projectEvent(tx, {
        id: "KC08-FORGED-CHUNK",
        streamName: "dopaiosDkpIndex-forged",
        type: "DkpChunkIndexed",
        position: 999,
        globalPosition: 999,
        time: new Date("2026-08-03T00:00:00.000Z"),
        data: {
          projectId,
          contextPackageId: "CTX-KC08-RETRIEVAL",
          contextPackageRevision: 1,
          sourceId: chunk!.source_id,
          sourceRevision: chunk!.source_revision,
          chunkId: "CHUNK-FORGED-CONTENT",
          ordinal: chunk!.ordinal,
          charStart: chunk!.char_start,
          charEnd: chunk!.char_end,
          rangeUnit: "utf16-code-unit",
          content: "tampered chunk bytes",
          embedding: [1, 0.1, 0.1, 0.1],
          embeddingModelRef: chunk!.embedding_model_ref,
          indexVersion: chunk!.index_version,
        },
        metadata: { commandId: "KC08-FORGED-CHUNK" },
      });
      throw new Error("PROJECTOR_ACCEPTED_FORGED_CHUNK");
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-CHUNK" });
  });

  it("rejects a correctly hashed source substring that is not a canonical structured-Markdown chunk", async () => {
    const content = dkpContent.slice(0, 10);
    const ordinal = 99;
    const packageRef = {
      id: "CTX-KC08-RETRIEVAL",
      revision: 1,
      sha256: contextPackageSha256,
    };
    const sourceRef = { id: dkpId, revision: 1, sha256: sha256Utf8(dkpContent) };
    const chunkId = `CHUNK-${payloadSha256({ packageRef, sourceRef, ordinal, content }).slice(0, 24)}`;
    await expect(db.transaction(async (tx) => {
      await projectEvent(tx, {
        id: "KC08-NONCANONICAL-CHUNK",
        streamName: "dopaiosDkpIndex-noncanonical",
        type: "DkpChunkIndexed",
        position: 999,
        globalPosition: 999,
        time: new Date("2026-08-03T00:00:00.000Z"),
        data: {
          projectId,
          contextPackageId: packageRef.id,
          contextPackageRevision: packageRef.revision,
          sourceId: sourceRef.id,
          sourceRevision: sourceRef.revision,
          chunkId,
          ordinal,
          charStart: 0,
          charEnd: 10,
          rangeUnit: "utf16-code-unit",
          content,
          embedding: [1, 0.1, 0.1, 0.1],
          embeddingModelRef,
          indexVersion: "kc08-structured-markdown-v1",
        },
        metadata: { commandId: "KC08-NONCANONICAL-CHUNK" },
      });
      throw new Error("PROJECTOR_ACCEPTED_NONCANONICAL_CHUNK");
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-CHUNK" });
  });

  it("rejects a canonical v1 chunk mislabeled with an unsupported index version", async () => {
    const [chunk] = (await db.execute(sql`
      SELECT source_id, source_revision, chunk_id, ordinal, char_start, char_end,
             content, embedding_model_ref
      FROM dopaios_dkp_chunks
      WHERE project_id = ${projectId}
        AND context_package_id = 'CTX-KC08-RETRIEVAL'
        AND context_package_revision = 1
        AND index_version = 'kc08-structured-markdown-v1'
      ORDER BY ordinal
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    expect(chunk).toBeDefined();
    await expect(db.transaction(async (tx) => {
      await projectEvent(tx, {
        id: "KC08-UNSUPPORTED-INDEX-VERSION",
        streamName: "dopaiosDkpIndex-unsupported-version",
        type: "DkpChunkIndexed",
        position: 999,
        globalPosition: 999,
        time: new Date("2026-08-03T00:00:00.000Z"),
        data: {
          projectId,
          contextPackageId: "CTX-KC08-RETRIEVAL",
          contextPackageRevision: 1,
          sourceId: chunk!.source_id,
          sourceRevision: chunk!.source_revision,
          chunkId: chunk!.chunk_id,
          ordinal: chunk!.ordinal,
          charStart: chunk!.char_start,
          charEnd: chunk!.char_end,
          rangeUnit: "utf16-code-unit",
          content: chunk!.content,
          embedding: [1, 0.1, 0.1, 0.1],
          embeddingModelRef: chunk!.embedding_model_ref,
          indexVersion: "kc08-structured-markdown-v2",
        },
        metadata: { commandId: "KC08-UNSUPPORTED-INDEX-VERSION" },
      });
      throw new Error("PROJECTOR_ACCEPTED_UNSUPPORTED_INDEX_VERSION");
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-CHUNK" });
  });

  it("prevents the same indexed chunk from occupying two ranks in one query", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO dopaios_retrieval_hits (
          query_id, rank, project_id, context_package_id, context_package_revision,
          context_package_sha256, source_id, source_revision, source_sha256, chunk_id,
          char_start, char_end, range_unit, excerpt, method, index_version,
          embedding_model_ref, score, policy_decision
        )
        SELECT query_id, 999, project_id, context_package_id, context_package_revision,
               context_package_sha256, source_id, source_revision, source_sha256, chunk_id,
               char_start, char_end, range_unit, excerpt, method, index_version,
               embedding_model_ref, score, policy_decision
        FROM dopaios_retrieval_hits
        WHERE query_id = 'QUERY-KC08-RENEWAL' AND rank = 1
      `);
      throw new Error("DATABASE_ACCEPTED_DUPLICATE_QUERY_CHUNK");
    })).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  it("rejects a forged hit whose package hash does not match its query and indexed chunk", async () => {
    const [hit] = (await db.execute(sql`
      SELECT source_id, source_revision, source_sha256, chunk_id, char_start, char_end,
             range_unit, excerpt, method, index_version, embedding_model_ref, score, policy_decision
      FROM dopaios_retrieval_hits
      WHERE query_id = 'QUERY-KC08-RENEWAL' AND rank = 1
    `)) as unknown as Array<Record<string, unknown>>;
    expect(hit).toBeDefined();
    await expect(db.transaction(async (tx) => {
      await projectEvent(tx, {
        id: "KC08-FORGED-HIT",
        streamName: "dopaiosRetrieval-QUERY-KC08-RENEWAL",
        type: "RetrievalHitRecorded",
        position: 999,
        globalPosition: 999,
        time: new Date("2026-08-03T00:00:00.000Z"),
        data: {
          queryId: "QUERY-KC08-RENEWAL",
          sessionId,
          rank: 999,
          projectId,
          contextPackage: {
            id: "CTX-KC08-RETRIEVAL",
            revision: 1,
            sha256: "0".repeat(64),
          },
          source: {
            id: hit!.source_id,
            revision: hit!.source_revision,
            sha256: hit!.source_sha256,
          },
          chunk: {
            id: hit!.chunk_id,
            charStart: hit!.char_start,
            charEnd: hit!.char_end,
            rangeUnit: hit!.range_unit,
          },
          excerpt: hit!.excerpt,
          method: hit!.method,
          indexVersion: hit!.index_version,
          embeddingModelRef: hit!.embedding_model_ref,
          score: hit!.score,
          policyDecision: hit!.policy_decision,
        },
        metadata: { commandId: "KC08-FORGED-HIT" },
      });
      throw new Error("PROJECTOR_ACCEPTED_FORGED_PROVENANCE");
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-PROVENANCE" });
  });

  it("denies a cross-Project query and an unmounted source without embedding or excerpts", async () => {
    let embedCalls = 0;
    const observedEmbedder: FourDimensionalEmbedder = {
      ...embedder,
      embed: async (text) => {
        embedCalls += 1;
        return embedder.embed(text);
      },
    };
    await expect(retrieveDkp(db, cmd("cross-project"), {
      queryId: "QUERY-KC08-CROSS-PROJECT",
      sessionId,
      projectId: "PROJECT-KC08-OTHER",
      packageRef: { id: "CTX-KC08-RETRIEVAL", revision: 1, sha256: contextPackageSha256 },
      query: "renewal webhook",
      limit: 3,
      indexVersion: "kc08-structured-markdown-v1",
      embedder: observedEmbedder,
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-CONTEXT" });
    expect(embedCalls).toBe(0);
    const crossProjectHits = await db.execute(sql`
      SELECT excerpt FROM dopaios_retrieval_hits WHERE query_id = 'QUERY-KC08-CROSS-PROJECT'
    `);
    expect(crossProjectHits).toEqual([]);

    await expect(indexDkpSource(db, cmd("unmounted"), {
      projectId,
      packageRef: { id: "CTX-KC08-RETRIEVAL", revision: 1, sha256: contextPackageSha256 },
      sourceRef: { id: "DKP-NOT-MOUNTED", revision: 1, sha256: "f".repeat(64) },
      indexVersion: "kc08-structured-markdown-v1",
      embedder: observedEmbedder,
    })).rejects.toMatchObject({ code: "ERR-RETRIEVAL-SOURCE" });
    expect(embedCalls).toBe(0);
  });

  it("keeps the package pin but blocks current impacted content before returning any excerpt", async () => {
    await markArtifactImpact(db, cmd("impact"), {
      artifactId: dkpId,
      revision: 1,
      impactStatus: "impact-pending",
    });
    await expect(
      retrieveDkp(db, cmd("blocked-query"), {
        queryId: "QUERY-KC08-IMPACT-BLOCKED",
        sessionId,
        projectId,
        packageRef: {
          id: "CTX-KC08-RETRIEVAL",
          revision: 1,
          sha256: contextPackageSha256,
        },
        query: "warehouse dispatch",
        limit: 3,
        indexVersion: "kc08-structured-markdown-v1",
        embedder,
      }),
    ).rejects.toMatchObject({ code: "ERR-RETRIEVAL-IMPACT" });
    const queries = await db.execute(sql`
      SELECT policy_decision FROM dopaios_retrieval_queries WHERE id = 'QUERY-KC08-IMPACT-BLOCKED'
    `);
    expect(queries).toEqual([{ policy_decision: "deny-current-impact" }]);
    const hits = await db.execute(sql`
      SELECT excerpt FROM dopaios_retrieval_hits WHERE query_id = 'QUERY-KC08-IMPACT-BLOCKED'
    `);
    expect(hits).toEqual([]);
  });

  it("replays indexed chunks, denied queries, and full provenance byte-identically", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
