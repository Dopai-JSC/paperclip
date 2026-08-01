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
  requestTestRun,
  activateSopRun,
  recordApproval,
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
import { routeWorkItem } from "../dopaios/router.ts";
import { compileExecutionContract } from "../dopaios/contract.ts";
import {
  requestActivation,
  claimActivation,
  completeActivation,
} from "../dopaios/activation.ts";
import { FakeEngine } from "../dopaios/engine.ts";
import {
  runnerTick,
  runUntilQuiescent,
  requeueExpiredActivations,
  type RunnerFixtureConfig,
  type RunnerProjectConfig,
} from "../dopaios/runner.ts";
import { qualityContractContentSha256 } from "../dopaios/lifecycle.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";

// KC-13 B5: runner tick — AC-NFR-3.1 (work-item đủ điều kiện tự kích hoạt/
// chuyển tiếp, 0 thao tác người trong đoạn máy-kiểm), SFR-011 (kích hoạt
// đúng-một-lần theo run ID dưới retry), SFR-014 (dừng đúng điểm cần người,
// không tự phê duyệt), FX-02 N15 (run CANCELLED không nhận thêm lệnh),
// lease TTL + requeue mồ côi với epoch chặn claimer cũ ghi muộn.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "c".repeat(64);
const SELF_SHA = "d".repeat(64);
const REVIEW_SHA = "e".repeat(64);
const TEMPLATE = { template_id: "BOOTSTRAP-PROJECT-TEMPLATE-001", revision: 1, sha256: SHA };
const T0 = Date.UTC(2026, 7, 1, 8, 0, 0);

// KC-14: chuỗi đầu ra phân rã — fixture config mang pin Hợp đồng chất lượng
// và hash bằng chứng self-check/review (seed trong beforeAll).
const QC_CHECKS = ["self-check", "independent-review"];
const QC_REF = {
  id: "QC-KC13-B5",
  revision: 1,
  sha256: qualityContractContentSha256({ outputType: "code-change", requiredChecks: QC_CHECKS }),
};

const FIXTURE: RunnerFixtureConfig = {
  executor: "FX-EXECUTOR",
  reviewer: "FX-REVIEWER",
  contentSha256: SHA,
  outputType: "code-change",
  qualityContractRef: QC_REF,
  selfCheckSha256: SELF_SHA,
  reviewSha256: REVIEW_SHA,
};

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

function roleMap(): Record<string, { primary: string; fallback: string }> {
  return Object.fromEntries(
    AI_ROLES.map((role) => [role, { primary: `AI-${role}`, fallback: `AI-${role}-FB` }]),
  );
}

