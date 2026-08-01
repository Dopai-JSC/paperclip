import { readFileSync } from "node:fs";
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
  attachCheckEvidence,
  advanceToDecision,
  recordApproval,
  completeSopRun,
} from "../dopaios/commands.ts";
import { readTwoLifecycles } from "../dopaios/read-model.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-14 B6 — ca chuẩn tắc FX-04 (AC-V1-03, kịch bản S01–S05 của
// dopaios/fixtures/fx-04-fail-then-fix.json) trên đúng hash pin của các
// thành phần FX-02, cộng:
//  - giao diện đọc hai vòng đời (read-model, QD-3): trục thực hiện và trục
//    chất lượng hiển thị độc lập, rework là work-item MỚI + revision MỚI;
//  - sweep "không đường lùi": mọi transition ngoài bảng bị chặn kèm vệt
//    audit bất biến, trạng thái không đổi;
//  - replay dựng lại đúng chuỗi rev1 REJECTED → rework → rev2 APPROVED.

const fx02 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-02-run-test-chain.json", import.meta.url), "utf8"),
);
const fx04 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-04-fail-then-fix.json", import.meta.url), "utf8"),
);

function componentSha(pathPart: string): string {
  const component = (fx02.components as Array<{ path: string; sha256: string }>).find((c) =>
    c.path.includes(pathPart),
  );
  if (!component) throw new Error(`FX-02 component ${pathPart} not found`);
  return component.sha256;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B6 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC14-B6-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-14 B6 — FX-04 fail-then-fix + giao diện đọc + sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  const sopSha = componentSha("sop-business-test");
  const outRev1 = componentSha("t1-output-rev1");
  const selfRev1 = componentSha("t1-selfcheck-rev1");
  const reviewRev1 = componentSha("t1-review-evidence-rev1");
  const outRev2 = componentSha("t1-output-rev2");
  const selfRev2 = componentSha("t1-selfcheck-rev2");
  const reviewRev2 = componentSha("t1-review-evidence-rev2");

  const RUN = "RUN-FX04";
  const WI1 = "WI-FX04-T1";
  const WI_RW = "WI-FX04-T1-RW";
  const OUT = "OUT-T1-001";
  const executor = fx04 && (fx02.fixture_package.executor as string);
  const decider = fx02.fixture_package.decider as string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b6-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("a-decider"), {
      actorId: decider,
      kind: "human",
      active: true,
      capabilities: ["run-decider"],
    });
    await registerActor(db, cmd("a-pod"), {
      actorId: fx02.fixture_package.pod,
      kind: "human",
      active: true,
      capabilities: ["pod"],
    });
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-FX04",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B6",
      registeredBy: decider,
    });
    await registerApprovedArtifact(db, cmd("sop"), {
      artifactId: "SOP-FX04",
      revision: 1,
      sha256: sopSha,
    });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-FX04",
      revision: 1,
      sopPin: { artifactId: "SOP-FX04", revision: 1, sha256: sopSha },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-FX04",
      definitionContentSha256: sopSha,
      expectedSopSha256: sopSha,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("S01: happy chain FX-02 tới AWAITING_DECISION tại T2 — đã nộp và qua kiểm KHÔNG tự sinh đạt", async () => {
    await requestTestRun(db, cmd("s04"), {
      runId: RUN,
      definitionRef: { definitionId: "DEF-FX04" },
      decider,
      pod: fx02.fixture_package.pod,
      fixturePackage: { id: "FX-04", reuses: "FX-02", executor },
    });
    await activateSopRun(db, cmd("s05"), { runId: RUN, workItemId: WI1 });
    await runFixtureExecution(db, cmd("s06"), {
      workItemId: WI1,
      executor,
      outputId: OUT,
      outputRevision: 1,
      contentSha256: outRev1,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    await validateSelfCheck(db, cmd("s06b"), {
      outputId: OUT,
      outputRevision: 1,
      evidence: { ref: "t1-selfcheck-rev1.json", sha256: selfRev1, targetSha256: outRev1, by: executor },
      expectedSha256: selfRev1,
    });
    await reviewFixtureExecution(db, cmd("s07"), {
      workItemId: WI1,
      outputId: OUT,
      outputRevision: 1,
      executor,
      reviewer: "FIXTURE-REVIEWER-001",
      reviewEvidence: {
        ref: "t1-review-evidence-rev1.json",
        sha256: reviewRev1,
        targetSha256: outRev1,
        conclusion: "ready",
      },
      expectedReviewSha256: reviewRev1,
    });
    await advanceToDecision(db, cmd("s08"), {
      runId: RUN,
      outputId: OUT,
      outputRevision: 1,
      packageId: `PKG-${RUN}`,
      packageRevision: 1,
      refs: { outputId: OUT, revision: 1, sha256: outRev1 },
      requestId: `REQ-${RUN}`,
    });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_work_items WHERE id = ${WI1}) AS work_item,
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 1) AS version
    `)) as unknown as Array<Record<string, string>>;
    // Work-item COMPLETED nhưng phiên bản chỉ AWAITING_DECISION — quyết định
    // nghiệp vụ CHƯA có (hai trục độc lập, PRD Mục 3 / AC-V1-03).
    expect(rows[0]).toEqual({ work_item: "COMPLETED", version: "AWAITING_DECISION" });
  });

  it("S02: quyết định 'yêu cầu sửa' — rev1 REJECTED terminal, work-item rework liên kết bản trước, không bước nào sau T2 mở", async () => {
    const rejected = await recordApproval(db, cmd("s09-reject"), {
      requestId: `REQ-${RUN}`,
      recordId: `AR-${RUN}-1`,
      packageId: `PKG-${RUN}`,
      packageRevision: 1,
      pinnedRefs: { outputId: OUT, revision: 1, sha256: outRev1 },
      actor: decider,
      outputId: OUT,
      outputRevision: 1,
      outcome: "reject",
      reEntryPoint: "T1",
      reworkWorkItemId: WI_RW,
    });
    expect(rejected).toMatchObject({ outcome: "reject", reworkWorkItemId: WI_RW });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 1) AS rev1,
        (SELECT state FROM dopaios_work_items WHERE id = ${WI_RW}) AS rework,
        (SELECT rework_of_work_item_id FROM dopaios_work_items WHERE id = ${WI_RW}) AS rework_of,
        (SELECT re_entry_point FROM dopaios_approval_records WHERE id = ${"AR-" + RUN + "-1"}) AS re_entry,
        (SELECT count(*)::int FROM dopaios_run_steps WHERE run_id = ${RUN}) AS steps
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      rev1: "REJECTED",
      rework: "ACCEPTED",
      rework_of: WI1,
      re_entry: "T1",
      steps: 0,
    });
  });

  it("S03+S04: rework nộp rev2 qua đúng chuỗi chuẩn; rev2 không kế thừa (SFR-030); qua kiểm → gói mới tại T2 (SFR-053)", async () => {
    await runFixtureExecution(db, cmd("s03"), {
      workItemId: WI_RW,
      executor,
      outputId: OUT,
      outputRevision: 2,
      contentSha256: outRev2,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    const mid = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 2) AS rev2,
        (SELECT replaces_revision FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 2) AS replaces,
        (SELECT check_evidence FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 2) AS evidence
    `)) as unknown as Array<Record<string, unknown>>;
    // SFR-030: bản mới vào trục ở SUBMITTED với bằng chứng RỖNG — không kế
    // thừa trạng thái/bằng chứng/quyết định của rev1.
    expect(mid[0]).toEqual({ rev2: "SUBMITTED", replaces: 1, evidence: null });

    await validateSelfCheck(db, cmd("s04-self"), {
      outputId: OUT,
      outputRevision: 2,
      evidence: { ref: "t1-selfcheck-rev2.json", sha256: selfRev2, targetSha256: outRev2, by: executor },
      expectedSha256: selfRev2,
    });
    await reviewFixtureExecution(db, cmd("s04-rev"), {
      workItemId: WI_RW,
      outputId: OUT,
      outputRevision: 2,
      executor,
      reviewer: "FIXTURE-REVIEWER-001",
      reviewEvidence: {
        ref: "t1-review-evidence-rev2.json",
        sha256: reviewRev2,
        targetSha256: outRev2,
        conclusion: "ready",
      },
      expectedReviewSha256: reviewRev2,
    });
    // Run đang dừng tại T2 → gói mới revision 2 + yêu cầu mới (SFR-053).
    await advanceToDecision(db, cmd("s04-adv"), {
      runId: RUN,
      outputId: OUT,
      outputRevision: 2,
      packageId: `PKG-${RUN}`,
      packageRevision: 2,
      refs: { outputId: OUT, revision: 2, sha256: outRev2 },
      requestId: `REQ-${RUN}-2`,
    });
    const after = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 2) AS rev2,
        (SELECT state FROM dopaios_decision_packages WHERE id = ${"PKG-" + RUN} AND revision = 2) AS pkg2,
        (SELECT state FROM dopaios_action_requests WHERE id = ${"REQ-" + RUN + "-2"}) AS req2,
        (SELECT state FROM dopaios_work_items WHERE id = ${WI_RW}) AS rework
    `)) as unknown as Array<Record<string, string>>;
    expect(after[0]).toEqual({
      rev2: "AWAITING_DECISION",
      pkg2: "OPEN",
      req2: "OPEN",
      rework: "COMPLETED",
    });
  });

  it("S05: approve rev2 — APPROVED, T3 mở, run hoàn tất; rev1 giữ REJECTED, lịch sử không viết lại", async () => {
    await recordApproval(db, cmd("s05-approve"), {
      requestId: `REQ-${RUN}-2`,
      recordId: `AR-${RUN}-2`,
      packageId: `PKG-${RUN}`,
      packageRevision: 2,
      pinnedRefs: { outputId: OUT, revision: 2, sha256: outRev2 },
      actor: decider,
      outputId: OUT,
      outputRevision: 2,
      openedStep: "T3",
    });
    const completion = await completeSopRun(db, cmd("s10"), { runId: RUN });
    expect(completion).toMatchObject({ state: "COMPLETED" });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 1) AS rev1,
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 2) AS rev2,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${RUN} AND step_id = 'T3') AS step,
        (SELECT state FROM dopaios_sop_runs WHERE id = ${RUN}) AS run
    `)) as unknown as Array<Record<string, string>>;
    expect(rows[0]).toEqual({ rev1: "REJECTED", rev2: "APPROVED", step: "open", run: "COMPLETED" });
  });

  it("giao diện đọc thể hiện đúng HAI vòng đời: trục thực hiện và trục chất lượng độc lập, rework là item mới + revision mới", async () => {
    const view = await readTwoLifecycles(db, RUN);
    expect(view.run).toMatchObject({ id: RUN, state: "COMPLETED" });

    // Trục THỰC HIỆN: hai work-item, cả hai COMPLETED; item rework liên kết
    // item cũ + phiên bản cũ — item cũ KHÔNG bị mở lại.
    expect(view.workItems).toEqual([
      { id: WI1, state: "COMPLETED", executor, reworkOfWorkItemId: null, reworkOfOutputRef: null },
      {
        id: WI_RW,
        state: "COMPLETED",
        executor,
        reworkOfWorkItemId: WI1,
        reworkOfOutputRef: { outputId: OUT, revision: 1 },
      },
    ]);

    // Trục CHẤT LƯỢNG: một dòng đầu ra, hai phiên bản — rev1 REJECTED với
    // quyết định reject CÒN hiệu lực trên chính nó; rev2 APPROVED với quyết
    // định approve; hai vòng đời không suy ra nhau.
    expect(view.outputs).toHaveLength(1);
    const [output] = view.outputs;
    expect(output.id).toBe(OUT);
    expect(output.versions).toEqual([
      {
        revision: 1,
        state: "REJECTED",
        workItemId: WI1,
        replacesRevision: null,
        qualityContractRef: qcRef,
        evidencedChecks: ["independent-review", "self-check"],
        decisions: [
          {
            recordId: `AR-${RUN}-1`,
            outcome: "reject",
            actor: decider,
            effective: true,
            invalidationReason: null,
          },
        ],
      },
      {
        revision: 2,
        state: "APPROVED",
        workItemId: WI_RW,
        replacesRevision: 1,
        qualityContractRef: qcRef,
        evidencedChecks: ["independent-review", "self-check"],
        decisions: [
          {
            recordId: `AR-${RUN}-2`,
            outcome: "approve",
            actor: decider,
            effective: true,
            invalidationReason: null,
          },
        ],
      },
    ]);
    expect(view.steps).toEqual([{ stepId: "T3", state: "open", openedByRecordId: `AR-${RUN}-2` }]);
  });

  it("sweep không-đường-lùi: transition ngoài bảng bị chặn kèm vệt audit, trạng thái không đổi", async () => {
    // Dựng một run RUNNING với rev1 APPROVED để sweep không bị SFR-057 che.
    const RUN2 = "RUN-FX04-SWEEP";
    const WI2 = "WI-FX04-SWEEP";
    const OUT2 = "OUT-FX04-SWEEP";
    await requestTestRun(db, cmd("sw-run"), {
      runId: RUN2,
      definitionRef: { definitionId: "DEF-FX04" },
      decider,
      pod: fx02.fixture_package.pod,
      fixturePackage: { id: "FX-04", executor },
    });
    await activateSopRun(db, cmd("sw-act"), { runId: RUN2, workItemId: WI2 });
    await runFixtureExecution(db, cmd("sw-exec"), {
      workItemId: WI2,
      executor,
      outputId: OUT2,
      outputRevision: 1,
      contentSha256: outRev1,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    await validateSelfCheck(db, cmd("sw-self"), {
      outputId: OUT2,
      outputRevision: 1,
      evidence: { ref: "SC", sha256: selfRev1, targetSha256: outRev1, by: executor },
      expectedSha256: selfRev1,
    });
    await reviewFixtureExecution(db, cmd("sw-rev"), {
      workItemId: WI2,
      outputId: OUT2,
      outputRevision: 1,
      executor,
      reviewer: "FIXTURE-REVIEWER-001",
      reviewEvidence: { ref: "RE", sha256: reviewRev1, targetSha256: outRev1, conclusion: "ready" },
      expectedReviewSha256: reviewRev1,
    });
    await advanceToDecision(db, cmd("sw-adv"), {
      runId: RUN2,
      outputId: OUT2,
      outputRevision: 1,
      packageId: `PKG-${RUN2}`,
      packageRevision: 1,
      refs: { outputId: OUT2, revision: 1, sha256: outRev1 },
      requestId: `REQ-${RUN2}`,
    });
    await recordApproval(db, cmd("sw-approve"), {
      requestId: `REQ-${RUN2}`,
      recordId: `AR-${RUN2}`,
      packageId: `PKG-${RUN2}`,
      packageRevision: 1,
      pinnedRefs: { outputId: OUT2, revision: 1, sha256: outRev1 },
      actor: decider,
      outputId: OUT2,
      outputRevision: 1,
    });

    // Bảng sweep: (nhãn ô ngoài bảng, thunk, mã chặn kỳ vọng). Mỗi ca phải
    // để lại vệt audit CommandRejected và không đổi trạng thái.
    const sweep: Array<{ label: string; commandId: string; run: () => Promise<unknown>; code: string }> = [
      {
        label: "APPROVED nhận lại validate-self-check (đường lùi SELF_CHECK)",
        commandId: cmd("sw-n1"),
        run: () =>
          validateSelfCheck(db, "KC14-B6-SW-N1", {
            outputId: OUT2,
            outputRevision: 1,
            evidence: { ref: "SC", sha256: selfRev1, targetSha256: outRev1, by: executor },
            expectedSha256: selfRev1,
          }),
        code: "ERR-STATE",
      },
      {
        label: "work-item COMPLETED nhận lại run-fixture-execution",
        commandId: cmd("sw-n2"),
        run: () =>
          runFixtureExecution(db, "KC14-B6-SW-N2", {
            workItemId: WI2,
            executor,
            outputId: `${OUT2}-X`,
            outputRevision: 1,
            contentSha256: outRev1,
            outputType: "code-change",
            qualityContractRef: qcRef,
          }),
        code: "DEV-010",
      },
      {
        label: "work-item COMPLETED nhận lại run-fixture-review",
        commandId: cmd("sw-n3"),
        run: () =>
          reviewFixtureExecution(db, "KC14-B6-SW-N3", {
            workItemId: WI2,
            outputId: OUT2,
            outputRevision: 1,
            executor,
            reviewer: "FIXTURE-REVIEWER-001",
            reviewEvidence: { ref: "RE", sha256: reviewRev1, targetSha256: outRev1, conclusion: "ready" },
            expectedReviewSha256: reviewRev1,
          }),
        code: "ERR-STATE",
      },
      {
        label: "APPROVED nhận thêm bằng chứng kiểm",
        commandId: cmd("sw-n4"),
        run: () =>
          attachCheckEvidence(db, "KC14-B6-SW-N4", {
            outputId: OUT2,
            outputRevision: 1,
            checkKey: "self-check",
            evidence: { ref: "SC", sha256: selfRev1, targetSha256: outRev1, by: executor },
            expectedSha256: selfRev1,
          }),
        code: "ERR-STATE",
      },
      {
        label: "APPROVED bị trình điểm lần nữa (không CHECK_PASSED)",
        commandId: cmd("sw-n5"),
        run: () =>
          advanceToDecision(db, "KC14-B6-SW-N5", {
            runId: RUN2,
            outputId: OUT2,
            outputRevision: 1,
            packageId: `PKG-${RUN2}`,
            packageRevision: 2,
            refs: { again: true },
            requestId: `REQ-${RUN2}-X`,
          }),
        code: "AC-FR-24.2",
      },
      {
        label: "quyết định lần hai trên yêu cầu đã DECIDED",
        commandId: cmd("sw-n6"),
        run: () =>
          recordApproval(db, "KC14-B6-SW-N6", {
            requestId: `REQ-${RUN2}`,
            recordId: `AR-${RUN2}-X`,
            packageId: `PKG-${RUN2}`,
            packageRevision: 1,
            pinnedRefs: { outputId: OUT2, revision: 1, sha256: outRev1 },
            actor: decider,
            outputId: OUT2,
            outputRevision: 1,
          }),
        code: "SFR-048",
      },
    ];

    for (const entry of sweep) {
      await expect(entry.run(), entry.label).rejects.toMatchObject({ code: entry.code });
    }
    // Vệt audit bất biến cho từng ca chặn (SQR-001/002).
    for (const auditId of ["KC14-B6-SW-N1", "KC14-B6-SW-N2", "KC14-B6-SW-N3", "KC14-B6-SW-N4", "KC14-B6-SW-N5", "KC14-B6-SW-N6"]) {
      const audit = (await db.execute(sql`
        SELECT count(*)::int AS n FROM message_store.messages
        WHERE stream_name = ${"dopaiosAudit-" + auditId} AND type = 'CommandRejected'
      `)) as unknown as Array<{ n: number }>;
      expect(audit[0].n, `audit ${auditId}`).toBe(1);
    }
    // Trạng thái không đổi sau sweep.
    const state = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT2} AND revision = 1) AS version,
        (SELECT state FROM dopaios_work_items WHERE id = ${WI2}) AS work_item,
        (SELECT count(*)::int FROM dopaios_output_versions WHERE id = ${OUT2 + "-X"}) AS stray
    `)) as unknown as Array<Record<string, unknown>>;
    expect(state[0]).toEqual({ version: "APPROVED", work_item: "COMPLETED", stray: 0 });
  });

  it("replay dựng lại đúng chuỗi rev1 REJECTED → rework → rev2 APPROVED (SQR-003, byte-identical)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);

    const view = await readTwoLifecycles(db, RUN);
    expect(view.outputs[0].versions.map((v) => [v.revision, v.state])).toEqual([
      [1, "REJECTED"],
      [2, "APPROVED"],
    ]);
  });
});
