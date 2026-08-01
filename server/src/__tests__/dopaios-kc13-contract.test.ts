import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import {
  registerActor,
  createProjectShell,
  registerApprovedArtifact,
  createSopDefinition,
  publishSopDefinition,
} from "../dopaios/commands.ts";
import {
  registerStaffAi,
  pinStartupPool,
  proposeTeamManifest,
  approveTeamManifest,
  approveProjectInitiation,
  createProjectWorkItem,
  AI_ROLES,
} from "../dopaios/routing.ts";
import { compileExecutionContract } from "../dopaios/contract.ts";
import { routeWorkItem } from "../dopaios/router.ts";
import { requestActivation, claimActivation } from "../dopaios/activation.ts";

// KC-13 B3: Hợp đồng thực hiện AI (PRD FR-63). Biên dịch từ bốn nguồn có
// phiên bản; thiếu trường bắt buộc thì AI không bắt đầu; sửa hợp đồng tạo
// revision mới, phiên đang chạy giữ pin cũ (không đổi âm thầm) và revision
// cũ còn lượt chạy được mở impact record (tái dùng bảng impact KC-03).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "a".repeat(64);
const TEMPLATE = { template_id: "BOOTSTRAP-PROJECT-TEMPLATE-001", revision: 1, sha256: SHA };

function roleMap(): Record<string, { primary: string; fallback: string }> {
  return Object.fromEntries(
    AI_ROLES.map((role) => [role, { primary: `AI-${role}`, fallback: `AI-${role}-FB` }]),
  );
}

function contractFields(): Record<string, unknown> {
  return {
    objective: "tạo Project Charter",
    scope: "P0",
    inputs: [{ id: "SRC-1", revision: 1, sha256: SHA }],
    outputs: [{ id: "OUT-CHARTER", quality: "self-check + độc lập" }],
    context: ["docs/context.md"],
    permissions: ["repo-read"],
    tools: ["engine"],
    limits: { timeMs: 60000, costUsd: 2, loops: 2 },
    requiredChecks: ["self-check"],
    requiredEvidence: ["output-hash"],
    stopConditions: ["step-done"],
    escalationEvents: ["missing-input"],
    fallbackPath: "AI-AI-Lead-FB",
  };
}

