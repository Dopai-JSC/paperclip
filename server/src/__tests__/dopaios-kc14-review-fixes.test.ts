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
  completeSopRun,
  markArtifactImpact,
  answerClarification,
} from "../dopaios/commands.ts";
import { submitFixtureRevision } from "../dopaios/revisions.ts";
import {
  detectOverdueRunConditions,
  decideRunException,
  cancelTestRun,
} from "../dopaios/exceptions.ts";
import { registerQualityContract, qualityContractContentSha256 } from "../dopaios/lifecycle.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-14 B7 — kiểm các fix theo finding vòng review đối kháng 2 lens:
//  - SFR-057 tuần tự: run không RUNNING từ chối exec/complete; complete đếm
//    ĐỦ nghĩa vụ (work-item, phiên bản, yêu cầu — tập terminal thống nhất);
//  - liên kết quyết định: yêu cầu ↔ gói ↔ target ↔ run (chặn decider run A
//    ký output run B);
//  - SFR-019 theo executor ĐÃ GHI; thẩm quyền hủy là người active;
//  - pin Hợp đồng chất lượng đòi Approval Record hiệu lực thật;
//  - markArtifactImpact chỉ tuyên bố impact-pending;
//  - decideRunException đóng đúng yêu cầu theo revision gói;
//  - SFR-045 ở cửa chung: bản sửa không nhảy dòng/run;
//  - tương tranh thật dưới SERIALIZABLE + retry: hai bản sửa song song,
//    bản sửa × quyết định song song — không trạng thái cấm nào tồn tại sau.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B7 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "aa".repeat(32);
const SHA_REV2 = "bb".repeat(32);
const SELF_SHA = "cc".repeat(32);
const REVIEW_SHA = "dd".repeat(32);
let seq = 0;
const cmd = (label: string) => `KC14-B7-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-14 B7 — xử finding vòng review đối kháng", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  let runSeq = 0;
  async function outputAtDecision(decider = "STAFF-DECIDER"): Promise<{
    runId: string;
    workItemId: string;
    outputId: string;
    packageId: string;
    requestId: string;
  }> {
    runSeq += 1;
    const runId = `RUN-B7-${runSeq}`;
    const workItemId = `WI-B7-${runSeq}`;
    const outputId = `OUT-${workItemId}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B7" },
      decider,
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

  function revisionPayload(outputId: string, extra?: Record<string, unknown>) {
    return {
      outputId,
      newRevision: 2,
      contentSha256: SHA_REV2,
      outputType: "code-change",
      qualityContractRef: qcRef,
      selfCheckEvidence: { ref: `SC-${outputId}-r2`, sha256: SELF_SHA, targetSha256: SHA_REV2, by: "AI-BUILD" },
      expectedSelfCheckSha256: SELF_SHA,
      reviewEvidence: {
        ref: `RE-${outputId}-r2`,
        sha256: REVIEW_SHA,
        targetSha256: SHA_REV2,
        conclusion: "ready",
        by: "AI-REVIEWER",
      },
      expectedReviewSha256: REVIEW_SHA,
      ...extra,
    } as Parameters<typeof submitFixtureRevision>[2];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b7-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, kind, capabilities] of [
      ["STAFF-DECIDER", "human", ["run-decider"]],
      ["STAFF-DECIDER-B", "human", ["run-decider"]],
      ["STAFF-POD", "human", ["pod"]],
      ["AI-DECIDER", "ai", ["run-decider"]],
    ] as const) {
      await registerActor(db, cmd(`a-${actorId}`), {
        actorId,
        kind,
        active: true,
        capabilities: [...capabilities],
      });
    }
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-B7",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B7",
    });
    await registerApprovedArtifact(db, cmd("sop"), { artifactId: "SOP-B7X", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-B7",
      revision: 1,
      sopPin: { artifactId: "SOP-B7X", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-B7",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("SFR-057 tuần tự: complete đòi run RUNNING và ĐỦ nghĩa vụ; exec/exhibit bị chặn trên run terminal", async () => {
    const fx = await outputAtDecision();
    // Yêu cầu sửa → rework ACCEPTED; complete phải chặn vì work-item mở.
    await recordApproval(db, cmd("rework"), {
      requestId: fx.requestId,
      recordId: `AR-${fx.runId}`,
      packageId: fx.packageId,
      packageRevision: 1,
      pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: fx.outputId,
      outputRevision: 1,
      outcome: "reject",
      reEntryPoint: "T1",
      reworkWorkItemId: `${fx.workItemId}-RW`,
    });
    await expect(
      completeSopRun(db, cmd("done-early"), { runId: fx.runId }),
    ).rejects.toMatchObject({ code: "ERR-OPEN-OBLIGATION" });

    // Hủy run (disposition đủ) rồi mọi lệnh trên record thuộc run bị chặn.
    await cancelTestRun(db, cmd("cxl"), {
      runId: fx.runId,
      actor: "STAFF-DECIDER",
      reason: "đóng ca kiểm",
      dispositions: {},
    });
    // Work-item rework đã CANCELLED cùng run nên DEV-010 có thể bắn trước
    // SFR-057 — điều cần chứng minh là KHÔNG lệnh nào đi qua.
    await expect(
      runFixtureExecution(db, cmd("exec-cxl"), {
        workItemId: `${fx.workItemId}-RW`,
        executor: "AI-BUILD",
        outputId: fx.outputId,
        outputRevision: 2,
        contentSha256: SHA_REV2,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
    ).rejects.toSatisfy((error: { code?: string }) => ["DEV-010", "SFR-057"].includes(error.code ?? ""));
    await expect(
      completeSopRun(db, cmd("done-cxl"), { runId: fx.runId }),
    ).rejects.toMatchObject({ code: "SFR-057" });

    // Run chưa kích hoạt không "hoàn tất" được.
    await requestTestRun(db, cmd("run-na"), {
      runId: "RUN-B7-NA",
      definitionRef: { definitionId: "DEF-B7" },
      decider: "STAFF-DECIDER",
      pod: "STAFF-POD",
      fixturePackage: {},
    });
    await expect(
      completeSopRun(db, cmd("done-na"), { runId: "RUN-B7-NA" }),
    ).rejects.toMatchObject({ code: "SFR-057" });
  });

  it("liên kết quyết định: decider run A không ký được output/gói của run B", async () => {
    const fxA = await outputAtDecision();
    const fxB = await outputAtDecision("STAFF-DECIDER-B");

    // Yêu cầu run A + gói run B → chặn theo link gói của yêu cầu.
    await expect(
      recordApproval(db, cmd("cross-pkg"), {
        requestId: fxA.requestId,
        recordId: "AR-CROSS-1",
        packageId: fxB.packageId,
        packageRevision: 1,
        pinnedRefs: { outputId: fxB.outputId, revision: 1, sha256: SHA },
        actor: "STAFF-DECIDER",
        outputId: fxB.outputId,
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "SFR-048" });
    // Yêu cầu + gói run A nhưng target output run B → chặn theo target gói.
    await expect(
      recordApproval(db, cmd("cross-target"), {
        requestId: fxA.requestId,
        recordId: "AR-CROSS-2",
        packageId: fxA.packageId,
        packageRevision: 1,
        pinnedRefs: { outputId: fxA.outputId, revision: 1, sha256: SHA },
        actor: "STAFF-DECIDER",
        outputId: fxB.outputId,
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR-PKG-TARGET" });

    // Đường đúng của từng run vẫn thông.
    for (const [fx, decider] of [
      [fxA, "STAFF-DECIDER"],
      [fxB, "STAFF-DECIDER-B"],
    ] as const) {
      const approved = await recordApproval(db, cmd(`ok-${fx.runId}`), {
        requestId: fx.requestId,
        recordId: `AR-OK-${fx.runId}`,
        packageId: fx.packageId,
        packageRevision: 1,
        pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
        actor: decider,
        outputId: fx.outputId,
        outputRevision: 1,
      });
      expect(approved).toMatchObject({ outcome: "approve" });
    }
  });

  it("SFR-019 theo executor ĐÃ GHI: khai man executor để người thực hiện tự review bị chặn", async () => {
    runSeq += 1;
    const runId = `RUN-B7-${runSeq}`;
    const workItemId = `WI-B7-${runSeq}`;
    await requestTestRun(db, cmd("run-sfr019"), {
      runId,
      definitionRef: { definitionId: "DEF-B7" },
      decider: "STAFF-DECIDER",
      pod: "STAFF-POD",
      fixturePackage: {},
    });
    await activateSopRun(db, cmd("act-sfr019"), { runId, workItemId });
    await runFixtureExecution(db, cmd("exec-sfr019"), {
      workItemId,
      executor: "AI-BUILD",
      outputId: `OUT-${workItemId}`,
      outputRevision: 1,
      contentSha256: SHA,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    await validateSelfCheck(db, cmd("vsc-sfr019"), {
      outputId: `OUT-${workItemId}`,
      outputRevision: 1,
      evidence: { ref: "SC", sha256: SELF_SHA, targetSha256: SHA, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    await expect(
      reviewFixtureExecution(db, cmd("rev-liar"), {
        workItemId,
        outputId: `OUT-${workItemId}`,
        outputRevision: 1,
        executor: "AI-KHAI-MAN",
        reviewer: "AI-BUILD",
        reviewEvidence: { ref: "RE", sha256: REVIEW_SHA, targetSha256: SHA, conclusion: "ready" },
        expectedReviewSha256: REVIEW_SHA,
      }),
    ).rejects.toMatchObject({ code: "SFR-019" });
  });

  it("thẩm quyền hủy: AI decider và định danh chưa đăng ký đều không hủy được run (SFR-023)", async () => {
    runSeq += 1;
    const runId = `RUN-B7-${runSeq}`;
    await requestTestRun(db, cmd("run-ai"), {
      runId,
      definitionRef: { definitionId: "DEF-B7" },
      decider: "AI-DECIDER",
      pod: "STAFF-POD",
      fixturePackage: {},
    });
    await expect(
      cancelTestRun(db, cmd("cxl-ai"), { runId, actor: "AI-DECIDER", reason: "x", dispositions: {} }),
    ).rejects.toMatchObject({ code: "SFR-023" });

    runSeq += 1;
    const runId2 = `RUN-B7-${runSeq}`;
    await requestTestRun(db, cmd("run-ghost"), {
      runId: runId2,
      definitionRef: { definitionId: "DEF-B7" },
      decider: "DECIDER-CHUA-DANG-KY",
      pod: "STAFF-POD",
      fixturePackage: {},
    });
    await expect(
      cancelTestRun(db, cmd("cxl-ghost"), {
        runId: runId2,
        actor: "DECIDER-CHUA-DANG-KY",
        reason: "x",
        dispositions: {},
      }),
    ).rejects.toMatchObject({ code: "ERR-ACTOR" });
  });

  it("pin Hợp đồng chất lượng đòi Approval Record hiệu lực — hàng ledger bootstrap không record bị chặn", async () => {
    const checks = ["self-check", "independent-review"];
    const sha = qualityContractContentSha256({ outputType: "code-change", requiredChecks: checks });
    await registerApprovedArtifact(db, cmd("qc-boot"), {
      artifactId: "QC-BOOT-B7",
      revision: 1,
      sha256: sha,
      artifactType: "quality-contract",
    });
    await registerQualityContract(db, cmd("qc-boot-reg"), {
      contractId: "QC-BOOT-B7",
      revision: 1,
      outputType: "code-change",
      requiredChecks: checks,
      registeredBy: "STAFF-POD",
    });
    runSeq += 1;
    const runId = `RUN-B7-${runSeq}`;
    const workItemId = `WI-B7-${runSeq}`;
    await requestTestRun(db, cmd("run-boot"), {
      runId,
      definitionRef: { definitionId: "DEF-B7" },
      decider: "STAFF-DECIDER",
      pod: "STAFF-POD",
      fixturePackage: {},
    });
    await activateSopRun(db, cmd("act-boot"), { runId, workItemId });
    await expect(
      runFixtureExecution(db, cmd("exec-boot"), {
        workItemId,
        executor: "AI-BUILD",
        outputId: `OUT-${workItemId}`,
        outputRevision: 1,
        contentSha256: SHA,
        outputType: "code-change",
        qualityContractRef: { id: "QC-BOOT-B7", revision: 1, sha256: sha },
      }),
    ).rejects.toMatchObject({ code: "ERR-APPROVAL" });
  });

  it("markArtifactImpact chỉ tuyên bố impact-pending; SFR-045 cửa chung chặn bản sửa nhảy run", async () => {
    await expect(
      markArtifactImpact(db, cmd("imp-clear"), {
        artifactId: "SOP-B7X",
        revision: 1,
        impactStatus: "clear",
      }),
    ).rejects.toMatchObject({ code: "SFR-029" });

    // Bản sửa nhảy dòng: work-item run khác nộp revision lên dòng run A.
    const fxA = await outputAtDecision();
    runSeq += 1;
    const runB = `RUN-B7-${runSeq}`;
    const wiB = `WI-B7-${runSeq}`;
    await requestTestRun(db, cmd("run-hop"), {
      runId: runB,
      definitionRef: { definitionId: "DEF-B7" },
      decider: "STAFF-DECIDER",
      pod: "STAFF-POD",
      fixturePackage: {},
    });
    await activateSopRun(db, cmd("act-hop"), { runId: runB, workItemId: wiB });
    await expect(
      runFixtureExecution(db, cmd("exec-hop"), {
        workItemId: wiB,
        executor: "AI-BUILD",
        outputId: fxA.outputId,
        outputRevision: 2,
        contentSha256: SHA_REV2,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
    ).rejects.toMatchObject({ code: "SFR-045" });
  });

  it("decideRunException đóng ĐÚNG yêu cầu theo revision gói; run hoàn tất được sau trọn vòng RMI", async () => {
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
          scope: {},
          risk: "thấp",
          owner: "STAFF-POD",
          deadline: "2026-08-02T00:00:00Z",
          closureCriteria: "bổ sung",
          blocksNextStep: false,
        },
      ],
    });
    await detectOverdueRunConditions(db, { nowMs: Date.UTC(2026, 7, 3) });
    const excPkg = `EXC-RUN-CON-${fx.runId}`;
    await decideRunException(db, cmd("rmi"), {
      packageId: excPkg,
      outcome: "request-more-information",
      actor: "STAFF-DECIDER",
      recordId: `AR-EXC-${fx.runId}-RMI`,
      requiredInfo: "cần kế hoạch bù",
      clarificationRequestId: `REQ-CLAR-${fx.runId}`,
    });
    await answerClarification(db, cmd("ans"), {
      clarificationRequestId: `REQ-CLAR-${fx.runId}`,
      answer: "kế hoạch bù đính kèm, phạm vi rev1",
      answeredBy: "STAFF-POD",
      packageId: excPkg,
      newPackageRevision: 2,
      refs: { kind: "EXCEPTION", conditionId: `CON-${fx.runId}`, sourceRecordId: `AR-${fx.runId}` },
      newDecisionRequestId: `REQ-${excPkg}-2`,
      outputId: fx.outputId,
      outputRevision: 1,
    });
    const decided = await decideRunException(db, cmd("approve-r2"), {
      packageId: excPkg,
      packageRevision: 2,
      outcome: "approve",
      actor: "STAFF-DECIDER",
      recordId: `AR-EXC-${fx.runId}-R2`,
      disposition: { kind: "close", basis: "kế hoạch bù được chấp nhận" },
    });
    expect(decided).toMatchObject({ decidedRequestId: `REQ-${excPkg}-2` });

    const requests = (await db.execute(sql`
      SELECT id, state FROM dopaios_action_requests
      WHERE run_id = ${fx.runId} ORDER BY id
    `)) as unknown as Array<{ id: string; state: string }>;
    expect(requests.every((r) => ["DECIDED", "CLOSED", "SUPERSEDED-TARGET-CHANGED"].includes(r.state))).toBe(true);

    // Run hoàn tất được — mọi nghĩa vụ terminal (finding: trước fix, yêu cầu
    // REQ-…-2 kẹt OPEN vĩnh viễn).
    const done = await completeSopRun(db, cmd("done"), { runId: fx.runId });
    expect(done).toMatchObject({ state: "COMPLETED" });
  });

  it("tương tranh: hai bản sửa song song trên cùng dòng — đúng MỘT bản vào trục, không trạng thái cấm", async () => {
    const fx = await outputAtDecision();
    const results = await Promise.allSettled([
      submitFixtureRevision(db, cmd("race-a"), revisionPayload(fx.outputId)),
      submitFixtureRevision(db, cmd("race-b"), revisionPayload(fx.outputId, { contentSha256: SHA_REV2 })),
    ]);
    // Payload giống hệt có thể cho hai "thành công" chỉ khi một bên là
    // idempotent replay — ở đây command id KHÁC nhau nên đúng một bên thắng.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const rows = (await db.execute(sql`
      SELECT revision, state FROM dopaios_output_versions
      WHERE id = ${fx.outputId} ORDER BY revision
    `)) as unknown as Array<{ revision: number; state: string }>;
    // Đúng hai revision, rev2 duy nhất; rev1 REWORK_REQUIRED (bị thay khi
    // đang chờ quyết định) — không nhân bản, không nhảy số.
    expect(rows.map((r) => r.revision)).toEqual([1, 2]);
    expect(rows[0].state).toBe("REWORK_REQUIRED");
  });

  it("tương tranh: bản sửa × quyết định trên bản cũ — hệ sau cùng nhất quán, không nửa vô hiệu", async () => {
    const fx = await outputAtDecision();
    await Promise.allSettled([
      submitFixtureRevision(db, cmd("race-srv"), revisionPayload(fx.outputId)),
      recordApproval(db, cmd("race-apr"), {
        requestId: fx.requestId,
        recordId: `AR-RACE-${fx.runId}`,
        packageId: fx.packageId,
        packageRevision: 1,
        pinnedRefs: { outputId: fx.outputId, revision: 1, sha256: SHA },
        actor: "STAFF-DECIDER",
        outputId: fx.outputId,
        outputRevision: 1,
      }),
    ]);
    const state = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 1) AS rev1,
        (SELECT count(*)::int FROM dopaios_output_versions WHERE id = ${fx.outputId} AND revision = 2) AS rev2_n,
        (SELECT count(*)::int FROM dopaios_approval_records
          WHERE target_id = ${fx.outputId} AND target_revision = 1
            AND outcome IN ('approve','approve-with-conditions')
            AND invalidated_at IS NULL) AS effective_approvals
    `)) as unknown as Array<{ rev1: string; rev2_n: number; effective_approvals: number }>;
    const s = state[0];
    // Bảng chân lý hợp lệ duy nhất:
    //  - approve thắng trước: rev1 APPROVED; nếu bản sửa vào sau thì approval
    //    phải ĐÃ vô hiệu (0 hiệu lực); nếu bản sửa thua thì không rev2.
    //  - bản sửa thắng trước: rev1 REWORK_REQUIRED, không approval hiệu lực.
    if (s.rev1 === "REWORK_REQUIRED") {
      expect(s.rev2_n).toBe(1);
      expect(s.effective_approvals).toBe(0);
    } else {
      expect(s.rev1).toBe("APPROVED");
      if (s.rev2_n === 1) {
        expect(s.effective_approvals).toBe(0); // SFR-031 đã chạy trọn
      } else {
        expect(s.effective_approvals).toBe(1); // bản sửa thua hẳn
      }
    }
  });

  it("replay rebuilds B7 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
