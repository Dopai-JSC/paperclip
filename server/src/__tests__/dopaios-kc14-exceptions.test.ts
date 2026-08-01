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
} from "../dopaios/commands.ts";
import { submitFixtureRevision } from "../dopaios/revisions.ts";
import {
  detectOverdueRunConditions,
  decideRunException,
  cancelTestRun,
} from "../dopaios/exceptions.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-14 B5 — hai hàng `ACCEPTED` của bảng đầu ra FS-003 (SFR-034) và hủy run
// (SFR-041/051/057, FX-02-N15) trên trục đầu ra:
//  - condition quá hạn: revision GIỮ ACCEPTED (lifecycle không viết lại),
//    approval hết hiệu lực, bước tái chặn (SFR-050), Gói EXCEPTION target
//    chính phiên bản + đúng một Yêu cầu exception; tick idempotent;
//  - quyết định trên Gói EXCEPTION: approve tái xác nhận (disposition BẮT
//    BUỘC cùng transaction, mở lại đúng bước); reject chấm dứt hiệu lực
//    chấp nhận (không mở bước, không điểm tái nhập — đường tiếp là bản
//    sửa); RMI + câu trả lời tạo Gói EXCEPTION revision mới (SFR-047);
//  - hủy run: nguyên tử, thiếu MỘT disposition là thất bại; work-item
//    CANCELLED không tính sản lượng; phiên bản GIỮ NGUYÊN trạng thái; sau
//    hủy mọi lệnh trên record thuộc run bị từ chối và watchdog ngừng.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "e5".repeat(32);
const SHA_REV2 = "f6".repeat(32);
const SELF_SHA = "a7".repeat(32);
const REVIEW_SHA = "b8".repeat(32);
const DEADLINE = "2026-08-02T00:00:00Z";
const AFTER_DEADLINE = Date.UTC(2026, 7, 3, 0, 0, 0);
let seq = 0;
const cmd = (label: string) => `KC14-B5-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-14 B5 — EXCEPTION quá hạn + hủy run trên trục đầu ra", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  let runSeq = 0;
  async function outputAtDecision(): Promise<{
    runId: string;
    workItemId: string;
    outputId: string;
    packageId: string;
    requestId: string;
  }> {
    runSeq += 1;
    const runId = `RUN-B5-${runSeq}`;
    const workItemId = `WI-B5-${runSeq}`;
    const outputId = `OUT-${workItemId}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B5" },
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

  // ACCEPTED có điều kiện với deadline đã chọn + bước T3 mở theo approval.
  async function acceptedWithCondition(): Promise<
    Awaited<ReturnType<typeof outputAtDecision>> & { conditionId: string; recordId: string }
  > {
    const fx = await outputAtDecision();
    const conditionId = `CON-${fx.runId}`;
    const recordId = `AR-${fx.runId}`;
    await recordApproval(db, cmd(`awc-${fx.runId}`), {
      requestId: fx.requestId,
      recordId,
      packageId: fx.packageId,
      packageRevision: 1,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      outcome: "approve-with-conditions",
      conditions: [
        {
          conditionId,
          scope: { area: "phần phụ thuộc condition" },
          risk: "trung bình",
          owner: "STAFF-POD",
          deadline: DEADLINE,
          closureCriteria: "bổ sung bằng chứng vận hành",
          blocksNextStep: false,
        },
      ],
      openedStep: "T3",
    });
    return { ...fx, conditionId, recordId };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b5-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, capabilities] of [
      ["STAFF-DECIDER", ["run-decider"]],
      ["STAFF-POD", ["pod"]],
      ["STAFF-ORCH", ["orchestrator"]],
    ] as const) {
      await registerActor(db, cmd(`a-${actorId}`), {
        actorId,
        kind: "human",
        active: true,
        capabilities: [...capabilities],
      });
    }
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-B5",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B5",
      registeredBy: "STAFF-ORCH",
    });
    await registerApprovedArtifact(db, cmd("sop"), { artifactId: "SOP-B5X", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-B5",
      revision: 1,
      sopPin: { artifactId: "SOP-B5X", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-B5",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("SFR-034: quá hạn → ACCEPTED giữ nguyên, approval treo, bước tái chặn, Gói EXCEPTION + Yêu cầu exception; tick idempotent", async () => {
    const fx = await acceptedWithCondition();
    const declared = await detectOverdueRunConditions(db, { nowMs: AFTER_DEADLINE });
    expect(declared).toContainEqual({
      conditionId: fx.conditionId,
      exceptionPackageId: `EXC-RUN-${fx.conditionId}`,
    });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS version,
        (SELECT (invalidated_at IS NOT NULL) FROM dopaios_approval_records WHERE id = ${fx.recordId}) AS invalidated,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step,
        (SELECT state FROM dopaios_conditions WHERE id = ${fx.conditionId}) AS condition,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${"EXC-RUN-" + fx.conditionId} AND revision = 1) AS exc_pkg,
        (SELECT target->>'outputId' FROM dopaios_decision_packages WHERE id = ${"EXC-RUN-" + fx.conditionId} AND revision = 1) AS exc_target,
        (SELECT kind FROM dopaios_action_requests WHERE id = ${"REQ-EXC-RUN-" + fx.conditionId}) AS req_kind
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      version: "ACCEPTED",
      invalidated: true,
      step: "reblocked",
      condition: "overdue",
      exc_pkg: "OPEN",
      exc_target: fx.outputId,
      req_kind: "exception",
    });

    // Tick lặp: approval đã treo → không tuyên bố lần hai, không gói kép.
    const second = await detectOverdueRunConditions(db, { nowMs: AFTER_DEADLINE + 60_000 });
    expect(second.filter((d) => d.conditionId === fx.conditionId)).toEqual([]);

    // approve tái xác nhận: disposition BẮT BUỘC — thiếu là chặn (SFR-034).
    await expect(
      decideRunException(db, cmd("exc-nodisp"), {
        packageId: `EXC-RUN-${fx.conditionId}`,
        outcome: "approve",
        actor: "STAFF-DECIDER",
        recordId: `AR-EXC-${fx.runId}`,
      }),
    ).rejects.toMatchObject({ code: "SFR-034" });

    const approved = await decideRunException(db, cmd("exc-approve"), {
      packageId: `EXC-RUN-${fx.conditionId}`,
      outcome: "approve",
      actor: "STAFF-DECIDER",
      recordId: `AR-EXC-${fx.runId}`,
      disposition: {
        kind: "replace",
        condition: {
          conditionId: `${fx.conditionId}-R2`,
          scope: { area: "phần phụ thuộc condition" },
          risk: "trung bình",
          owner: "STAFF-POD",
          deadline: "2027-06-01T00:00:00Z",
          closureCriteria: "bổ sung bằng chứng vận hành theo mốc mới",
          blocksNextStep: false,
        },
      },
    });
    expect(approved).toMatchObject({ outcome: "approve", versionState: "ACCEPTED" });

    const after = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_conditions WHERE id = ${fx.conditionId}) AS old_condition,
        (SELECT state FROM dopaios_conditions WHERE id = ${fx.conditionId + "-R2"}) AS new_condition,
        (SELECT record_id FROM dopaios_conditions WHERE id = ${fx.conditionId + "-R2"}) AS new_record,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step,
        (SELECT opened_by_record_id FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step_record
    `)) as unknown as Array<Record<string, unknown>>;
    expect(after[0]).toEqual({
      old_condition: "closed",
      new_condition: "open",
      new_record: `AR-EXC-${fx.runId}`,
      step: "open", // mở lại ĐÚNG bước bị tái chặn (SFR-029)
      step_record: `AR-EXC-${fx.runId}`,
    });
  });

  it("reject trên Gói EXCEPTION: chấm dứt hiệu lực chấp nhận — ACCEPTED giữ nguyên, bước KHÔNG mở lại, đường tiếp là bản sửa", async () => {
    const fx = await acceptedWithCondition();
    await detectOverdueRunConditions(db, { nowMs: AFTER_DEADLINE });
    const rejected = await decideRunException(db, cmd("exc-reject"), {
      packageId: `EXC-RUN-${fx.conditionId}`,
      outcome: "reject",
      actor: "STAFF-DECIDER",
      recordId: `AR-EXC-${fx.runId}`,
    });
    expect(rejected).toMatchObject({ outcome: "reject", versionState: "ACCEPTED" });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS version,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step,
        (SELECT state FROM dopaios_conditions WHERE id = ${fx.conditionId}) AS condition,
        (SELECT re_entry_point FROM dopaios_approval_records WHERE id = ${"AR-EXC-" + fx.runId}) AS re_entry
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      version: "ACCEPTED",
      step: "reblocked",
      condition: "closed",
      re_entry: null,
    });

    // Đường tiếp là bản sửa: submit-fixture-revision trên ACCEPTED đi được.
    const revision = await submitFixtureRevision(db, cmd("srv"), {
      outputId: fx.outputId,
      newRevision: 2,
      contentSha256: SHA_REV2,
      outputType: "code-change",
      qualityContractRef: qcRef,
      selfCheckEvidence: { ref: "SC-R2", sha256: SELF_SHA, targetSha256: SHA_REV2, by: "AI-BUILD" },
      expectedSelfCheckSha256: SELF_SHA,
      reviewEvidence: {
        ref: "RE-R2",
        sha256: REVIEW_SHA,
        targetSha256: SHA_REV2,
        conclusion: "ready",
        by: "AI-REVIEWER",
      },
      expectedReviewSha256: REVIEW_SHA,
    });
    expect(revision).toMatchObject({ newRevision: 2, state: "CHECK_PASSED" });
  });

  it("RMI trên Gói EXCEPTION: không đổi hiệu lực; câu trả lời tạo Gói EXCEPTION revision mới + Yêu cầu exception mới (SFR-046/047)", async () => {
    const fx = await acceptedWithCondition();
    await detectOverdueRunConditions(db, { nowMs: AFTER_DEADLINE });
    const excPackageId = `EXC-RUN-${fx.conditionId}`;
    const clarificationId = `REQ-CLAR-${fx.runId}`;
    await decideRunException(db, cmd("exc-rmi"), {
      packageId: excPackageId,
      outcome: "request-more-information",
      actor: "STAFF-DECIDER",
      recordId: `AR-EXC-${fx.runId}-RMI`,
      requiredInfo: "cần căn cứ vì sao condition trễ và kế hoạch bù",
      clarificationRequestId: clarificationId,
    });

    const mid = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_decision_packages WHERE id = ${excPackageId} AND revision = 1) AS pkg1,
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS version,
        (SELECT kind FROM dopaios_action_requests WHERE id = ${clarificationId}) AS clar_kind
    `)) as unknown as Array<Record<string, unknown>>;
    expect(mid[0]).toEqual({ pkg1: "AWAITING_INFO", version: "ACCEPTED", clar_kind: "clarification" });

    const answered = await answerClarification(db, cmd("ans"), {
      clarificationRequestId: clarificationId,
      answer: "condition trễ vì phụ thuộc bên ngoài; kế hoạch bù đính kèm, phạm vi rev1",
      answeredBy: "STAFF-POD",
      packageId: excPackageId,
      newPackageRevision: 2,
      refs: {
        kind: "EXCEPTION",
        conditionId: fx.conditionId,
        sourceRecordId: fx.recordId,
        answer: "kế hoạch bù",
      },
      newDecisionRequestId: `REQ-${excPackageId}-2`,
      outputId: fx.outputId,
      outputRevision: 1,
    });
    expect(answered).toMatchObject({ newPackageRevision: 2 });

    const kinds = (await db.execute(sql`
      SELECT
        (SELECT kind FROM dopaios_action_requests WHERE id = ${"REQ-" + excPackageId + "-2"}) AS new_kind,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${excPackageId} AND revision = 2) AS pkg2
    `)) as unknown as Array<Record<string, unknown>>;
    expect(kinds[0]).toEqual({ new_kind: "exception", pkg2: "OPEN" });

    // Quyết định trên revision mới của gói EXCEPTION — đóng có căn cứ.
    const approved = await decideRunException(db, cmd("exc-approve-r2"), {
      packageId: excPackageId,
      packageRevision: 2,
      outcome: "approve",
      actor: "STAFF-DECIDER",
      recordId: `AR-EXC-${fx.runId}-R2`,
      disposition: { kind: "close", basis: "kế hoạch bù được chấp nhận, bằng chứng đính kèm" },
    });
    expect(approved).toMatchObject({ outcome: "approve" });
  });

  it("hủy run: thiếu MỘT disposition là thất bại nguyên tử; đủ thì work-item CANCELLED, phiên bản GIỮ NGUYÊN, mọi lệnh sau đó bị từ chối", async () => {
    const fx = await outputAtDecision(); // đang AWAITING_DECISION + REQ OPEN
    // Thiếu disposition cho yêu cầu mở → toàn lệnh thất bại, run còn RUNNING.
    await expect(
      cancelTestRun(db, cmd("cxl-miss"), {
        runId: fx.runId,
        actor: "STAFF-DECIDER",
        reason: "đóng phạm vi kiểm chứng",
        dispositions: { [`output:${fx.outputId}@1`]: "bỏ — không dùng tiếp" },
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
    const still = (await db.execute(
      sql`SELECT state FROM dopaios_sop_runs WHERE id = ${fx.runId}`,
    )) as unknown as Array<{ state: string }>;
    expect(still[0].state).toBe("RUNNING");

    // Sai thẩm quyền bị chặn (SFR-051).
    await expect(
      cancelTestRun(db, cmd("cxl-wrong"), {
        runId: fx.runId,
        actor: "STAFF-POD",
        reason: "x",
        dispositions: {},
      }),
    ).rejects.toMatchObject({ code: "SFR-051" });

    const cancelled = await cancelTestRun(db, cmd("cxl"), {
      runId: fx.runId,
      actor: "STAFF-DECIDER",
      reason: "đóng phạm vi kiểm chứng",
      dispositions: {
        [`output:${fx.outputId}@1`]: "bỏ — phiên bản không dùng tiếp, giữ lịch sử",
        [`request:${fx.requestId}`]: "đóng không quyết định — run hủy",
      },
    });
    // Work-item đã COMPLETED là terminal — hàng hủy chỉ áp cho
    // PROPOSED…UNDER_REVIEW, item hoàn thành giữ nguyên lịch sử.
    expect(cancelled).toMatchObject({ state: "CANCELLED", cancelledWorkItems: 0, dispositionedObligations: 2 });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_sop_runs WHERE id = ${fx.runId}) AS run,
        (SELECT state FROM dopaios_work_items WHERE id = ${fx.workItemId}) AS work_item,
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS version
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      run: "CANCELLED",
      work_item: "COMPLETED", // terminal giữ nguyên — không viết lại lịch sử
      version: "AWAITING_DECISION", // trục đầu ra KHÔNG có trạng thái hủy
    });

    // Sau hủy: bản sửa, quyết định, trình điểm đều bị từ chối (SFR-057).
    await expect(
      submitFixtureRevision(db, cmd("srv-after"), {
        outputId: fx.outputId,
        newRevision: 2,
        contentSha256: SHA_REV2,
        outputType: "code-change",
        qualityContractRef: qcRef,
        selfCheckEvidence: { ref: "SC-X", sha256: SELF_SHA, targetSha256: SHA_REV2, by: "AI-BUILD" },
        expectedSelfCheckSha256: SELF_SHA,
        reviewEvidence: {
          ref: "RE-X",
          sha256: REVIEW_SHA,
          targetSha256: SHA_REV2,
          conclusion: "ready",
          by: "AI-REVIEWER",
        },
        expectedReviewSha256: REVIEW_SHA,
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
    await expect(
      recordApproval(db, cmd("apr-after"), {
        requestId: fx.requestId,
        recordId: `AR-${fx.runId}-X`,
        packageId: fx.packageId,
        packageRevision: 1,
        pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
        actor: "STAFF-DECIDER",
        outputId: fx.outputId,
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });

    // Hủy lần hai bị từ chối — terminal là terminal.
    await expect(
      cancelTestRun(db, cmd("cxl-again"), {
        runId: fx.runId,
        actor: "STAFF-DECIDER",
        reason: "x",
        dispositions: {},
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
  });

  it("hủy run khi work-item còn SUBMITTED: hàng hủy work-item → CANCELLED, không tính sản lượng", async () => {
    runSeq += 1;
    const runId = `RUN-B5-${runSeq}`;
    const workItemId = `WI-B5-${runSeq}`;
    const outputId = `OUT-${workItemId}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B5" },
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
    const cancelled = await cancelTestRun(db, cmd("cxl-mid"), {
      runId,
      actor: "STAFF-DECIDER",
      reason: "đóng giữa chừng khi work-item SUBMITTED",
      dispositions: {
        [`output:${outputId}@1`]: "bỏ — chưa qua kiểm, giữ lịch sử",
      },
    });
    expect(cancelled).toMatchObject({ state: "CANCELLED", cancelledWorkItems: 1 });
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_work_items WHERE id = ${workItemId}) AS work_item,
        (SELECT state FROM dopaios_output_versions WHERE id = ${outputId} AND revision = 1) AS version
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ work_item: "CANCELLED", version: "SUBMITTED" });
  });

  it("hủy run có condition mở: cần disposition cho condition; watchdog quá hạn KHÔNG kích hoạt trên run terminal", async () => {
    const fx = await acceptedWithCondition();
    const cancelled = await cancelTestRun(db, cmd("cxl-cond"), {
      runId: fx.runId,
      actor: "STAFF-DECIDER",
      reason: "đóng phạm vi kiểm chứng",
      dispositions: {
        [`condition:${fx.conditionId}`]: "nghĩa vụ chốt trong record hủy — không theo dõi tiếp",
      },
    });
    expect(cancelled).toMatchObject({ state: "CANCELLED" });

    // Condition đã quá hạn nhưng run terminal → bộ máy quá hạn không chạy.
    const declared = await detectOverdueRunConditions(db, { nowMs: AFTER_DEADLINE });
    expect(declared.filter((d) => d.conditionId === fx.conditionId)).toEqual([]);
  });

  it("replay rebuilds B5 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
