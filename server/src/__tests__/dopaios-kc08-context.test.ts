import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  executeCommand,
  projectEvent,
  replayProjections,
  snapshotProjections,
} from "../dopaios/event-store.js";
import { registerApprovedArtifact, markArtifactImpact } from "../dopaios/commands.js";
import { registerDraftArtifact } from "../dopaios/approval.js";
import { compileExecutionContract } from "../dopaios/contract.js";
import { requestActivation, runActivation } from "../dopaios/activation.js";
import { FakeEngine } from "../dopaios/engine.js";
import {
  approveContextPackage,
  bindArtifactProjectScope,
  buildContextPackage,
  sha256Utf8,
  type TokenCounter,
} from "../dopaios/context-package.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;
const counter: TokenCounter = { id: "words-v1", count: (text) => text.trim().split(/\s+/u).length };

describeDb("dopaios KC-08 context package", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let seq = 0;
  const cmd = (label: string) => `KC08-CTX-${label}-${(seq += 1)}`;
  const projectId = "PROJECT-KC08-A";
  const workItemId = "WI-KC08-A";
  let approvedContextPackageRef!: { id: string; revision: number; sha256: string };
  let draftContextPackageRef!: { id: string; revision: number; sha256: string };
  let replacementSource!: { id: string; revision: number; sha256: string; type: string; content: string };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc08-context-");
    db = createDb(tempDb.connectionString);
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
  }, 120_000);

  afterAll(async () => tempDb?.cleanup());

  async function source(
    id: string,
    content: string,
    type: string,
    project = projectId,
  ): Promise<{ id: string; revision: number; sha256: string; type: string; content: string }> {
    const sha256 = sha256Utf8(content);
    await registerApprovedArtifact(db, cmd(`artifact-${id}`), {
      artifactId: id,
      revision: 1,
      sha256,
      artifactType: type,
      storageRef: `fixture://${id}`,
    });
    await bindArtifactProjectScope(db, cmd(`scope-${id}`), {
      artifactId: id,
      revision: 1,
      projectId: project,
      boundBy: "ORCH-KC08",
    });
    return { id, revision: 1, sha256, type, content };
  }

  it("builds a canonical capped manifest, omits only optional whole sources, and approves by exact triple", async () => {
    const instructions = await source("INSTRUCTIONS-KC08", "must keep exact pins", "instructions");
    const sop = await source("SOP-KC08", "approved sop source", "sop");
    const optionalDkp = await source("DKP-KC08", "optional domain knowledge pack is too large", "dkp");
    const approval = await source("APR-CONTEXT-KC08", "context approval", "approval-record");

    const built = await buildContextPackage(db, cmd("build"), {
      packageId: "CTX-KC08",
      projectId,
      workItemId,
      createdBy: "AI-LEAD-KC08",
      caps: { maxBytes: 80, maxTokens: 7 },
      tokenCounter: counter,
      sources: [
        { ...optionalDkp, required: false },
        { ...sop, required: true },
        { ...instructions, required: true },
      ],
    });
    expect(built).toMatchObject({ packageId: "CTX-KC08", revision: 1, state: "draft" });
    expect(built.manifest.sources.map((item) => [item.id, item.mountState])).toEqual([
      ["INSTRUCTIONS-KC08", "mounted"],
      ["SOP-KC08", "mounted"],
      ["DKP-KC08", "omitted"],
    ]);
    expect(built.manifest.sources[2]?.omissionReason).toBe("optional-cap-exceeded");
    approvedContextPackageRef = { id: built.packageId, revision: built.revision, sha256: built.sha256 };

    await registerApprovedArtifact(db, cmd("package-ledger"), {
      artifactId: "CTX-KC08",
      revision: 1,
      sha256: built.sha256,
      artifactType: "context-package",
      storageRef: "db://dopaios_context_packages/CTX-KC08/1",
    });
    const approved = await approveContextPackage(db, cmd("approve"), {
      packageRef: { id: "CTX-KC08", revision: 1, sha256: built.sha256 },
      approvalRef: { id: approval.id, revision: 1, sha256: approval.sha256 },
      approvedBy: "ORCH-KC08",
    });
    expect(approved).toMatchObject({ state: "approved", sha256: built.sha256 });
  });

  it("fails closed on required impact-pending content before writing a package", async () => {
    const required = await source("DKP-IMPACT-KC08", "required impacted content", "dkp");
    await markArtifactImpact(db, cmd("impact"), {
      artifactId: required.id,
      revision: 1,
      impactStatus: "impact-pending",
    });
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM dopaios_context_packages`);
    await expect(
      buildContextPackage(db, cmd("blocked"), {
        packageId: "CTX-BLOCKED-KC08",
        projectId,
        workItemId,
        createdBy: "AI-LEAD-KC08",
        caps: { maxBytes: 1_000, maxTokens: 100 },
        tokenCounter: counter,
        sources: [{ ...required, required: true }],
      }),
    ).rejects.toMatchObject({ code: "ERR-CONTEXT-IMPACT" });
    const after = await db.execute(sql`SELECT count(*)::int AS n FROM dopaios_context_packages`);
    expect(after).toEqual(before);
  });

  it("fails closed for every required-source defect and records optional omission reasons", async () => {
    const approvedNoScopeContent = "approved but no scope mapping";
    const approvedNoScopeSha = sha256Utf8(approvedNoScopeContent);
    await registerApprovedArtifact(db, cmd("no-scope-artifact"), {
      artifactId: "DKP-NO-SCOPE-KC08",
      revision: 1,
      sha256: approvedNoScopeSha,
      artifactType: "dkp",
      storageRef: "fixture://DKP-NO-SCOPE-KC08",
    });
    const draftContent = "draft source";
    await registerDraftArtifact(db, cmd("draft-artifact"), {
      artifactId: "DKP-DRAFT-KC08",
      revision: 1,
      sha256: sha256Utf8(draftContent),
      createdBy: "AI-LEAD-KC08",
      artifactType: "dkp",
      hasRegionSchema: false,
      storageRef: "fixture://DKP-DRAFT-KC08",
    });
    await bindArtifactProjectScope(db, cmd("draft-scope"), {
      artifactId: "DKP-DRAFT-KC08",
      revision: 1,
      projectId,
      boundBy: "ORCH-KC08",
    });
    const cases = [
      {
        label: "missing",
        source: { id: "DKP-MISSING-KC08", revision: 1, sha256: sha256Utf8("missing"), type: "dkp", content: "missing", required: true },
        code: "ERR-CONTEXT-SOURCE",
      },
      {
        label: "stale-hash",
        source: { id: "DKP-NO-SCOPE-KC08", revision: 1, sha256: "f".repeat(64), type: "dkp", content: approvedNoScopeContent, required: true },
        code: "ERR-CONTEXT-HASH",
      },
      {
        label: "content-hash",
        source: { id: "DKP-NO-SCOPE-KC08", revision: 1, sha256: approvedNoScopeSha, type: "dkp", content: "tampered content", required: true },
        code: "ERR-CONTEXT-HASH",
      },
      {
        label: "scope",
        source: { id: "DKP-NO-SCOPE-KC08", revision: 1, sha256: approvedNoScopeSha, type: "dkp", content: approvedNoScopeContent, required: true },
        code: "ERR-CONTEXT-SCOPE",
      },
      {
        label: "unapproved",
        source: { id: "DKP-DRAFT-KC08", revision: 1, sha256: sha256Utf8(draftContent), type: "dkp", content: draftContent, required: true },
        code: "ERR-CONTEXT-UNAPPROVED",
      },
    ];
    for (const item of cases) {
      await expect(buildContextPackage(db, cmd(item.label), {
        packageId: `CTX-KC08-${item.label}`,
        projectId,
        workItemId,
        createdBy: "AI-LEAD-KC08",
        caps: { maxBytes: 1_000, maxTokens: 100 },
        tokenCounter: counter,
        sources: [item.source],
      })).rejects.toMatchObject({ code: item.code });
    }
    const optional = await buildContextPackage(db, cmd("optional-missing"), {
      packageId: "CTX-KC08-OPTIONAL-MISSING",
      projectId,
      workItemId,
      createdBy: "AI-LEAD-KC08",
      caps: { maxBytes: 1_000, maxTokens: 100 },
      tokenCounter: counter,
      sources: [{
        id: "DKP-OPTIONAL-MISSING-KC08",
        revision: 1,
        sha256: sha256Utf8("optional missing"),
        type: "dkp",
        content: "optional missing",
        required: false,
      }],
    });
    expect(optional.manifest.sources[0]).toMatchObject({ mountState: "omitted", omissionReason: "missing" });
    const projected = await db.execute(sql`
      SELECT omission_reason, content FROM dopaios_context_package_sources
      WHERE context_package_id = 'CTX-KC08-OPTIONAL-MISSING' AND context_package_revision = 1
    `);
    expect(projected).toEqual([{ omission_reason: "missing", content: null }]);

    const optionalPeer = await source("A-INSTRUCTIONS-OPTIONAL-KC08", "optional peer consumes cap", "instructions");
    const requiredPeer = await source("Z-INSTRUCTIONS-REQUIRED-KC08", "required peer must win", "instructions");
    const requiredFirst = await buildContextPackage(db, cmd("required-first"), {
      packageId: "CTX-KC08-REQUIRED-FIRST",
      projectId,
      workItemId,
      createdBy: "AI-LEAD-KC08",
      caps: {
        maxBytes: Buffer.byteLength(requiredPeer.content, "utf8"),
        maxTokens: counter.count(requiredPeer.content),
      },
      tokenCounter: counter,
      sources: [
        { ...optionalPeer, required: false },
        { ...requiredPeer, required: true },
      ],
    });
    expect(requiredFirst.manifest.sources.map((item) => [item.id, item.mountState])).toEqual([
      [requiredPeer.id, "mounted"],
      [optionalPeer.id, "omitted"],
    ]);
  });

  it("creates a new revision without changing the approved package and replay is byte-identical", async () => {
    const replacement = await source("SOP-KC08-R2", "new source creates new context", "sop");
    replacementSource = replacement;
    const built = await buildContextPackage(db, cmd("build-r2"), {
      packageId: "CTX-KC08",
      projectId,
      workItemId,
      createdBy: "AI-LEAD-KC08",
      caps: { maxBytes: 1_000, maxTokens: 100 },
      tokenCounter: counter,
      sources: [{ ...replacement, required: true }],
    });
    draftContextPackageRef = { id: built.packageId, revision: built.revision, sha256: built.sha256 };
    expect(built.revision).toBe(2);
    const rows = (await db.execute(sql`
      SELECT revision, state FROM dopaios_context_packages WHERE id = 'CTX-KC08' ORDER BY revision
    `)) as unknown as Array<{ revision: number; state: string }>;
    expect(rows).toEqual([
      { revision: 1, state: "approved" },
      { revision: 2, state: "draft" },
    ]);
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });

  it("pins the exact Context Package through contract, activation, and AI session without silently upgrading", async () => {
    await executeCommand(db, {
      commandId: cmd("execution-fixtures"),
      payload: {},
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosStaffAi-AI-KC08-BUILD",
          type: "StaffAiRegistered",
          data: {
            staffId: "AI-KC08-BUILD",
            workStatus: "active",
            capabilities: ["ai-build"],
            skills: ["kc08"],
            permissions: ["repo-read"],
            resources: ["workspace"],
            capacityLimit: 1,
            profileRevision: 1,
          },
        });
        await ctx.emit({
          streamName: "dopaiosTeamManifest-TM-KC08",
          type: "TeamManifestProposed",
          data: {
            manifestId: "TM-KC08",
            revision: 1,
            stage: "bootstrap",
            projectId,
            poolRef: { id: "POOL-KC08", revision: 1 },
            roleAssignments: { "AI-Build": { primary: "AI-KC08-BUILD", fallback: "AI-KC08-BUILD" } },
            orchestrator: "ORCH-KC08",
            pod: "POD-KC08",
            capacity: { "AI-Build": 1 },
            permissions: ["repo-read"],
            resources: ["workspace"],
            routingRules: { mode: "manifest-pinned" },
            createdBy: "ORCH-KC08",
            sha256: "b".repeat(64),
          },
        });
        await ctx.emit({
          streamName: "dopaiosTeamManifest-TM-KC08",
          type: "TeamManifestApproved",
          data: { manifestId: "TM-KC08", revision: 1, approvedBy: "ORCH-KC08" },
        });
        await ctx.emit({
          streamName: `dopaiosWorkItem-${workItemId}`,
          type: "WorkItemRouted",
          data: {
            workItemId,
            staffId: "AI-KC08-BUILD",
            role: "AI-Build",
            basis: { manifest: { id: "TM-KC08", revision: 1 } },
          },
        });
        await ctx.emit({
          streamName: "dopaiosSopDefinition-SOPDEF-KC08",
          type: "SopDefinitionCreated",
          data: {
            definitionId: "SOPDEF-KC08",
            revision: 1,
            sopPin: { id: "SOP-KC08", revision: 1, sha256: sha256Utf8("approved sop source") },
          },
        });
        await ctx.emit({
          streamName: "dopaiosSopDefinition-SOPDEF-KC08",
          type: "SopDefinitionPublished",
          data: { definitionId: "SOPDEF-KC08", contractSuiteEvidence: { passed: true } },
        });
        return {};
      },
    });
    const fields = {
      objective: "execute KC-08 bounded context",
      scope: "Project KC-08",
      inputs: [approvedContextPackageRef],
      outputs: [{ id: "OUT-KC08" }],
      context: { packageRef: approvedContextPackageRef },
      permissions: ["repo-read"],
      tools: ["fake-engine"],
      limits: { timeMs: 60_000, costUsd: 1, loops: 1 },
      requiredChecks: ["context-pin"],
      requiredEvidence: ["session-pin"],
      stopConditions: ["step-done"],
      escalationEvents: ["context-impact"],
      fallbackPath: "stop",
    };
    const compiled = await compileExecutionContract(db, cmd("compile-context"), {
      contractId: "XC-KC08",
      workItemId,
      compiledBy: "system-router",
      sopRef: { id: "SOPDEF-KC08", revision: 1, sha256: "c".repeat(64) },
      fields,
      contextPackageRef: approvedContextPackageRef,
    });
    await requestActivation(db, cmd("activation-context"), {
      activationId: "ACT-KC08-CONTEXT",
      workItemId,
      agentId: "AI-KC08-BUILD",
      engine: "fake-acp-shape",
      contract: { contractId: "XC-KC08", revision: compiled["revision"] as number },
    });
    const outcome = await runActivation(db, {
      activationId: "ACT-KC08-CONTEXT",
      claimedBy: "AI-KC08-BUILD",
      sessionId: "SESSION-KC08-CONTEXT",
      agentId: "AI-KC08-BUILD",
      adapter: new FakeEngine(),
      contract: {
        workItemId,
        contractRevision: compiled["revision"] as number,
        sopRef: { id: "SOPDEF-KC08", revision: 1 },
        steps: ["bounded-step"],
        contextPackageRef: approvedContextPackageRef,
      },
    });
    expect(outcome.kind).toBe("succeeded");
    const pins = await db.execute(sql`
      SELECT 'contract' AS kind, context_package_id, context_package_revision, context_package_sha256
      FROM dopaios_execution_contracts WHERE id = 'XC-KC08' AND revision = 1
      UNION ALL
      SELECT 'activation', context_package_id, context_package_revision, context_package_sha256
      FROM dopaios_activations WHERE id = 'ACT-KC08-CONTEXT'
      UNION ALL
      SELECT 'session', context_package_id, context_package_revision, context_package_sha256
      FROM dopaios_ai_sessions WHERE id = 'SESSION-KC08-CONTEXT'
      ORDER BY kind
    `);
    expect(pins).toEqual([
      { kind: "activation", context_package_id: approvedContextPackageRef.id, context_package_revision: 1, context_package_sha256: approvedContextPackageRef.sha256 },
      { kind: "contract", context_package_id: approvedContextPackageRef.id, context_package_revision: 1, context_package_sha256: approvedContextPackageRef.sha256 },
      { kind: "session", context_package_id: approvedContextPackageRef.id, context_package_revision: 1, context_package_sha256: approvedContextPackageRef.sha256 },
    ]);
    expect(approvedContextPackageRef.revision).toBe(1);
  });

  it("rejects partial Context Package triples at the database boundary", async () => {
    for (const mutation of [
      sql`UPDATE dopaios_execution_contracts
          SET context_package_sha256 = NULL
          WHERE id = 'XC-KC08' AND revision = 1`,
      sql`UPDATE dopaios_activations
          SET context_package_revision = NULL
          WHERE id = 'ACT-KC08-CONTEXT'`,
      sql`UPDATE dopaios_ai_sessions
          SET context_package_id = NULL
          WHERE id = 'SESSION-KC08-CONTEXT'`,
    ]) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(mutation);
        throw new Error("DATABASE_ACCEPTED_PARTIAL_CONTEXT_PACKAGE_PIN");
      })).rejects.toMatchObject({ cause: { code: "23514" } });
    }
  });

  it("rejects complete but nonexistent Context Package triples at the database boundary", async () => {
    for (const mutation of [
      sql`UPDATE dopaios_execution_contracts
          SET context_package_id = 'CTX-KC08-FORGED', context_package_revision = 99,
              context_package_sha256 = ${"f".repeat(64)}
          WHERE id = 'XC-KC08' AND revision = 1`,
      sql`UPDATE dopaios_activations
          SET context_package_id = 'CTX-KC08-FORGED', context_package_revision = 99,
              context_package_sha256 = ${"f".repeat(64)}
          WHERE id = 'ACT-KC08-CONTEXT'`,
      sql`UPDATE dopaios_ai_sessions
          SET context_package_id = 'CTX-KC08-FORGED', context_package_revision = 99,
              context_package_sha256 = ${"f".repeat(64)}
          WHERE id = 'SESSION-KC08-CONTEXT'`,
    ]) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(mutation);
        throw new Error("DATABASE_ACCEPTED_NONEXISTENT_CONTEXT_PACKAGE_PIN");
      })).rejects.toMatchObject({ cause: { code: "23503" } });
    }
  });

  it("keeps Context Package children and retrieval queries inside the package Project", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE dopaios_context_package_sources
        SET project_id = 'PROJECT-KC08-FOREIGN'
        WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
          AND source_id = 'INSTRUCTIONS-KC08'
      `);
      throw new Error("DATABASE_ACCEPTED_CROSS_PROJECT_PACKAGE_SOURCE");
    })).rejects.toMatchObject({ cause: { code: "23503" } });

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO dopaios_retrieval_queries (
          id, session_id, project_id, context_package_id, context_package_revision,
          context_package_sha256, query_sha256, query_redacted, method,
          index_version, embedding_model_ref, policy_decision, created_at
        ) VALUES (
          'QUERY-KC08-CROSS-PROJECT-FORGED', 'SESSION-KC08-CONTEXT', 'PROJECT-KC08-FOREIGN',
          ${approvedContextPackageRef.id}, ${approvedContextPackageRef.revision},
          ${approvedContextPackageRef.sha256}, ${"1".repeat(64)}, '[redacted]',
          'rrf-lexical-vector', 'kc08-forged',
          ${JSON.stringify({ id: "fixture", revision: 1, sha256: "e".repeat(64) })}::jsonb,
          'allow', now()
        )
      `);
      throw new Error("DATABASE_ACCEPTED_CROSS_PROJECT_RETRIEVAL_QUERY");
    })).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("enforces Context Package cap totals at the database boundary", async () => {
    for (const mutation of [
      sql`UPDATE dopaios_context_packages SET max_bytes = -1
          WHERE id = 'CTX-KC08' AND revision = 1`,
      sql`UPDATE dopaios_context_packages SET total_tokens = max_tokens + 1
          WHERE id = 'CTX-KC08' AND revision = 1`,
    ]) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(mutation);
        throw new Error("DATABASE_ACCEPTED_INVALID_CONTEXT_CAP_TOTALS");
      })).rejects.toMatchObject({ cause: { code: "23514" } });
    }
  });

  it("keeps declared package totals equal to mounted source totals", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE dopaios_context_packages SET total_bytes = total_bytes + 1
        WHERE id = 'CTX-KC08' AND revision = 1
      `);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      throw new Error("DATABASE_ACCEPTED_FALSE_CONTEXT_PACKAGE_TOTALS");
    })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("revalidates both packages when a source is re-parented", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        WITH moved AS (
          SELECT content_bytes, token_count
          FROM dopaios_context_package_sources
          WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
            AND source_id = 'INSTRUCTIONS-KC08'
        )
        UPDATE dopaios_context_packages p
        SET total_bytes = p.total_bytes + moved.content_bytes,
            total_tokens = p.total_tokens + moved.token_count
        FROM moved
        WHERE p.id = 'CTX-KC08' AND p.revision = 2
      `);
      await tx.execute(sql`
        UPDATE dopaios_context_package_sources
        SET context_package_revision = 2
        WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
          AND source_id = 'INSTRUCTIONS-KC08'
      `);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      throw new Error("DATABASE_ACCEPTED_ORPHANED_OLD_PACKAGE_TOTALS");
    })).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("enforces mounted and omitted source coherence at the database boundary", async () => {
    for (const mutation of [
      sql`UPDATE dopaios_context_package_sources SET content = NULL
          WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
            AND source_id = 'INSTRUCTIONS-KC08'`,
      sql`UPDATE dopaios_context_package_sources SET content = 'forged omitted bytes'
          WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
            AND source_id = 'DKP-KC08'`,
      sql`UPDATE dopaios_context_package_sources
          SET mount_state = 'omitted', omission_reason = 'forged', content = NULL
          WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
            AND source_id = 'INSTRUCTIONS-KC08'`,
      sql`UPDATE dopaios_context_package_sources SET content_bytes = content_bytes + 1
          WHERE context_package_id = 'CTX-KC08' AND context_package_revision = 1
            AND source_id = 'INSTRUCTIONS-KC08'`,
    ]) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(mutation);
        throw new Error("DATABASE_ACCEPTED_INCOHERENT_CONTEXT_SOURCE");
      })).rejects.toMatchObject({ cause: { code: "23514" } });
    }
  });

  it("rejects a forged package event whose declared boundedness does not match mounted bytes", async () => {
    const content = "mounted content exceeds its declared byte count";
    await expect(db.transaction(async (tx) => {
      await projectEvent(tx, {
        id: "KC08-FORGED-BOUNDEDNESS",
        streamName: "dopaiosContextPackage-CTX-KC08-FORGED-BOUNDEDNESS",
        type: "ContextPackageBuilt",
        position: 999,
        globalPosition: 999,
        time: new Date("2026-08-03T00:00:00.000Z"),
        data: {
          packageId: "CTX-KC08-FORGED-BOUNDEDNESS",
          revision: 1,
          projectId,
          workItemId,
          state: "draft",
          sha256: "f".repeat(64),
          manifest: { schema: "dopaios.context-package/v1", approval: null },
          maxBytes: 100,
          maxTokens: 100,
          totalBytes: 1,
          totalTokens: 1,
          createdBy: "AI-LEAD-KC08",
          sources: [{
            id: "DKP-KC08-FORGED-BOUNDEDNESS",
            revision: 1,
            sha256: sha256Utf8(content),
            type: "dkp",
            required: true,
            priority: 4,
            mountState: "mounted",
            omissionReason: null,
            contentBytes: 1,
            tokenCount: 1,
            content,
          }],
        },
        metadata: { commandId: "KC08-FORGED-BOUNDEDNESS" },
      });
      throw new Error("PROJECTOR_ACCEPTED_FALSE_CONTEXT_BOUNDEDNESS");
    })).rejects.toMatchObject({ code: "ERR-CONTEXT-PROJECTION" });
  });

  it("fails closed with an explicit capability error when projecting vector events without pgvector", async () => {
    const capability = await db.execute(sql`
      SELECT available FROM dopaios_kc08_capabilities WHERE name = 'pgvector'
    `);
    expect(capability).toEqual([{ available: false }]);
    await expect(db.transaction(async (tx) => projectEvent(tx, {
      id: "KC08-NO-VECTOR-EVENT",
      streamName: "dopaiosDkpIndex-no-vector",
      type: "DkpChunkIndexed",
      position: 0,
      globalPosition: 0,
      time: new Date("2026-08-03T00:00:00.000Z"),
      data: {
        projectId,
        contextPackageId: approvedContextPackageRef.id,
        contextPackageRevision: approvedContextPackageRef.revision,
        sourceId: "DKP-NO-VECTOR",
        sourceRevision: 1,
        chunkId: "CHUNK-NO-VECTOR",
        ordinal: 0,
        charStart: 0,
        charEnd: 4,
        rangeUnit: "utf16-code-unit",
        content: "stop",
        embedding: [1, 0, 0, 0],
        embeddingModelRef: { id: "fixture", revision: 1, sha256: "e".repeat(64) },
        indexVersion: "kc08-no-vector",
      },
      metadata: { commandId: "KC08-NO-VECTOR" },
    }))).rejects.toMatchObject({ code: "ERR-RETRIEVAL-PGVECTOR" });
  });

  it("rejects a runtime Context Package mismatch before the engine and leaves the activation queued", async () => {
    await requestActivation(db, cmd("activation-mismatch"), {
      activationId: "ACT-KC08-CONTEXT-MISMATCH",
      workItemId,
      agentId: "AI-KC08-BUILD",
      engine: "observed-engine",
      contract: { contractId: "XC-KC08", revision: 1 },
    });
    let engineCalls = 0;
    await expect(runActivation(db, {
      activationId: "ACT-KC08-CONTEXT-MISMATCH",
      claimedBy: "AI-KC08-BUILD",
      sessionId: "SESSION-KC08-CONTEXT-MISMATCH",
      agentId: "AI-KC08-BUILD",
      adapter: {
        name: "observed-engine",
        execute: async () => {
          engineCalls += 1;
          throw new Error("must not execute");
        },
      },
      contract: {
        workItemId,
        contractRevision: 1,
        sopRef: { id: "SOPDEF-KC08", revision: 1 },
        steps: ["must-not-run"],
        contextPackageRef: draftContextPackageRef,
      },
    })).rejects.toMatchObject({ code: "ERR-CONTEXT-PIN" });
    expect(engineCalls).toBe(0);
    const activation = await db.execute(sql`
      SELECT state FROM dopaios_activations WHERE id = 'ACT-KC08-CONTEXT-MISMATCH'
    `);
    expect(activation).toEqual([{ state: "QUEUED" }]);
  });

  it("serializes concurrent Context Package revisions and replays all pins byte-identically", async () => {
    const builds = await Promise.all([
      buildContextPackage(db, cmd("concurrent-a"), {
        packageId: "CTX-KC08",
        projectId,
        workItemId,
        createdBy: "AI-LEAD-KC08",
        caps: { maxBytes: 1_000, maxTokens: 100 },
        tokenCounter: counter,
        sources: [{ ...replacementSource, required: true }],
      }),
      buildContextPackage(db, cmd("concurrent-b"), {
        packageId: "CTX-KC08",
        projectId,
        workItemId,
        createdBy: "AI-LEAD-KC08",
        caps: { maxBytes: 1_000, maxTokens: 100 },
        tokenCounter: counter,
        sources: [{ ...replacementSource, required: true }],
      }),
    ]);
    expect(builds.map((item) => item.revision).sort((a, b) => a - b)).toEqual([3, 4]);
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
