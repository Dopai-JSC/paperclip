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
  registerApprovedArtifact,
  createSopDefinition,
  publishSopDefinition,
  requestTestRun,
  activateSopRun,
  runFixtureExecution,
  validateSelfCheck,
  reviewFixtureExecution,
  advanceToDecision,
  recordApproval,
  answerClarification,
  type RunApprovalCondition,
} from "../dopaios/commands.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-14 B3 — đủ BỐN outcome của điểm phê duyệt trên trục Phiên bản đầu ra
// (bảng FS-003 d.1599-1603):
//  - approve → APPROVED + mở đúng bước khai (SFR-029);
//  - approve-with-conditions → ACCEPTED + condition theo dõi được (SFR-033),
//    blocks_next_step chặn quyết định (SFR-022);
//  - reject → REJECTED terminal, không mở bước (SFR-045);
//  - reject kèm điểm tái nhập ("yêu cầu sửa") → REJECTED + work-item rework
//    liên kết bản trước, ACCEPTED máy-kiểm cùng transaction (SFR-022/017);
//  - request-more-information → GIỮ AWAITING_DECISION + đúng một Yêu cầu
//    clarification (SFR-046); câu trả lời tạo gói revision mới supersede +
//    đúng một Yêu cầu quyết định mới (SFR-047).
// "Đã nộp"/"đã hoàn thành" không tự sinh "đạt": trạng thái quyết định chỉ đổi
// tại đúng điểm phê duyệt bằng record-approval (PRD Mục 3).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "6".repeat(64);
const SELF_SHA = "7".repeat(64);
const REVIEW_SHA = "8".repeat(64);
let seq = 0;
const cmd = (label: string) => `KC14-B3-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-14 B3 — bốn outcome quyết định trục đầu ra", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  // Dựng một run với phiên bản đầu ra đứng tại AWAITING_DECISION ở T2.
  let runSeq = 0;
  async function outputAtDecision(): Promise<{
    runId: string;
    workItemId: string;
    outputId: string;
    packageId: string;
    requestId: string;
  }> {
    runSeq += 1;
    const runId = `RUN-B3-${runSeq}`;
    const workItemId = `WI-B3-${runSeq}`;
    const outputId = `OUT-${workItemId}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B3" },
      decider: "STAFF-DECIDER",
      pod: "STAFF-POD",
      fixturePackage: { id: "FX-02", sha256: SHA },
    });
    await activateSopRun(db, cmd(`act-${runId}`), { runId, workItemId });
    await runFixtureExecution(db, cmd(`exec-${runId}`), {
      workItemId,
      executor: "AI-BUILD",
      outputId,
      outputRevision: 1,
      contentSha256: SHA,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    await validateSelfCheck(db, cmd(`vsc-${runId}`), {
      outputId,
      outputRevision: 1,
      evidence: { ref: `SC-${outputId}`, sha256: SELF_SHA, targetSha256: SHA, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    await reviewFixtureExecution(db, cmd(`rev-${runId}`), {
      workItemId,
      outputId,
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: { ref: `RE-${outputId}`, sha256: REVIEW_SHA, targetSha256: SHA, conclusion: "ready" },
      expectedReviewSha256: REVIEW_SHA,
    });
    const packageId = `PKG-${runId}`;
    const requestId = `REQ-${runId}`;
    await advanceToDecision(db, cmd(`adv-${runId}`), {
      runId,
      outputId,
      outputRevision: 1,
      packageId,
      packageRevision: 1,
      refs: { outputId, revision: 1, sha256: SHA },
      requestId,
    });
    return { runId, workItemId, outputId, packageId, requestId };
  }

  function approvalPayload(
    fx: Awaited<ReturnType<typeof outputAtDecision>>,
    recordId: string,
    extra?: Record<string, unknown>,
  ) {
    return {
      requestId: fx.requestId,
      recordId,
      packageId: fx.packageId,
      packageRevision: 1,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      ...extra,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b3-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, kind, capabilities] of [
      ["STAFF-DECIDER", "human", ["run-decider"]],
      ["STAFF-POD", "human", ["pod"]],
      ["STAFF-ORCH", "human", ["orchestrator"]],
    ] as const) {
      await registerActor(db, cmd(`a-${actorId}`), {
        actorId,
        kind,
        active: true,
        capabilities: [...capabilities],
      });
    }
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-B3",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B3",
      registeredBy: "STAFF-ORCH",
    });
    await registerApprovedArtifact(db, cmd("sop"), { artifactId: "SOP-B3", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-B3",
      revision: 1,
      sopPin: { artifactId: "SOP-B3", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-B3",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("approve: APPROVED + mở ĐÚNG bước khai theo approval (SFR-029), record pin target ID@revision@hash", async () => {
    const fx = await outputAtDecision();
    const approved = await recordApproval(db, cmd("approve"), {
      ...approvalPayload(fx, `AR-${fx.runId}`),
      openedStep: "T3",
    });
    expect(approved).toMatchObject({ outcome: "approve" });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS output,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step,
        (SELECT target_id FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS target_id,
        (SELECT target_sha256 FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS target_sha
    `)) as unknown as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ output: "APPROVED", step: "open", target_id: fx.outputId, target_sha: SHA });
  });

  it("approve-with-conditions: ACCEPTED + condition theo dõi được; blocks_next_step chặn quyết định (SFR-022/033)", async () => {
    const fx = await outputAtDecision();
    const condition: RunApprovalCondition = {
      conditionId: `CON-${fx.runId}`,
      scope: { area: "tài liệu vận hành" },
      risk: "trung bình",
      owner: "STAFF-POD",
      deadline: "2027-01-01T00:00:00Z",
      closureCriteria: "bổ sung runbook",
      blocksNextStep: false,
    };
    // Condition chặn bước → chặn cả quyết định.
    await expect(
      recordApproval(db, cmd("awc-block"), {
        ...approvalPayload(fx, `AR-${fx.runId}-BLOCK`),
        outcome: "approve-with-conditions",
        conditions: [{ ...condition, blocksNextStep: true }],
      }),
    ).rejects.toMatchObject({ code: "SFR-022" });

    const accepted = await recordApproval(db, cmd("awc-ok"), {
      ...approvalPayload(fx, `AR-${fx.runId}`),
      outcome: "approve-with-conditions",
      conditions: [condition],
      openedStep: "T3",
    });
    expect(accepted).toMatchObject({ outcome: "approve-with-conditions" });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS output,
        (SELECT state FROM dopaios_conditions WHERE id = ${"CON-" + fx.runId}) AS condition,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step
    `)) as unknown as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ output: "ACCEPTED", condition: "open", step: "open" });
  });

  it("reject: REJECTED terminal, KHÔNG mở bước, KHÔNG rework khi không có điểm tái nhập (SFR-045)", async () => {
    const fx = await outputAtDecision();
    const rejected = await recordApproval(db, cmd("reject"), {
      ...approvalPayload(fx, `AR-${fx.runId}`),
      outcome: "reject",
    });
    expect(rejected).toMatchObject({ outcome: "reject", reworkWorkItemId: null });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS output,
        (SELECT count(*)::int FROM dopaios_run_steps WHERE run_id = ${fx.runId}) AS steps,
        (SELECT count(*)::int FROM dopaios_work_items WHERE run_id = ${fx.runId}) AS work_items
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ output: "REJECTED", steps: 0, work_items: 1 });

    // Không đường lùi: REJECTED là bất biến — quyết định lần hai trên cùng
    // revision bị chặn (yêu cầu đã DECIDED).
    await expect(
      recordApproval(db, cmd("reject-again"), approvalPayload(fx, `AR-${fx.runId}-2`)),
    ).rejects.toMatchObject({ code: "SFR-048" });
  });

  it("yêu cầu sửa (reject kèm tái nhập): REJECTED + work-item rework liên kết bản trước, ACCEPTED máy-kiểm (SFR-022)", async () => {
    const fx = await outputAtDecision();
    const reworkId = `${fx.workItemId}-RW`;
    const rejected = await recordApproval(db, cmd("rework"), {
      ...approvalPayload(fx, `AR-${fx.runId}`),
      outcome: "reject",
      reEntryPoint: "T1",
      reworkWorkItemId: reworkId,
    });
    expect(rejected).toMatchObject({ outcome: "reject", reworkWorkItemId: reworkId });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS output,
        (SELECT state FROM dopaios_work_items WHERE id = ${reworkId}) AS rework_state,
        (SELECT rework_of_work_item_id FROM dopaios_work_items WHERE id = ${reworkId}) AS rework_of,
        (SELECT rework_of_output_ref->>'outputId' FROM dopaios_work_items WHERE id = ${reworkId}) AS rework_output,
        (SELECT re_entry_point FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS re_entry,
        (SELECT count(*)::int FROM dopaios_run_steps WHERE run_id = ${fx.runId}) AS steps
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      output: "REJECTED",
      rework_state: "ACCEPTED",
      rework_of: fx.workItemId,
      rework_output: fx.outputId,
      re_entry: "T1",
      steps: 0,
    });
  });

  it("request-more-information: GIỮ AWAITING_DECISION + Yêu cầu clarification; câu trả lời tạo gói revision mới + yêu cầu mới (SFR-046/047)", async () => {
    const fx = await outputAtDecision();
    const clarificationId = `REQ-CLAR-${fx.runId}`;
    const rmi = await recordApproval(db, cmd("rmi"), {
      ...approvalPayload(fx, `AR-${fx.runId}-RMI`),
      outcome: "request-more-information",
      requiredInfo: "cần bổ sung căn cứ đo hiệu năng",
      clarificationRequestId: clarificationId,
    });
    expect(rmi).toMatchObject({ outcome: "request-more-information" });

    const mid = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS output,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${fx.packageId} AND revision = 1) AS pkg,
        (SELECT kind FROM dopaios_action_requests WHERE id = ${clarificationId}) AS clar_kind,
        (SELECT state FROM dopaios_action_requests WHERE id = ${clarificationId}) AS clar_state
    `)) as unknown as Array<Record<string, string>>;
    expect(mid[0]).toEqual({
      output: "AWAITING_DECISION",
      pkg: "AWAITING_INFO",
      clar_kind: "clarification",
      clar_state: "OPEN",
    });

    // Sai người trả lời (không phải Pod-của-run) bị chặn.
    await expect(
      answerClarification(db, cmd("ans-wrong"), {
        clarificationRequestId: clarificationId,
        answer: "x",
        answeredBy: "STAFF-DECIDER",
        packageId: fx.packageId,
        newPackageRevision: 2,
        refs: { outputId: fx.outputId, revision: 1, sha256: SHA },
        newDecisionRequestId: `REQ-${fx.runId}-2`,
        outputId: fx.outputId,
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "SFR-046" });

    const answered = await answerClarification(db, cmd("ans"), {
      clarificationRequestId: clarificationId,
      answer: "căn cứ đo: báo cáo hiệu năng đính kèm, phạm vi rev1",
      answeredBy: "STAFF-POD",
      packageId: fx.packageId,
      newPackageRevision: 2,
      refs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      newDecisionRequestId: `REQ-${fx.runId}-2`,
      outputId: fx.outputId,
      outputRevision: 1,
    });
    expect(answered).toMatchObject({ newPackageRevision: 2 });

    // Quyết định trên gói revision cũ bị chặn — yêu cầu mới pin gói revision
    // mới nên lệch link bắn SFR-048 (B7); ngữ nghĩa "chỉ gói hiện hành nhận
    // quyết định" giữ nguyên.
    await expect(
      recordApproval(db, cmd("old-pkg"), {
        ...approvalPayload(fx, `AR-${fx.runId}-OLD`),
        requestId: `REQ-${fx.runId}-2`,
      }),
    ).rejects.toMatchObject({ code: "SFR-048" });

    // Approve trên gói revision mới → APPROVED.
    const approved = await recordApproval(db, cmd("approve-r2"), {
      requestId: `REQ-${fx.runId}-2`,
      recordId: `AR-${fx.runId}-R2`,
      packageId: fx.packageId,
      packageRevision: 2,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      openedStep: "T3",
    });
    expect(approved).toMatchObject({ outcome: "approve" });
    const final = (await db.execute(
      sql`SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1`,
    )) as unknown as Array<{ state: string }>;
    expect(final[0].state).toBe("APPROVED");
  });

  it("outcome lạ và điều kiện thiếu trường bị chặn fail-closed (SFR-033)", async () => {
    const fx = await outputAtDecision();
    await expect(
      recordApproval(db, cmd("bad-outcome"), {
        ...approvalPayload(fx, `AR-${fx.runId}-BAD`),
        outcome: "duyet-tam" as never,
      }),
    ).rejects.toMatchObject({ code: "ERR-002" });
    await expect(
      recordApproval(db, cmd("awc-missing"), {
        ...approvalPayload(fx, `AR-${fx.runId}-MISS`),
        outcome: "approve-with-conditions",
        conditions: [{ conditionId: "CON-MISS", scope: {}, risk: "x" } as never],
      }),
    ).rejects.toMatchObject({ code: "SFR-033" });
  });

  it("replay rebuilds B3 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