describeEmbeddedPostgres("dopaios KC-13 B3 — Hợp đồng thực hiện AI (FR-63)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;
  const cmd = (label: string) => `KC13-B3-${label}-${++seq}`;

  async function expectAudited(commandId: string): Promise<void> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE stream_name = ${"dopaiosAudit-" + commandId} AND type = 'CommandRejected'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n, `audit for ${commandId}`).toBe(1);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b3-");
    db = createDb(tempDb.connectionString);

    await registerActor(db, cmd("actor"), {
      actorId: "ORCH-1",
      kind: "human",
      active: true,
      capabilities: ["orchestrator"],
    });
    await registerActor(db, cmd("actor"), {
      actorId: "ADMIN-1",
      kind: "human",
      active: true,
      capabilities: ["staff-admin", "project-creator"],
    });
    for (const role of AI_ROLES) {
      for (const id of [`AI-${role}`, `AI-${role}-FB`]) {
        await registerStaffAi(db, cmd("staff"), {
          staffId: id,
          actor: "ADMIN-1",
          workStatus: "active",
          capabilities: [role.toLowerCase()],
          skills: ["spike"],
          permissions: ["repo-read"],
          resources: ["workspace"],
          capacityLimit: 2,
        });
      }
    }
    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-A",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await pinStartupPool(db, cmd("pool"), {
      poolId: "POOL-1",
      actor: "ADMIN-1",
      roles: roleMap(),
      readiness: "ready",
    });
    await proposeTeamManifest(db, cmd("manifest"), {
      manifestId: "TM-A",
      stage: "bootstrap",
      projectId: "PRJ-A",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-1", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: { "AI-Lead": 1 },
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await approveTeamManifest(db, cmd("approve"), { manifestId: "TM-A", revision: 1, actor: "ORCH-1" });
    await approveProjectInitiation(db, cmd("p0"), {
      projectId: "PRJ-A",
      actor: "ORCH-1",
      initiationRequest: { id: "PIR-A", sha256: SHA },
      manifestId: "TM-A",
      manifestRevision: 1,
    });
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-1",
      projectId: "PRJ-A",
      role: "AI-Lead",
    });
    // B4: claim đòi work-item đã qua router (FR-15 hai thời điểm kiểm).
    await routeWorkItem(db, cmd("route"), { workItemId: "WI-1" });

    await registerApprovedArtifact(db, cmd("sop-art"), {
      artifactId: "SOP-ART",
      revision: 1,
      sha256: SHA,
    });
    await createSopDefinition(db, cmd("sop-def"), {
      definitionId: "SOPDEF-1",
      revision: 1,
      sopPin: { artifactId: "SOP-ART", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("sop-pub"), {
      definitionId: "SOPDEF-1",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("compiles the contract from four versioned sources (FR-63)", async () => {
    const result = await compileExecutionContract(db, cmd("compile"), {
      contractId: "XC-1",
      workItemId: "WI-1",
      compiledBy: "system-router",
      sopRef: { id: "SOPDEF-1", revision: 1, sha256: SHA },
      fields: contractFields(),
    });
    expect(result).toMatchObject({ contractId: "XC-1", revision: 1 });

    const rows = (await db.execute(sql`
      SELECT sources, state FROM dopaios_execution_contracts WHERE id = 'XC-1' AND revision = 1
    `)) as unknown as Array<{ sources: Record<string, unknown>; state: string }>;
    expect(rows[0].state).toBe("active");
    expect(rows[0].sources).toMatchObject({
      sop: { id: "SOPDEF-1", revision: 1 },
      manifest: { id: "TM-A", revision: 1 },
      project: { id: "PRJ-A", state: "P0_ACTIVE" },
      workItem: { id: "WI-1" },
    });
  });

  it("refuses to compile with a missing required field — AI must not start", async () => {
    const fields = contractFields();
    delete fields["stopConditions"];
    const id = cmd("missing-field");
    await expect(
      compileExecutionContract(db, id, {
        contractId: "XC-BAD",
        workItemId: "WI-1",
        compiledBy: "system-router",
        sopRef: { id: "SOPDEF-1", revision: 1, sha256: SHA },
        fields,
      }),
    ).rejects.toMatchObject({ code: "ERR-CONTRACT-FIELD" });
    await expectAudited(id);

    const limitless = contractFields();
    (limitless["limits"] as Record<string, unknown>)["costUsd"] = undefined;
    const id2 = cmd("missing-limit");
    await expect(
      compileExecutionContract(db, id2, {
        contractId: "XC-BAD",
        workItemId: "WI-1",
        compiledBy: "system-router",
        sopRef: { id: "SOPDEF-1", revision: 1, sha256: SHA },
        fields: limitless,
      }),
    ).rejects.toMatchObject({ code: "ERR-CONTRACT-FIELD" });
    await expectAudited(id2);
  });

  it("refuses a stale SOP pin (FR-63 source 1)", async () => {
    const id = cmd("stale-sop");
    await expect(
      compileExecutionContract(db, id, {
        contractId: "XC-BAD",
        workItemId: "WI-1",
        compiledBy: "system-router",
        sopRef: { id: "SOPDEF-1", revision: 9, sha256: SHA },
        fields: contractFields(),
      }),
    ).rejects.toMatchObject({ code: "ERR-SOP-PIN" });
    await expectAudited(id);
  });

  it("pins the contract on activation; a new revision never silently changes a running activation", async () => {
    await requestActivation(db, cmd("act"), {
      activationId: "ACT-1",
      workItemId: "WI-1",
      agentId: "AI-AI-Lead",
      engine: "fake",
      contract: { contractId: "XC-1", revision: 1 },
    });
    await claimActivation(db, cmd("claim"), { activationId: "ACT-1", claimedBy: "AI-AI-Lead" });

    const recompiled = await compileExecutionContract(db, cmd("recompile"), {
      contractId: "XC-1",
      workItemId: "WI-1",
      compiledBy: "system-router",
      sopRef: { id: "SOPDEF-1", revision: 1, sha256: SHA },
      fields: { ...contractFields(), objective: "tạo Project Charter — phạm vi mở rộng" },
    });
    expect(recompiled).toMatchObject({ contractId: "XC-1", revision: 2 });

    const revisions = (await db.execute(sql`
      SELECT revision, state FROM dopaios_execution_contracts WHERE id = 'XC-1' ORDER BY revision
    `)) as unknown as Array<{ revision: number; state: string }>;
    expect(revisions).toEqual([
      { revision: 1, state: "superseded" },
      { revision: 2, state: "active" },
    ]);

    // Phiên đang chạy giữ pin cũ — không đổi âm thầm (FR-63).
    const activation = (await db.execute(sql`
      SELECT state, contract_id, contract_revision FROM dopaios_activations WHERE id = 'ACT-1'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(activation).toEqual([{ state: "RUNNING", contract_id: "XC-1", contract_revision: 1 }]);

    // Lượt đang chạy trên revision cũ có đúng một impact record mở.
    const impacts = (await db.execute(sql`
      SELECT artifact_id, artifact_revision, source, state FROM dopaios_impact_records
      WHERE id = 'IMP-XC-ACT-1-2'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(impacts).toEqual([
      { artifact_id: "XC-1", artifact_revision: 1, source: "contract-revised", state: "open" },
    ]);
  });

  it("refuses activation on a superseded contract revision", async () => {
    const id = cmd("superseded");
    await expect(
      requestActivation(db, id, {
        activationId: "ACT-STALE",
        workItemId: "WI-1",
        agentId: "AI-AI-Lead",
        engine: "fake",
        contract: { contractId: "XC-1", revision: 1 },
      }),
    ).rejects.toMatchObject({ code: "ERR-CONTRACT-STATE" });
    await expectAudited(id);
  });

  it("replay stays byte-identical after contract lifecycle (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
