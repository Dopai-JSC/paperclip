import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CommandPayloadMismatchError,
  replayProjections,
  snapshotProjections,
} from "../dopaios/event-store.ts";
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
} from "../dopaios/commands.ts";
import { submitFixtureRevision } from "../dopaios/revisions.ts";
import { detectOverdueConditions } from "../dopaios/conditions.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-14 B4 — bản sửa và vô hiệu theo bảng đầu ra FS-003:
//  - submit-fixture-revision (hàng NONE revision kế tiếp): bản sửa không mở
//    work-item, bằng chứng binding trên chính phiên bản (DEV-011);
//  - ba hàng bản-cũ: AWAITING_DECISION → REWORK_REQUIRED + gói/yêu cầu vô
//    hiệu (SFR-031, DEV-009); APPROVED/ACCEPTED GIỮ NGUYÊN + approval hết
//    hiệu lực + bước mở bị tái chặn (SFR-050) + watchdog ngừng theo dõi
//    condition (SFR-016); REJECTED chỉ ghi quan hệ thay thế (SFR-045);
//  - SFR-030: bản mới không kế thừa trạng thái/quyết định/bằng chứng;
//  - SFR-053: bản hiện hành mới đạt kiểm khi run đang dừng tại điểm phê
//    duyệt → đúng một Gói mới + một Yêu cầu mới; quyết định nhắm bản cũ bị
//    từ chối; trục không đường lùi.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "a1".repeat(32);
const SHA_REV2 = "b2".repeat(32);
const SELF_SHA = "c3".repeat(32);
const REVIEW_SHA = "d4".repeat(32);
let seq = 0;
const cmd = (label: string) => `KC14-B4-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-14 B4 — bản sửa và vô hiệu (SFR-030/031/045/050/053)", () => {
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
    const runId = `RUN-B4-${runSeq}`;
    const workItemId = `WI-B4-${runSeq}`;
    const outputId = `OUT-${workItemId}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B4" },
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

  function revisionPayload(
    fx: Awaited<ReturnType<typeof outputAtDecision>>,
    extra?: Record<string, unknown>,
  ) {
    return {
      outputId: fx.outputId,
      newRevision: 2,
      contentSha256: SHA_REV2,
      outputType: "code-change",
      qualityContractRef: qcRef,
      selfCheckEvidence: { ref: `SC-${fx.outputId}-r2`, sha256: SELF_SHA, targetSha256: SHA_REV2, by: "AI-BUILD" },
      expectedSelfCheckSha256: SELF_SHA,
      reviewEvidence: {
        ref: `RE-${fx.outputId}-r2`,
        sha256: REVIEW_SHA,
        targetSha256: SHA_REV2,
        conclusion: "ready",
        by: "AI-REVIEWER",
      },
      expectedReviewSha256: REVIEW_SHA,
      ...extra,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b4-");
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
      id: "QC-B4",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B4",
      registeredBy: "STAFF-ORCH",
    });
    await registerApprovedArtifact(db, cmd("sop"), { artifactId: "SOP-B4", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-B4",
      revision: 1,
      sopPin: { artifactId: "SOP-B4", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-B4",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("bản cũ AWAITING_DECISION → REWORK_REQUIRED; gói/yêu cầu vô hiệu; SFR-053 tạo đúng một gói + một yêu cầu mới; SFR-030 không kế thừa", async () => {
    const fx = await outputAtDecision();
    const result = await submitFixtureRevision(db, cmd("srv"), revisionPayload(fx, {
      decisionPoint: {
        packageId: fx.packageId,
        newPackageRevision: 2,
        refs: { outputId: fx.outputId, revision: 2, sha256: SHA_REV2 },
        newDecisionRequestId: `${fx.requestId}-2`,
      },
    }) as Parameters<typeof submitFixtureRevision>[2]);
    expect(result).toMatchObject({ newRevision: 2, replacesRevision: 1, state: "AWAITING_DECISION" });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS rev1,
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 2) AS rev2,
        (SELECT replaces_revision FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 2) AS replaces,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${fx.packageId} AND revision = 1) AS pkg1,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${fx.packageId} AND revision = 2) AS pkg2,
        (SELECT state FROM dopaios_action_requests WHERE id = ${fx.requestId}) AS req1,
        (SELECT invalidation->>'reason' FROM dopaios_action_requests WHERE id = ${fx.requestId}) AS req1_reason,
        (SELECT state FROM dopaios_action_requests WHERE id = ${fx.requestId + "-2"}) AS req2,
        (SELECT check_evidence->'independent-review'->>'ref' FROM dopaios_output_versions
          WHERE id = ${fx.outputId} AND revision = 2) AS rev2_review_ref
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      rev1: "REWORK_REQUIRED",
      rev2: "AWAITING_DECISION",
      replaces: 1,
      pkg1: "INVALIDATED-TARGET-CHANGED",
      pkg2: "OPEN",
      req1: "SUPERSEDED-TARGET-CHANGED",
      req1_reason: "target-changed",
      req2: "OPEN",
      rev2_review_ref: `RE-${fx.outputId}-r2`, // bằng chứng CỦA CHÍNH rev2 — không kế thừa rev1
    });

    // Quyết định nhắm bản cũ bị từ chối: yêu cầu cũ đã vô hiệu (SFR-048)…
    await expect(
      recordApproval(db, cmd("old-req"), {
        requestId: fx.requestId,
        recordId: `AR-${fx.runId}-OLD`,
        packageId: fx.packageId,
        packageRevision: 1,
        pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
        actor: "STAFF-DECIDER",
        outputId: fx.outputId,
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "SFR-048" });
    // …và quyết định nhắm bản cũ qua gói mới bị chặn ngay ở target gói
    // (B7: gói pin target — sai target chặn trước cả from_state).
    await expect(
      recordApproval(db, cmd("old-target"), {
        requestId: `${fx.requestId}-2`,
        recordId: `AR-${fx.runId}-OLD2`,
        packageId: fx.packageId,
        packageRevision: 2,
        pinnedRefs: { outputId: fx.outputId, revision: 2, sha256: SHA_REV2 },
        actor: "STAFF-DECIDER",
        outputId: fx.outputId,
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR-PKG-TARGET" });

    // Approve bản sửa trên gói mới → APPROVED (FX-02 N13 đường dương).
    const approved = await recordApproval(db, cmd("approve-r2"), {
      requestId: `${fx.requestId}-2`,
      recordId: `AR-${fx.runId}-R2`,
      packageId: fx.packageId,
      packageRevision: 2,
      pinnedRefs: { outputId: fx.outputId, revision: 2, sha256: SHA_REV2 },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 2,
    });
    expect(approved).toMatchObject({ outcome: "approve" });
  });

  it("bản cũ APPROVED giữ nguyên lịch sử; approval hết hiệu lực đúng impact set; bước đã mở bị tái chặn (SFR-050)", async () => {
    const fx = await outputAtDecision();
    await recordApproval(db, cmd("approve"), {
      requestId: fx.requestId,
      recordId: `AR-${fx.runId}`,
      packageId: fx.packageId,
      packageRevision: 1,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      openedStep: "T3",
    });

    await submitFixtureRevision(db, cmd("srv"), revisionPayload(fx, {
      decisionPoint: {
        packageId: fx.packageId,
        newPackageRevision: 2,
        refs: { outputId: fx.outputId, revision: 2, sha256: SHA_REV2 },
        newDecisionRequestId: `${fx.requestId}-2`,
      },
    }) as Parameters<typeof submitFixtureRevision>[2]);

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS rev1,
        (SELECT (invalidated_at IS NOT NULL) FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS invalidated,
        (SELECT invalidation_reason FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS reason,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${fx.runId} AND step_id = 'T3') AS step,
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 2) AS rev2
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      rev1: "APPROVED", // lịch sử không viết lại
      invalidated: true,
      reason: `target-changed: ${fx.outputId}@2 vào trục (SFR-031)`,
      step: "reblocked",
      rev2: "AWAITING_DECISION",
    });
  });

  it("bản cũ ACCEPTED: approval vô hiệu → watchdog NGỪNG theo dõi condition của record đó (SFR-016/031)", async () => {
    const fx = await outputAtDecision();
    await recordApproval(db, cmd("awc"), {
      requestId: fx.requestId,
      recordId: `AR-${fx.runId}`,
      packageId: fx.packageId,
      packageRevision: 1,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      outcome: "approve-with-conditions",
      conditions: [
        {
          conditionId: `CON-${fx.runId}`,
          scope: { area: "phần phụ" },
          risk: "thấp",
          owner: "STAFF-POD",
          deadline: "2026-08-02T00:00:00Z",
          closureCriteria: "bổ sung tài liệu",
          blocksNextStep: false,
        },
      ],
    });
    await submitFixtureRevision(db, cmd("srv"), revisionPayload(fx) as Parameters<typeof submitFixtureRevision>[2]);

    const state = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS rev1,
        (SELECT (invalidated_at IS NOT NULL) FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS invalidated
    `)) as unknown as Array<Record<string, unknown>>;
    expect(state[0]).toEqual({ rev1: "ACCEPTED", invalidated: true });

    // Condition đã quá hạn nhưng approval vô hiệu → không EXCEPTION nào sinh.
    const declared = await detectOverdueConditions(db, {
      nowMs: Date.UTC(2026, 7, 3, 0, 0, 0),
    });
    expect(declared.filter((d) => d.conditionId === `CON-${fx.runId}`)).toEqual([]);
  });

  it("bản cũ REJECTED: chỉ ghi quan hệ thay thế — không vô hiệu gì thêm (SFR-045)", async () => {
    const fx = await outputAtDecision();
    await recordApproval(db, cmd("reject"), {
      requestId: fx.requestId,
      recordId: `AR-${fx.runId}`,
      packageId: fx.packageId,
      packageRevision: 1,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      outcome: "reject",
    });
    await submitFixtureRevision(db, cmd("srv"), revisionPayload(fx) as Parameters<typeof submitFixtureRevision>[2]);

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS rev1,
        (SELECT (invalidated_at IS NOT NULL) FROM dopaios_approval_records WHERE id = ${"AR-" + fx.runId}) AS invalidated,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${fx.packageId} AND revision = 1) AS pkg1,
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 2) AS rev2,
        (SELECT replaces_revision FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 2) AS replaces
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      rev1: "REJECTED",
      invalidated: false, // record reject không phải approval hiệu lực — không gì để vô hiệu
      pkg1: "DECIDED",
      rev2: "CHECK_PASSED",
      replaces: 1,
    });
  });

  it("SFR-045 guard: bản trước đang trong chuỗi kiểm (SELF_CHECK) thì bản sửa bị chặn; REC-001 không dấu vết", async () => {
    runSeq += 1;
    const runId = `RUN-B4-${runSeq}`;
    const workItemId = `WI-B4-${runSeq}`;
    const outputId = `OUT-${workItemId}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B4" },
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

    await expect(
      submitFixtureRevision(
        db,
        cmd("srv-early"),
        revisionPayload({ outputId } as Awaited<ReturnType<typeof outputAtDecision>>) as Parameters<
          typeof submitFixtureRevision
        >[2],
      ),
    ).rejects.toMatchObject({ code: "SFR-045" });
    const count = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_output_versions WHERE id = ${outputId}`,
    )) as unknown as Array<{ n: number }>;
    expect(count[0].n).toBe(1);
  });

  it("cửa SFR-019/020: not-ready, reviewer trùng tự kiểm, sai hash pin đều chặn không ghi phiên bản", async () => {
    const fx = await outputAtDecision();
    await expect(
      submitFixtureRevision(db, cmd("nr"), revisionPayload(fx, {
        reviewEvidence: {
          ref: "RE-NR", sha256: REVIEW_SHA, targetSha256: SHA_REV2, conclusion: "not-ready", by: "AI-REVIEWER",
        },
      }) as Parameters<typeof submitFixtureRevision>[2]),
    ).rejects.toMatchObject({ code: "SFR-020" });
    await expect(
      submitFixtureRevision(db, cmd("same"), revisionPayload(fx, {
        reviewEvidence: {
          ref: "RE-SAME", sha256: REVIEW_SHA, targetSha256: SHA_REV2, conclusion: "ready", by: "AI-BUILD",
        },
      }) as Parameters<typeof submitFixtureRevision>[2]),
    ).rejects.toMatchObject({ code: "SFR-019" });
    await expect(
      submitFixtureRevision(db, cmd("badsha"), revisionPayload(fx, {
        expectedSelfCheckSha256: SHA,
      }) as Parameters<typeof submitFixtureRevision>[2]),
    ).rejects.toMatchObject({ code: "SFR-020" });
    const count = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_output_versions WHERE id = ${fx.outputId}`,
    )) as unknown as Array<{ n: number }>;
    expect(count[0].n).toBe(1);
  });

  it("idempotency: cùng command_id trả kết quả cũ; cùng id khác payload bị từ chối (SFR-038/039)", async () => {
    const fx = await outputAtDecision();
    const commandId = cmd("idem");
    const payload = revisionPayload(fx) as Parameters<typeof submitFixtureRevision>[2];
    const first = await submitFixtureRevision(db, commandId, payload);
    expect(first).toMatchObject({ newRevision: 2 });
    const replay = await submitFixtureRevision(db, commandId, payload);
    expect(replay).toMatchObject({ idempotentReplay: true });
    await expect(
      submitFixtureRevision(db, commandId, { ...payload, contentSha256: SHA } as never),
    ).rejects.toBeInstanceOf(CommandPayloadMismatchError);
  });

  it("replay rebuilds B4 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
