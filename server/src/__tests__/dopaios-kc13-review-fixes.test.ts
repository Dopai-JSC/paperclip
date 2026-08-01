import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executeCommand,
  replayProjections,
  snapshotProjections,
} from "../dopaios/event-store.ts";
import {
  registerActor,
  createProjectShell,
  registerApprovedArtifact,
  createSopDefinition,
  publishSopDefinition,
  recordApproval,
} from "../dopaios/commands.ts";
import {
  registerStaffAi,
  pinStartupPool,
  proposeTeamManifest,
  approveTeamManifest,
  approveProjectInitiation,
  createProjectWorkItem,
  activateRelease,
  AI_ROLES,
} from "../dopaios/routing.ts";
import { routeWorkItem } from "../dopaios/router.ts";
import { compileExecutionContract } from "../dopaios/contract.ts";
import {
  requestActivation,
  claimActivation,
  completeActivation,
} from "../dopaios/activation.ts";
import { requeueExpiredActivations } from "../dopaios/runner.ts";

// KC-13 B7: các ca kiểm cho finding của vòng review đối kháng — ba blocker
// (thẩm quyền S09, requeue re-check trong transaction, FR-63 bắt buộc) và
// các major (claim re-check hợp đồng + thành viên Manifest hiệu lực, fence
// epoch bắt buộc, một-manifestId-mỗi-(project,stage), write-skew capacity,
// vòng đời delivery/Release sau P0).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B7 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "e".repeat(64);
const TEMPLATE = { template_id: "BOOTSTRAP-PROJECT-TEMPLATE-001", revision: 1, sha256: SHA };
const T0 = Date.UTC(2026, 7, 1, 9, 0, 0);

function roleMap(): Record<string, { primary: string; fallback: string }> {
  return Object.fromEntries(
    AI_ROLES.map((role) => [role, { primary: `AI-${role}`, fallback: `AI-${role}-FB` }]),
  );
}

function contractFields(): Record<string, unknown> {
  return {
    objective: "chạy bước P0",
    scope: "P0",
    inputs: [],
    outputs: [{ id: "OUT", quality: "self-check" }],
    context: [],
    permissions: ["repo-read"],
    tools: ["engine"],
    limits: { timeMs: 60000, costUsd: 1, loops: 1 },
    requiredChecks: ["self-check"],
    requiredEvidence: ["output-hash"],
    stopConditions: ["step-done"],
    escalationEvents: ["missing-input"],
    fallbackPath: "AI-AI-Lead-FB",
  };
}

