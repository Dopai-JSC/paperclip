import { readFileSync } from "node:fs";
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
} from "../dopaios/commands.ts";
import { cancelTestRun } from "../dopaios/exceptions.ts";
import { declareWorkItemDependency } from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-15 B4 — ca kiểm thử 3 của tiêu chí đạt: "lệnh hủy xử lý hết work-item
// mở mà không tính chúng là hoàn thành (cascade nguyên tử với disposition
// từng nghĩa vụ, theo FS-003 SFR-057 và SC-008)".
//
// QD-5: TÁI DÙNG cancelTestRun của KC-14 B5 — không lệnh hủy mới; phần KC-15
// là chứng minh trên ĐỒ THỊ NHIỀU NHÁNH: enumeration nghĩa vụ phủ đủ mọi
// nhánh (đối chiếu tập node/nghĩa vụ tính độc lập từ đồ thị), tiêm lỗi thiếu
// một disposition → thất bại nguyên tử, và sau terminal thì CẢ lệnh khai
// cạnh đồ thị cũng bị từ chối (SFR-057).
//
// Đồ thị run (hai nhánh + hợp lưu):
//   WI-M1 ◄── WI-M2            nhánh M; M1 xong với approve-with-conditions
//   WI-N1 ◄── WI-N2 ──► WI-M1  N2 hợp lưu: phụ thuộc cả N1 và M1
// Trạng thái lúc hủy: M1/N1 COMPLETED (M1 ACCEPTED + condition mở; N1 đang
// AWAITING_DECISION với yêu cầu mở); M2 SUBMITTED giữa chuỗi; N2 ACCEPTED
// đang bị chặn bởi N1.