describeEmbeddedPostgres("dopaios KC-13 B5 — runner tick + lease requeue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;
  const cmd = (label: string) => `KC13-B5-${label}-${++seq}`;

  const PROJECT_CFG: RunnerProjectConfig = {
    engine: () => new FakeEngine(),
    sopRef: { id: "SOPDEF-B5", revision: 1, sha256: SHA },
    contractFields: contractFields(),
    steps: ["draft", "finalize"],
    leaseMs: 60_000,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b5-");
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
      actorId: "DECIDER-1",
      kind: "human",
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
          capacityLimit: 3,
        });
      }
    }

    // Nền FX-02: SOP artifact approved → definition published → run test S04.
    await registerApprovedArtifact(db, cmd("sop-art"), {
      artifactId: "SOP-ART-B5",
      revision: 1,
      sha256: SHA,
    });
    await createSopDefinition(db, cmd("sop-def"), {
      definitionId: "SOPDEF-B5",
      revision: 1,
      sopPin: { artifactId: "SOP-ART-B5", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("sop-pub"), {
      definitionId: "SOPDEF-B5",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
    await requestTestRun(db, cmd("run"), {
      runId: "RUN-B5",
      definitionRef: { definitionId: "SOPDEF-B5" },
      decider: "DECIDER-1",
      pod: "POD-1",
      fixturePackage: { id: "FX-02", sha256: SHA },
    });
    // KC-14: chuỗi đầu ra phân rã đòi pin Hợp đồng chất lượng lúc nộp.
    await seedApprovedQualityContract(db, {
      id: QC_REF.id,
      outputType: "code-change",
      requiredChecks: QC_CHECKS,
      cmdPrefix: "KC13-B5",
    });

    // Nền Project cho đường kích hoạt AI: shell → pool → manifest → P0-01.
    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-B5",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await pinStartupPool(db, cmd("pool"), {
      poolId: "POOL-B5",
      actor: "ADMIN-1",
      roles: roleMap(),
      readiness: "ready",
    });
    await proposeTeamManifest(db, cmd("manifest"), {
      manifestId: "TM-B5",
      stage: "bootstrap",
      projectId: "PRJ-B5",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-B5", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: Object.fromEntries(AI_ROLES.map((r) => [r, 3])),
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await approveTeamManifest(db, cmd("approve"), { manifestId: "TM-B5", revision: 1, actor: "ORCH-1" });
    await approveProjectInitiation(db, cmd("p0"), {
      projectId: "PRJ-B5",
      actor: "ORCH-1",
      initiationRequest: { id: "PIR-B5", sha256: SHA },
      manifestId: "TM-B5",
      manifestRevision: 1,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("drives S05→S08 automatically and STOPS at the decision point (AC-NFR-3.1 + SFR-014)", async () => {
    const { actions } = await runUntilQuiescent(db, { nowMs: T0, fixture: FIXTURE });

    const fired = actions.filter((a) => a.outcome === "ok").map((a) => a.command);
    expect(fired).toEqual([
      "activate-sop-run",
      "run-fixture-execution",
      "validate-self-check",
      "run-fixture-review",
      "advance-to-decision",
    ]);
    // Runner không bao giờ là actor của record-approval (SFR-023).
    expect(fired).not.toContain("record-approval");

    const run = (await db.execute(
      sql`SELECT state FROM dopaios_sop_runs WHERE id = 'RUN-B5'`,
    )) as unknown as Array<{ state: string }>;
    expect(run[0].state).toBe("RUNNING");

    const request = (await db.execute(
      sql`SELECT kind, state FROM dopaios_action_requests WHERE id = 'REQ-RUN-B5'`,
    )) as unknown as Array<{ kind: string; state: string }>;
    expect(request).toEqual([{ kind: "decision", state: "OPEN" }]);

    const output = (await db.execute(
      sql`SELECT state FROM dopaios_output_versions WHERE id = 'OUT-RUN-B5-T1'`,
    )) as unknown as Array<{ state: string }>;
    expect(output[0].state).toBe("AWAITING_DECISION");
  });

  it("activation is exactly-once per run under retry (SFR-011)", async () => {
    // Cùng command id → idempotent replay, không sinh work-item thứ hai.
    const replay = await activateSopRun(db, "AUTO-ACT-RUN-B5", {
      runId: "RUN-B5",
      workItemId: "RUN-B5-T1",
    });
    expect(replay).toMatchObject({ idempotentReplay: true });

    // Command id KHÁC vẫn bị guard trạng thái chặn — run không NOT_ACTIVATED.
    await expect(
      activateSopRun(db, cmd("re-activate"), { runId: "RUN-B5", workItemId: "RUN-B5-T2" }),
    ).rejects.toMatchObject({ code: "SFR-011" });

    const workItems = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_work_items WHERE run_id = 'RUN-B5'
    `)) as unknown as Array<{ n: number }>;
    expect(workItems[0].n).toBe(1);
  });

  it("resumes automatically after the human decision and closes the run (S09 → S10)", async () => {
    // S09 — hành động CHÍNH SÁCH của người quyết được pin (không tính vào
    // nhóm can-thiệp-vì-lỗi theo AC-V1-04).
    await recordApproval(db, cmd("s09"), {
      requestId: "REQ-RUN-B5",
      recordId: "APR-RUN-B5",
      packageId: "PKG-RUN-B5",
      packageRevision: 1,
      pinnedRefs: { outputId: "OUT-RUN-B5-T1", revision: 1, sha256: SHA },
      actor: "DECIDER-1",
      outputId: "OUT-RUN-B5-T1",
      outputRevision: 1,
    });

    const { actions } = await runUntilQuiescent(db, { nowMs: T0 + 1_000, fixture: FIXTURE });
    expect(actions.filter((a) => a.outcome === "ok").map((a) => a.command)).toEqual([
      "complete-sop-run",
    ]);
    const run = (await db.execute(
      sql`SELECT state FROM dopaios_sop_runs WHERE id = 'RUN-B5'`,
    )) as unknown as Array<{ state: string }>;
    expect(run[0].state).toBe("COMPLETED");
  });

  it("fires nothing at a CANCELLED run (FX-02 N15)", async () => {
    await requestTestRun(db, cmd("run-cxl"), {
      runId: "RUN-CXL",
      definitionRef: { definitionId: "SOPDEF-B5" },
      decider: "DECIDER-1",
      pod: "POD-1",
      fixturePackage: { id: "FX-02", sha256: SHA },
    });
    await executeCommand(db, {
      commandId: cmd("cancel"),
      payload: { runId: "RUN-CXL" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosSopRun-RUN-CXL",
          type: "SopRunStateChanged",
          data: { runId: "RUN-CXL", state: "CANCELLED" },
        });
        return { runId: "RUN-CXL", state: "CANCELLED" };
      },
    });

    const actions = await runnerTick(db, { nowMs: T0 + 2_000, fixture: FIXTURE });
    expect(actions.filter((a) => a.target === "RUN-CXL")).toEqual([]);
    const run = (await db.execute(
      sql`SELECT state FROM dopaios_sop_runs WHERE id = 'RUN-CXL'`,
    )) as unknown as Array<{ state: string }>;
    expect(run[0].state).toBe("CANCELLED");
  });

  it("activates a Project work item end-to-end with zero human actions (route → contract → claim → engine → done)", async () => {
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-AUTO",
      projectId: "PRJ-B5",
      role: "AI-Lead",
    });

    const { actions } = await runUntilQuiescent(db, { nowMs: T0 + 3_000, project: PROJECT_CFG });
    const fired = actions.filter((a) => a.outcome === "ok").map((a) => a.command);
    expect(fired).toEqual([
      "route-work-item",
      "compile-contract",
      "request-activation",
      "claim-activation",
      "complete-activation",
    ]);

    const activation = (await db.execute(sql`
      SELECT state, claimed_by, contract_id, contract_revision, lease_epoch
      FROM dopaios_activations WHERE id = 'ACT-WI-AUTO'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(activation).toEqual([
      {
        state: "DONE",
        claimed_by: "AI-AI-Lead",
        contract_id: "XC-WI-AUTO",
        contract_revision: 1,
        lease_epoch: 0,
      },
    ]);

    const session = (await db.execute(sql`
      SELECT state, outcome FROM dopaios_ai_sessions WHERE id = 'SES-ACT-WI-AUTO-e0'
    `)) as unknown as Array<{ state: string; outcome: string }>;
    expect(session).toEqual([{ state: "TERMINAL", outcome: "succeeded" }]);
  });

  it("requeues an orphaned lease and fences the stale claimer by epoch", async () => {
    await createProjectWorkItem(db, cmd("wi-dead"), {
      workItemId: "WI-DEAD",
      projectId: "PRJ-B5",
      role: "AI-Spec",
    });
    await routeWorkItem(db, cmd("route-dead"), { workItemId: "WI-DEAD" });
    await compileExecutionContract(db, cmd("xc-dead"), {
      contractId: "XC-WI-DEAD",
      workItemId: "WI-DEAD",
      compiledBy: "dopaios-runner",
      sopRef: { id: "SOPDEF-B5", revision: 1, sha256: SHA },
      fields: contractFields(),
    });
    await requestActivation(db, cmd("req-dead"), {
      activationId: "ACT-WI-DEAD",
      workItemId: "WI-DEAD",
      agentId: "AI-AI-Spec",
      engine: "fake",
      contract: { contractId: "XC-WI-DEAD", revision: 1 },
    });
    // Claimer "chết": claim với lease ngắn rồi không bao giờ hoàn tất.
    await claimActivation(db, cmd("claim-dead"), {
      activationId: "ACT-WI-DEAD",
      claimedBy: "AI-AI-Spec",
      lease: { untilMs: T0 + 10_000 },
    });

    // Trước hạn lease: không thu hồi.
    expect(await requeueExpiredActivations(db, { nowMs: T0 + 9_999 })).toEqual([]);

    // Quá hạn: thu hồi về QUEUED, epoch tăng; chạy lặp là idempotent replay.
    const first = await requeueExpiredActivations(db, { nowMs: T0 + 60_000 });
    expect(first).toEqual([{ command: "requeue-activation", target: "ACT-WI-DEAD", outcome: "ok" }]);
    await requeueExpiredActivations(db, { nowMs: T0 + 60_000 });
    const requeued = (await db.execute(sql`
      SELECT state, claimed_by, lease_epoch FROM dopaios_activations WHERE id = 'ACT-WI-DEAD'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(requeued).toEqual([{ state: "QUEUED", claimed_by: null, lease_epoch: 1 }]);

    // Claimer cũ ghi muộn khi activation đã về hàng đợi → chặn theo trạng thái.
    await expect(
      completeActivation(db, cmd("stale-queued"), {
        activationId: "ACT-WI-DEAD",
        outcome: "succeeded",
        leaseEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: "ERR-ACTIVATION-STATE" });

    // Giao lại ở epoch mới, rồi claimer cũ ghi muộn → chặn theo epoch.
    await claimActivation(db, cmd("reclaim"), {
      activationId: "ACT-WI-DEAD",
      claimedBy: "AI-AI-Spec",
      lease: { untilMs: T0 + 120_000 },
    });
    await expect(
      completeActivation(db, cmd("stale-epoch"), {
        activationId: "ACT-WI-DEAD",
        outcome: "succeeded",
        leaseEpoch: 0,
      }),
    ).rejects.toMatchObject({ code: "ERR-LEASE-EPOCH" });

    const done = await completeActivation(db, cmd("done-dead"), {
      activationId: "ACT-WI-DEAD",
      outcome: "succeeded",
      leaseEpoch: 1,
    });
    expect(done).toMatchObject({ activationId: "ACT-WI-DEAD", state: "DONE" });
  });

  it("replay stays byte-identical after runner-driven history (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