describeEmbeddedPostgres("dopaios KC-13 B7 — ca kiểm finding review đối kháng", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;
  const cmd = (label: string) => `KC13-B7-${label}-${++seq}`;

  async function expectAudited(commandId: string): Promise<void> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE stream_name = ${"dopaios" + "Audit-" + commandId} AND type = 'CommandRejected'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n, `audit for ${commandId}`).toBe(1);
  }

  async function compileFor(workItemId: string): Promise<void> {
    await compileExecutionContract(db, cmd(`xc-${workItemId}`), {
      contractId: `XC-${workItemId}`,
      workItemId,
      compiledBy: "system-router",
      sopRef: { id: "SOPDEF-B7", revision: 1, sha256: SHA },
      fields: contractFields(),
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b7-");
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
    await registerActor(db, cmd("actor"), {
      actorId: "AI-DECIDER",
      kind: "other",
      active: true,
      capabilities: ["run-decider"],
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
          // AI-Spec primary giữ trần tải 1 cho ca write-skew capacity.
          capacityLimit: id === "AI-AI-Spec" ? 1 : 3,
        });
      }
    }

    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-B7",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-B7-PREP",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await pinStartupPool(db, cmd("pool"), {
      poolId: "POOL-B7",
      actor: "ADMIN-1",
      roles: roleMap(),
      readiness: "ready",
    });
    await proposeTeamManifest(db, cmd("manifest"), {
      manifestId: "TM-B7",
      stage: "bootstrap",
      projectId: "PRJ-B7",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-B7", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: Object.fromEntries(AI_ROLES.map((r) => [r, 5])),
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await approveTeamManifest(db, cmd("approve"), { manifestId: "TM-B7", revision: 1, actor: "ORCH-1" });
    await approveProjectInitiation(db, cmd("p0"), {
      projectId: "PRJ-B7",
      actor: "ORCH-1",
      initiationRequest: { id: "PIR-B7", sha256: SHA },
      manifestId: "TM-B7",
      manifestRevision: 1,
    });

    await registerApprovedArtifact(db, cmd("sop-art"), {
      artifactId: "SOP-ART-B7",
      revision: 1,
      sha256: SHA,
    });
    await createSopDefinition(db, cmd("sop-def"), {
      definitionId: "SOPDEF-B7",
      revision: 1,
      sopPin: { artifactId: "SOP-ART-B7", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("sop-pub"), {
      definitionId: "SOPDEF-B7",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("blocker 1 — record-approval đòi đúng người quyết được pin, là actor người active (SFR-023/SFR-042)", async () => {
    // Seed một run pin decider AI + một Yêu cầu quyết định (event-level —
    // guard thẩm quyền đứng TRƯỚC guard package nên không cần trọn chuỗi).
    await executeCommand(db, {
      commandId: cmd("seed-run"),
      payload: { seed: "authority" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosSopRun-RUN-B7",
          type: "TestRunRequested",
          data: {
            runId: "RUN-B7",
            definitionRef: { definitionId: "SOPDEF-B7" },
            decider: "AI-DECIDER",
            pod: "POD-1",
            fixturePackage: { id: "FX-02", sha256: SHA },
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosActionRequest-REQ-B7",
          type: "ActionRequestCreated",
          data: { requestId: "REQ-B7", kind: "decision", runId: "RUN-B7" },
          expectedVersion: -1,
        });
        return { seeded: true };
      },
    });

    const base = {
      requestId: "REQ-B7",
      recordId: "AR-B7",
      packageId: "PKG-B7",
      packageRevision: 1,
      pinnedRefs: {},
      outputId: "OUT-B7",
      outputRevision: 1,
    };

    // Actor không phải decider được pin.
    await expect(
      recordApproval(db, cmd("wrong-decider"), { ...base, actor: "ORCH-1" }),
    ).rejects.toMatchObject({ code: "SFR-042" });
    // Decider được pin nhưng là AI.
    await expect(
      recordApproval(db, cmd("ai-decider"), { ...base, actor: "AI-DECIDER" }),
    ).rejects.toMatchObject({ code: "SFR-023" });
  });

  it("blocker 2 — requeue re-check trong transaction: không hồi sinh activation đã DONE", async () => {
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-B7-DONE",
      projectId: "PRJ-B7",
      role: "AI-Lead",
    });
    await routeWorkItem(db, cmd("route"), { workItemId: "WI-B7-DONE" });
    await compileFor("WI-B7-DONE");
    await requestActivation(db, cmd("req"), {
      activationId: "ACT-B7-DONE",
      workItemId: "WI-B7-DONE",
      agentId: "AI-AI-Lead",
      engine: "fake",
      contract: { contractId: "XC-WI-B7-DONE", revision: 1 },
    });
    await claimActivation(db, cmd("claim"), {
      activationId: "ACT-B7-DONE",
      claimedBy: "AI-AI-Lead",
      lease: { untilMs: T0 + 10_000 },
    });
    // Claimer thật hoàn tất TRƯỚC khi watchdog kịp thu hồi.
    await completeActivation(db, cmd("done"), {
      activationId: "ACT-B7-DONE",
      outcome: "succeeded",
      leaseEpoch: 0,
    });

    // Watchdog quét với danh sách cũ (ngoài transaction) — lệnh requeue phải
    // tự re-check và từ chối, không đưa DONE về QUEUED.
    const actions = await requeueExpiredActivations(db, { nowMs: T0 + 60_000 });
    expect(actions).toEqual([]);
    const row = (await db.execute(sql`
      SELECT state, lease_epoch FROM dopaios_activations WHERE id = 'ACT-B7-DONE'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row).toEqual([{ state: "DONE", lease_epoch: 0 }]);
  });

  it("major — fence epoch bắt buộc trên activation có lease: complete không kèm epoch bị chặn", async () => {
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-B7-FENCE",
      projectId: "PRJ-B7",
      role: "AI-Build",
    });
    await routeWorkItem(db, cmd("route"), { workItemId: "WI-B7-FENCE" });
    await compileFor("WI-B7-FENCE");
    await requestActivation(db, cmd("req"), {
      activationId: "ACT-B7-FENCE",
      workItemId: "WI-B7-FENCE",
      agentId: "AI-AI-Build",
      engine: "fake",
      contract: { contractId: "XC-WI-B7-FENCE", revision: 1 },
    });
    await claimActivation(db, cmd("claim"), {
      activationId: "ACT-B7-FENCE",
      claimedBy: "AI-AI-Build",
      lease: { untilMs: T0 + 120_000 },
    });
    await expect(
      completeActivation(db, cmd("no-epoch"), {
        activationId: "ACT-B7-FENCE",
        outcome: "succeeded",
      }),
    ).rejects.toMatchObject({ code: "ERR-LEASE-EPOCH" });
    await completeActivation(db, cmd("with-epoch"), {
      activationId: "ACT-B7-FENCE",
      outcome: "succeeded",
      leaseEpoch: 0,
    });
  });

  it("major — cửa sổ request→claim: pin hợp đồng bị supersede thì claim bị chặn", async () => {
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-B7-STALE",
      projectId: "PRJ-B7",
      role: "AI-Test",
    });
    await routeWorkItem(db, cmd("route"), { workItemId: "WI-B7-STALE" });
    await compileFor("WI-B7-STALE");
    await requestActivation(db, cmd("req"), {
      activationId: "ACT-B7-STALE",
      workItemId: "WI-B7-STALE",
      agentId: "AI-AI-Test",
      engine: "fake",
      contract: { contractId: "XC-WI-B7-STALE", revision: 1 },
    });
    // Hợp đồng được biên dịch lại trong lúc activation còn QUEUED.
    await compileExecutionContract(db, cmd("recompile"), {
      contractId: "XC-WI-B7-STALE",
      workItemId: "WI-B7-STALE",
      compiledBy: "system-router",
      sopRef: { id: "SOPDEF-B7", revision: 1, sha256: SHA },
      fields: { ...contractFields(), objective: "phạm vi đổi" },
    });
    const id = cmd("claim-stale-pin");
    await expect(
      claimActivation(db, id, { activationId: "ACT-B7-STALE", claimedBy: "AI-AI-Test" }),
    ).rejects.toMatchObject({ code: "ERR-CONTRACT-STATE" });
    await expectAudited(id);
  });

  it("major — đổi đội giữa chừng: claimer không còn trong danh sách pin của Manifest hiệu lực bị chặn", async () => {
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-B7-SWAP",
      projectId: "PRJ-B7",
      role: "AI-Reviewer",
    });
    await routeWorkItem(db, cmd("route"), { workItemId: "WI-B7-SWAP" });
    await compileFor("WI-B7-SWAP");
    await requestActivation(db, cmd("req"), {
      activationId: "ACT-B7-SWAP",
      workItemId: "WI-B7-SWAP",
      agentId: "AI-AI-Reviewer",
      engine: "fake",
      contract: { contractId: "XC-WI-B7-SWAP", revision: 1 },
    });
    // Orchestrator đổi đội: revision mới loại AI-AI-Reviewer khỏi vai.
    const swapped = roleMap();
    swapped["AI-Reviewer"] = { primary: "AI-AI-Reviewer-FB", fallback: "AI-AI-Reviewer-FB" };
    await proposeTeamManifest(db, cmd("propose-swap"), {
      manifestId: "TM-B7",
      stage: "bootstrap",
      projectId: "PRJ-B7",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-B7", revision: 1 },
      roleAssignments: swapped,
      pod: "POD-1",
      capacity: Object.fromEntries(AI_ROLES.map((r) => [r, 5])),
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await approveTeamManifest(db, cmd("approve-swap"), {
      manifestId: "TM-B7",
      revision: 2,
      actor: "ORCH-1",
    });
    const id = cmd("claim-removed");
    await expect(
      claimActivation(db, id, { activationId: "ACT-B7-SWAP", claimedBy: "AI-AI-Reviewer" }),
    ).rejects.toMatchObject({ code: "ERR-OUTSIDE-MANIFEST" });
    await expectAudited(id);
  });

  it("major — một manifestId cho mỗi (project, stage): id thứ hai bị chặn từ cửa", async () => {
    const id = cmd("dup-manifest");
    await expect(
      proposeTeamManifest(db, id, {
        manifestId: "TM-B7-KHAC",
        stage: "bootstrap",
        projectId: "PRJ-B7",
        actor: "ORCH-1",
        poolRef: { poolId: "POOL-B7", revision: 1 },
        roleAssignments: roleMap(),
        pod: "POD-1",
        capacity: Object.fromEntries(AI_ROLES.map((r) => [r, 5])),
        permissions: ["repo-read"],
        resources: ["workspace"],
        routingRules: { mode: "manifest-pinned" },
        sha256: SHA,
      }),
    ).rejects.toMatchObject({ code: "ERR-MANIFEST-DUP" });
    await expectAudited(id);
  });

  it("major — write-skew capacity: hai claim đồng thời cùng Staff trần 1, đúng một bên thắng", async () => {
    for (const suffix of ["R1", "R2"] as const) {
      await createProjectWorkItem(db, cmd("wi"), {
        workItemId: `WI-B7-${suffix}`,
        projectId: "PRJ-B7",
        role: "AI-Spec",
      });
      await routeWorkItem(db, cmd("route"), { workItemId: `WI-B7-${suffix}` });
      await compileFor(`WI-B7-${suffix}`);
      await requestActivation(db, cmd("req"), {
        activationId: `ACT-B7-${suffix}`,
        workItemId: `WI-B7-${suffix}`,
        agentId: "AI-AI-Spec",
        engine: "fake",
        contract: { contractId: `XC-WI-B7-${suffix}`, revision: 1 },
      });
    }
    const results = await Promise.allSettled([
      claimActivation(db, cmd("race-1"), {
        activationId: "ACT-B7-R1",
        claimedBy: "AI-AI-Spec",
        lease: { untilMs: T0 + 120_000 },
      }),
      claimActivation(db, cmd("race-2"), {
        activationId: "ACT-B7-R2",
        claimedBy: "AI-AI-Spec",
        lease: { untilMs: T0 + 120_000 },
      }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    expect(wins).toBe(1);
    const running = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_activations
      WHERE claimed_by = 'AI-AI-Spec' AND state = 'RUNNING'
    `)) as unknown as Array<{ n: number }>;
    expect(running[0].n).toBe(1);
  });

  it("minor — delivery manifest và Release đều đòi Project đã qua P0-01", async () => {
    const proposeId = cmd("delivery-prep");
    await expect(
      proposeTeamManifest(db, proposeId, {
        manifestId: "TM-B7-PREP-DLV",
        stage: "delivery",
        projectId: "PRJ-B7-PREP",
        actor: "ORCH-1",
        poolRef: { poolId: "POOL-B7", revision: 1 },
        roleAssignments: roleMap(),
        pod: "POD-1",
        capacity: Object.fromEntries(AI_ROLES.map((r) => [r, 5])),
        permissions: ["repo-read"],
        resources: ["workspace"],
        routingRules: { mode: "manifest-pinned" },
        sha256: SHA,
      }),
    ).rejects.toMatchObject({ code: "ERR-PROJECT-STATE" });
    await expectAudited(proposeId);

    const releaseId = cmd("release-prep");
    await expect(
      activateRelease(db, releaseId, {
        projectId: "PRJ-B7-PREP",
        releaseId: "REL-PREP",
        actor: "ORCH-1",
      }),
    ).rejects.toMatchObject({ code: "ERR-PROJECT-STATE" });
    await expectAudited(releaseId);
  });

  it("replay stays byte-identical after the review-fix battery (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