const fx02 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-02-run-test-chain.json", import.meta.url), "utf8"),
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
    `Skipping Dopaios KC-15 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC15-B4-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-15 B4 — ca 3: hủy cascade nguyên tử trên đồ thị nhiều nhánh", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  const sopSha = componentSha("sop-business-test");
  const outSha = componentSha("t1-output-rev1");
  const selfSha = componentSha("t1-selfcheck-rev1");
  const reviewSha = componentSha("t1-review-evidence-rev1");

  const RUN = "RUN-KC15-C3";
  const executor = fx02.fixture_package.executor as string;
  const reviewer = "FIXTURE-REVIEWER-001";
  const decider = fx02.fixture_package.decider as string;
  const pod = fx02.fixture_package.pod as string;

  const OUT = (wi: string) => `OUT-${wi}`;

  async function runChainToCheckPassed(wi: string): Promise<void> {
    await runFixtureExecution(db, cmd(`exec-${wi}`), {
      workItemId: wi,
      executor,
      outputId: OUT(wi),
      outputRevision: 1,
      contentSha256: outSha,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    await validateSelfCheck(db, cmd(`self-${wi}`), {
      outputId: OUT(wi),
      outputRevision: 1,
      evidence: { ref: "t1-selfcheck-rev1.json", sha256: selfSha, targetSha256: outSha, by: executor },
      expectedSha256: selfSha,
    });
    await reviewFixtureExecution(db, cmd(`review-${wi}`), {
      workItemId: wi,
      outputId: OUT(wi),
      outputRevision: 1,
      executor,
      reviewer,
      reviewEvidence: {
        ref: "t1-review-evidence-rev1.json",
        sha256: reviewSha,
        targetSha256: outSha,
        conclusion: "ready",
      },
      expectedReviewSha256: reviewSha,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc15-b4-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("a-decider"), {
      actorId: decider,
      kind: "human",
      active: true,
      capabilities: ["run-decider"],
    });
    await registerActor(db, cmd("a-pod"), {
      actorId: pod,
      kind: "human",
      active: true,
      capabilities: ["pod"],
    });
    await registerActor(db, cmd("a-ai"), {
      actorId: "AI-STAFF-KC15",
      kind: "ai",
      active: true,
      capabilities: [],
    });
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-KC15-B4",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC15-B4",
      registeredBy: decider,
    });
    await registerApprovedArtifact(db, cmd("sop"), {
      artifactId: "SOP-KC15-B4",
      revision: 1,
      sha256: sopSha,
    });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-KC15-B4",
      revision: 1,
      sopPin: { artifactId: "SOP-KC15-B4", revision: 1, sha256: sopSha },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-KC15-B4",
      definitionContentSha256: sopSha,
      expectedSopSha256: sopSha,
    });
    await requestTestRun(db, cmd("run"), {
      runId: RUN,
      definitionRef: { definitionId: "DEF-KC15-B4" },
      decider,
      pod,
      fixturePackage: { id: "KC15-C3", reuses: "FX-02", executor },
    });
    await activateSopRun(db, cmd("act"), { runId: RUN, workItemId: "WI-M1" });
    await executeCommand(db, {
      commandId: cmd("seed-items"),
      payload: {},
      handler: async (ctx) => {
        for (const itemId of ["WI-M2", "WI-N1", "WI-N2"]) {
          await ctx.emit({
            streamName: `dopaiosWorkItem-${itemId}`,
            type: "WorkItemCreated",
            data: { workItemId: itemId, runId: RUN, state: "PROPOSED" },
            expectedVersion: -1,
          });
          await ctx.emit({
            streamName: `dopaiosWorkItem-${itemId}`,
            type: "WorkItemStateChanged",
            data: { workItemId: itemId, state: "ACCEPTED" },
          });
        }
        return { seeded: 3 };
      },
    });
    for (const [from, to] of [
      ["WI-M2", "WI-M1"],
      ["WI-N2", "WI-N1"],
      ["WI-N2", "WI-M1"],
    ] as Array<[string, string]>) {
      await declareWorkItemDependency(db, cmd(`edge-${from}-${to}`), {
        workItemId: from,
        dependsOnWorkItemId: to,
        declaredBy: decider,
        basis: { needsOutputOf: to },
      });
    }

    // Nhánh M: M1 trọn chuỗi, approve-with-conditions (condition mở, không
    // chặn bước) mở T-M2; M2 thực thi tới SUBMITTED (giữa chuỗi kiểm).
    await runChainToCheckPassed("WI-M1");
    await advanceToDecision(db, cmd("adv-m1"), {
      runId: RUN,
      outputId: OUT("WI-M1"),
      outputRevision: 1,
      packageId: "PKG-WI-M1",
      packageRevision: 1,
      refs: { outputId: OUT("WI-M1"), revision: 1, sha256: outSha },
      requestId: "REQ-WI-M1",
    });
    await recordApproval(db, cmd("awc-m1"), {
      requestId: "REQ-WI-M1",
      recordId: "AR-WI-M1-1",
      packageId: "PKG-WI-M1",
      packageRevision: 1,
      pinnedRefs: { outputId: OUT("WI-M1"), revision: 1, sha256: outSha },
      actor: decider,
      outputId: OUT("WI-M1"),
      outputRevision: 1,
      outcome: "approve-with-conditions",
      conditions: [
        {
          conditionId: "COND-M1",
          scope: { part: "phần dữ liệu mẫu" },
          risk: "thấp",
          owner: pod,
          deadline: "2027-01-01T00:00:00.000Z",
          closureCriteria: "bổ sung bộ dữ liệu mẫu đầy đủ",
          blocksNextStep: false,
        },
      ],
      openedStep: "T-M2",
    });
    await runFixtureExecution(db, cmd("exec-m2"), {
      workItemId: "WI-M2",
      executor,
      outputId: OUT("WI-M2"),
      outputRevision: 1,
      contentSha256: outSha,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });

    // Nhánh N: N1 trọn chuỗi tới AWAITING_DECISION (yêu cầu quyết định MỞ);
    // N2 hợp lưu còn ACCEPTED (bị chặn bởi N1 chưa duyệt).
    await runChainToCheckPassed("WI-N1");
    await advanceToDecision(db, cmd("adv-n1"), {
      runId: RUN,
      outputId: OUT("WI-N1"),
      outputRevision: 1,
      packageId: "PKG-WI-N1",
      packageRevision: 1,
      refs: { outputId: OUT("WI-N1"), revision: 1, sha256: outSha },
      requestId: "REQ-WI-N1",
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const FULL_DISPOSITIONS: Record<string, string> = {
    "output:OUT-WI-M2@1": "đang giữa chuỗi kiểm — kết thúc theo dõi, giữ nguyên lifecycle (SFR-057)",
    "output:OUT-WI-N1@1": "đang chờ quyết định — kết thúc theo dõi, giữ nguyên lifecycle (SFR-057)",
    "request:REQ-WI-N1": "yêu cầu quyết định đóng theo record hủy, không quyết định nào được ghi",
    "condition:COND-M1": "nghĩa vụ theo dõi condition kết thúc theo record hủy (SFR-057)",
  };

  it("S1: thiếu MỘT disposition → toàn lệnh hủy thất bại nguyên tử, không trạng thái nửa chừng", async () => {
    const partial = { ...FULL_DISPOSITIONS };
    delete partial["condition:COND-M1"];
    await expect(
      cancelTestRun(db, "KC15-B4-CANCEL-PARTIAL", {
        runId: RUN,
        actor: decider,
        reason: "đổi hướng nghiệp vụ — dừng run",
        dispositions: partial,
      }),
    ).rejects.toMatchObject({
      code: "SFR-057",
      message: expect.stringContaining("condition:COND-M1"),
    });
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_sop_runs WHERE id = ${RUN}) AS run,
        (SELECT count(*)::int FROM dopaios_work_items WHERE run_id = ${RUN} AND state = 'CANCELLED') AS cancelled,
        (SELECT count(*)::int FROM message_store.messages
          WHERE type = 'CommandRejected' AND data->>'commandId' = 'KC15-B4-CANCEL-PARTIAL') AS audit
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ run: "RUNNING", cancelled: 0, audit: 1 });
  });

  it("S2: sai thẩm quyền bị chặn — actor không phải decider, AI không có quyền hủy (SFR-051/023)", async () => {
    await expect(
      cancelTestRun(db, "KC15-B4-CANCEL-POD", {
        runId: RUN,
        actor: pod,
        reason: "thử hủy sai thẩm quyền",
        dispositions: FULL_DISPOSITIONS,
      }),
    ).rejects.toMatchObject({ code: "SFR-051" });
    await expect(
      cancelTestRun(db, "KC15-B4-CANCEL-AI", {
        runId: RUN,
        actor: "AI-STAFF-KC15",
        reason: "AI thử hủy",
        dispositions: FULL_DISPOSITIONS,
      }),
    ).rejects.toMatchObject({ code: "SFR-051" });
  });

  it("S3: hủy nguyên tử — mọi work-item mở trên MỌI nhánh CANCELLED, disposition đủ từng nghĩa vụ", async () => {
    const result = await cancelTestRun(db, "KC15-B4-CANCEL", {
      runId: RUN,
      actor: decider,
      reason: "đổi hướng nghiệp vụ — dừng run",
      dispositions: FULL_DISPOSITIONS,
    });
    expect(result).toMatchObject({
      state: "CANCELLED",
      cancelledWorkItems: 2,
      dispositionedObligations: 4,
    });

    // Đối chiếu ĐỒ THỊ: mọi node của run nằm đúng một trong hai tập —
    // terminal sẵn (COMPLETED, giữ nguyên lịch sử) hoặc CANCELLED (không
    // tính sản lượng); không node nào bị bỏ sót trên bất kỳ nhánh nào.
    const nodes = (await db.execute(sql`
      SELECT DISTINCT node FROM (
        SELECT work_item_id AS node FROM dopaios_work_item_dependencies WHERE run_id = ${RUN}
        UNION
        SELECT depends_on_work_item_id FROM dopaios_work_item_dependencies WHERE run_id = ${RUN}
      ) g ORDER BY node
    `)) as unknown as Array<{ node: string }>;
    expect(nodes.map((n) => n.node)).toEqual(["WI-M1", "WI-M2", "WI-N1", "WI-N2"]);
    const states = (await db.execute(
      sql`SELECT id, state FROM dopaios_work_items WHERE run_id = ${RUN} ORDER BY id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(states).toEqual([
      { id: "WI-M1", state: "COMPLETED" },
      { id: "WI-M2", state: "CANCELLED" },
      { id: "WI-N1", state: "COMPLETED" },
      { id: "WI-N2", state: "CANCELLED" },
    ]);

    // Phiên bản đầu ra GIỮ NGUYÊN lifecycle (trục đầu ra không có trạng thái
    // hủy); record hủy bất biến mang lý do + disposition từng nghĩa vụ.
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-M2")} AND revision = 1) AS m2,
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-N1")} AND revision = 1) AS n1,
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-M1")} AND revision = 1) AS m1,
        (SELECT count(*)::int FROM message_store.messages
          WHERE type = 'RunCancellationRecorded' AND data->>'runId' = ${RUN}) AS records
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ m2: "SUBMITTED", n1: "AWAITING_DECISION", m1: "ACCEPTED", records: 1 });

    const cancellation = (await db.execute(sql`
      SELECT data FROM message_store.messages
      WHERE type = 'RunCancellationRecorded' AND data->>'runId' = ${RUN}
    `)) as unknown as Array<{ data: { obligations: string[]; dispositions: Record<string, string> } }>;
    expect([...cancellation[0].data.obligations].sort()).toEqual(Object.keys(FULL_DISPOSITIONS).sort());
    expect(cancellation[0].data.dispositions).toEqual(FULL_DISPOSITIONS);
  });

  it("S4: run terminal từ chối mọi lệnh — kể cả khai cạnh đồ thị và complete (không tính là hoàn thành)", async () => {
    await expect(
      declareWorkItemDependency(db, "KC15-B4-EDGE-AFTER", {
        workItemId: "WI-M2",
        dependsOnWorkItemId: "WI-N1",
        declaredBy: decider,
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
    await expect(
      validateSelfCheck(db, "KC15-B4-SELF-AFTER", {
        outputId: OUT("WI-M2"),
        outputRevision: 1,
        evidence: { ref: "t1-selfcheck-rev1.json", sha256: selfSha, targetSha256: outSha, by: executor },
        expectedSha256: selfSha,
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
    await expect(
      recordApproval(db, "KC15-B4-DECIDE-AFTER", {
        requestId: "REQ-WI-N1",
        recordId: "AR-WI-N1-1",
        packageId: "PKG-WI-N1",
        packageRevision: 1,
        pinnedRefs: { outputId: OUT("WI-N1"), revision: 1, sha256: outSha },
        actor: decider,
        outputId: OUT("WI-N1"),
        outputRevision: 1,
        outcome: "approve",
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
    await expect(
      completeSopRun(db, "KC15-B4-COMPLETE-AFTER", { runId: RUN }),
    ).rejects.toMatchObject({ code: "SFR-057" });
    // Hủy lần hai cũng bị từ chối — terminal không lặp.
    await expect(
      cancelTestRun(db, "KC15-B4-CANCEL-AGAIN", {
        runId: RUN,
        actor: decider,
        reason: "hủy lần hai",
        dispositions: {},
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });
  });

  it("S5: replay dựng lại toàn kịch bản byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
