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
  type CommandContext,
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
  answerClarification,
} from "../dopaios/commands.ts";
import { declareWorkItemDependency, transitiveDependents } from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-15 B2 — ca kiểm thử 1 của tiêu chí đạt: "thiếu thông tin chỉ dừng nhánh
// phụ thuộc (đối chiếu 'đúng impact set' của FS-003 SFR-031/050)".
// "Thiếu thông tin" hiện thực bằng cơ chế sẵn có request-more-information /
// Yêu cầu clarification (SFR-046) — QD-3, không dựng loại chặn mới; chặn
// nhánh là cách đọc đồ thị qua graph-repo tại ready-check (QD-2).
//
// Đồ thị của run (hai nhánh độc lập + chuỗi sâu, QD-6 — kịch bản KC-15 trên
// hash pin thành phần FX-02, không mở revision danh mục V-09):
//
//   WI-A1 ◄── WI-A2 ◄── WI-A3     nhánh A (A3 phụ thuộc A2 phụ thuộc A1)
//   WI-B1 ◄── WI-B2               nhánh B độc lập
//
// Kịch bản: điểm phê duyệt đầu ra của WI-A1 nhận RMI ("thiếu thông tin") →
// toàn hạ nguồn nhánh A dừng tại ready-check; nhánh B chạy trọn tới
// COMPLETED. Sau khi Pod trả lời và người quyết định approve trên gói
// revision mới, nhánh A mở lại ĐÚNG từng mức theo hiệu lực approval.

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
    `Skipping Dopaios KC-15 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC15-B2-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-15 B2 — ca 1: thiếu thông tin chỉ dừng nhánh phụ thuộc", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  const sopSha = componentSha("sop-business-test");
  const outSha = componentSha("t1-output-rev1");
  const selfSha = componentSha("t1-selfcheck-rev1");
  const reviewSha = componentSha("t1-review-evidence-rev1");

  const RUN = "RUN-KC15-C1";
  const executor = fx02.fixture_package.executor as string;
  const reviewer = "FIXTURE-REVIEWER-001";
  const decider = fx02.fixture_package.decider as string;
  const pod = fx02.fixture_package.pod as string;

  const OUT = (wi: string) => `OUT-${wi}`;

  async function inCommand<T>(commandId: string, fn: (ctx: CommandContext) => Promise<T>): Promise<T> {
    let out!: T;
    await executeCommand(db, {
      commandId,
      payload: { read: commandId },
      handler: async (ctx) => {
        out = await fn(ctx);
        return { ok: true };
      },
    });
    return out;
  }

  async function seedAcceptedWorkItems(commandId: string, itemIds: string[]): Promise<void> {
    // Scaffolding fixture: item ngoài item kích hoạt đầu tiên vào bằng event
    // PROPOSED → ACCEPTED (máy-kiểm) — việc TẠO item theo định nghĩa SOP
    // thuộc KC-06, không thuộc câu hỏi KC-15.
    await executeCommand(db, {
      commandId,
      payload: { itemIds },
      handler: async (ctx) => {
        for (const itemId of itemIds) {
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
        return { seeded: itemIds.length };
      },
    });
  }

  // Chuỗi FS-003 chuẩn của một work-item: thực thi → tự kiểm → review độc lập
  // (COMPLETED + CHECK_PASSED khi hợp đồng 2 kiểm đủ bằng chứng).
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

  async function advanceAndDecide(
    wi: string,
    step: string,
    outcome: "approve" | "request-more-information",
    extra?: { requiredInfo?: string; clarificationRequestId?: string },
  ): Promise<void> {
    await advanceToDecision(db, cmd(`adv-${wi}`), {
      runId: RUN,
      outputId: OUT(wi),
      outputRevision: 1,
      packageId: `PKG-${wi}`,
      packageRevision: 1,
      refs: { outputId: OUT(wi), revision: 1, sha256: outSha },
      requestId: `REQ-${wi}`,
    });
    await recordApproval(db, cmd(`dec-${wi}`), {
      requestId: `REQ-${wi}`,
      recordId: `AR-${wi}-1`,
      packageId: `PKG-${wi}`,
      packageRevision: 1,
      pinnedRefs: { outputId: OUT(wi), revision: 1, sha256: outSha },
      actor: decider,
      outputId: OUT(wi),
      outputRevision: 1,
      outcome,
      ...(outcome === "approve" ? { openedStep: step } : {}),
      ...(extra ?? {}),
    });
  }

  async function itemStates(ids: string[]): Promise<Record<string, string>> {
    const rows = (await db.execute(
      sql`SELECT id, state FROM dopaios_work_items
          WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`,
    )) as unknown as Array<{ id: string; state: string }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.state]));
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc15-b2-");
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
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-KC15",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC15-B2",
      registeredBy: decider,
    });
    await registerApprovedArtifact(db, cmd("sop"), {
      artifactId: "SOP-KC15",
      revision: 1,
      sha256: sopSha,
    });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-KC15",
      revision: 1,
      sopPin: { artifactId: "SOP-KC15", revision: 1, sha256: sopSha },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-KC15",
      definitionContentSha256: sopSha,
      expectedSopSha256: sopSha,
    });
    await requestTestRun(db, cmd("run"), {
      runId: RUN,
      definitionRef: { definitionId: "DEF-KC15" },
      decider,
      pod,
      fixturePackage: { id: "KC15-C1", reuses: "FX-02", executor },
    });
    await activateSopRun(db, cmd("act"), { runId: RUN, workItemId: "WI-A1" });
    await seedAcceptedWorkItems(cmd("seed-items"), ["WI-A2", "WI-A3", "WI-B1", "WI-B2"]);
    for (const [from, to] of [
      ["WI-A2", "WI-A1"],
      ["WI-A3", "WI-A2"],
      ["WI-B2", "WI-B1"],
    ] as Array<[string, string]>) {
      await declareWorkItemDependency(db, cmd(`edge-${from}`), {
        workItemId: from,
        dependsOnWorkItemId: to,
        declaredBy: decider,
        basis: { needsOutputOf: to },
      });
    }
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("S1: WI-A1 tới điểm phê duyệt, RMI 'thiếu thông tin' giữ cổng đóng (SFR-046)", async () => {
    await runChainToCheckPassed("WI-A1");
    await advanceAndDecide("WI-A1", "T-A2", "request-more-information", {
      requiredInfo: "Thiếu nguồn dữ liệu cho mục 2 của đầu ra",
      clarificationRequestId: "CLAR-A1",
    });
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-A1")} AND revision = 1) AS version,
        (SELECT state FROM dopaios_decision_packages WHERE id = 'PKG-WI-A1' AND revision = 1) AS pkg,
        (SELECT state FROM dopaios_action_requests WHERE id = 'CLAR-A1') AS clar,
        (SELECT count(*)::int FROM dopaios_run_steps WHERE run_id = ${RUN}) AS steps
    `)) as unknown as Array<Record<string, unknown>>;
    // Đầu ra GIỮ AWAITING_DECISION, gói chờ bổ sung, KHÔNG bước nào mở.
    expect(rows[0]).toEqual({ version: "AWAITING_DECISION", pkg: "AWAITING_INFO", clar: "OPEN", steps: 0 });
  });

  it("S2: hạ nguồn nhánh A bị chặn tại ready-check — đúng nhánh, đúng lý do từng mức", async () => {
    await expect(
      runFixtureExecution(db, "KC15-B2-BLOCK-A2", {
        workItemId: "WI-A2",
        executor,
        outputId: OUT("WI-A2"),
        outputRevision: 1,
        contentSha256: outSha,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
    ).rejects.toMatchObject({
      code: "ERR-DEP-UNSATISFIED",
      message: expect.stringContaining("WI-A1:output-not-effectively-approved"),
    });
    await expect(
      runFixtureExecution(db, "KC15-B2-BLOCK-A3", {
        workItemId: "WI-A3",
        executor,
        outputId: OUT("WI-A3"),
        outputRevision: 1,
        contentSha256: outSha,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
    ).rejects.toMatchObject({
      code: "ERR-DEP-UNSATISFIED",
      message: expect.stringContaining("WI-A2:upstream-not-completed"),
    });
    // Trạng thái không đổi; hai lần chặn để lại vệt audit bất biến.
    expect(await itemStates(["WI-A2", "WI-A3"])).toEqual({ "WI-A2": "ACCEPTED", "WI-A3": "ACCEPTED" });
    const audits = (await db.execute(
      sql`SELECT count(*)::int AS n FROM message_store.messages
          WHERE type = 'CommandRejected' AND data->>'commandId' LIKE 'KC15-B2-BLOCK-%'`,
    )) as unknown as Array<{ n: number }>;
    expect(audits[0].n).toBe(2);
  });

  it("S3: nhánh B độc lập chạy trọn — không chặn thừa ('đúng impact set' hai chiều)", async () => {
    await runChainToCheckPassed("WI-B1");
    await advanceAndDecide("WI-B1", "T-B2", "approve");
    await runChainToCheckPassed("WI-B2");
    expect(await itemStates(["WI-B1", "WI-B2"])).toEqual({
      "WI-B1": "COMPLETED",
      "WI-B2": "COMPLETED",
    });
    // Tập bị chặn đúng bằng tập hạ nguồn bắc cầu của WI-A1 theo graph-repo.
    const blockedSet = await inCommand("KC15-B2-READ-IMPACT", (ctx) =>
      transitiveDependents(ctx, ["WI-A1"]),
    );
    expect(blockedSet).toEqual(["WI-A2", "WI-A3"]);
    const states = await itemStates(["WI-A2", "WI-A3", "WI-B1", "WI-B2"]);
    expect(states["WI-A2"]).toBe("ACCEPTED");
    expect(states["WI-A3"]).toBe("ACCEPTED");
    expect(states["WI-B1"]).toBe("COMPLETED");
    expect(states["WI-B2"]).toBe("COMPLETED");
  });

  it("S4: trả lời bổ sung + approve gói revision mới mở lại nhánh A ĐÚNG TỪNG MỨC", async () => {
    // Pod trả lời — gói revision 2 supersede + đúng một yêu cầu quyết định mới
    // (SFR-047); quyết định approve trên gói mới mở bước T-A2.
    await answerClarification(db, cmd("answer"), {
      clarificationRequestId: "CLAR-A1",
      answer: "Nguồn dữ liệu mục 2: bảng chuẩn FX-02, pin sha256 thành phần",
      answeredBy: pod,
      packageId: "PKG-WI-A1",
      newPackageRevision: 2,
      refs: { outputId: OUT("WI-A1"), revision: 1, sha256: outSha, answered: true },
      newDecisionRequestId: "REQ-WI-A1-2",
      outputId: OUT("WI-A1"),
      outputRevision: 1,
    });
    await recordApproval(db, cmd("approve-a1"), {
      requestId: "REQ-WI-A1-2",
      recordId: "AR-WI-A1-2",
      packageId: "PKG-WI-A1",
      packageRevision: 2,
      pinnedRefs: { outputId: OUT("WI-A1"), revision: 1, sha256: outSha, answered: true },
      actor: decider,
      outputId: OUT("WI-A1"),
      outputRevision: 1,
      outcome: "approve",
      openedStep: "T-A2",
    });

    // WI-A2 mở lại (phụ thuộc WI-A1 nay hiệu lực) và chạy trọn chuỗi.
    await runChainToCheckPassed("WI-A2");
    expect((await itemStates(["WI-A2"]))["WI-A2"]).toBe("COMPLETED");

    // WI-A3 vẫn bị chặn: đầu ra WI-A2 mới qua kiểm, CHƯA được duyệt hiệu lực
    // — mở theo hiệu lực approval từng mức, không mở dây chuyền.
    await expect(
      runFixtureExecution(db, "KC15-B2-BLOCK-A3-2", {
        workItemId: "WI-A3",
        executor,
        outputId: OUT("WI-A3"),
        outputRevision: 1,
        contentSha256: outSha,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
    ).rejects.toMatchObject({
      code: "ERR-DEP-UNSATISFIED",
      message: expect.stringContaining("WI-A2:output-not-effectively-approved"),
    });

    // Duyệt đầu ra WI-A2 → WI-A3 mở, chạy trọn.
    await advanceAndDecide("WI-A2", "T-A3", "approve");
    await runChainToCheckPassed("WI-A3");
    const states = await itemStates(["WI-A1", "WI-A2", "WI-A3"]);
    expect(states).toEqual({ "WI-A1": "COMPLETED", "WI-A2": "COMPLETED", "WI-A3": "COMPLETED" });
    const steps = (await db.execute(
      sql`SELECT step_id, state FROM dopaios_run_steps WHERE run_id = ${RUN} ORDER BY step_id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(steps).toEqual([
      { step_id: "T-A2", state: "open" },
      { step_id: "T-A3", state: "open" },
      { step_id: "T-B2", state: "open" },
    ]);
  });

  it("S5: replay dựng lại toàn kịch bản byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
