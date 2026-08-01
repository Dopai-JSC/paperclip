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
} from "../dopaios/commands.ts";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
} from "../dopaios/approval.ts";
import { createArtifactRevision, type SourceRef } from "../dopaios/lifecycle.ts";
import { submitFixtureRevision } from "../dopaios/revisions.ts";
import {
  declareWorkItemDependency,
  transitiveDependents,
  currentOutputsPinningSource,
} from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-15 B3 — ca kiểm thử 2 của tiêu chí đạt: "thay đổi spec chỉ thay thế
// phần bị ảnh hưởng và quay lại đúng cổng (re-entry duy nhất qua revision
// được duyệt, theo FS-002 và Approval Record re-entry của FS-003 SFR-045)".
//
// Spec nguồn là artifact trong sổ FS-002 (đường KC-03 thật); phiên bản đầu
// ra pin nguồn qua source_refs (pin FS-002 — QD-4). Khi nguồn khai đổi nghĩa
// (createArtifactRevision, SFR-010), phần bị ảnh hưởng ở trục run được TÍNH
// từ sổ dùng chung (graph-repo, QD-2) và xử lý bằng đúng cơ chế KC-14:
// ApprovalInvalidated + RunStepReblocked trong CÙNG transaction (SFR-031/050).
// Re-entry: bản sửa pin nguồn superseded bị chặn — chỉ đi qua revision nguồn
// ĐƯỢC DUYỆT (FS-002 d.693-696), quay lại ĐÚNG cổng đã tái chặn.
//
// Đồ thị run (QD-6 — kịch bản KC-15 trên hash pin FX-02):
//   WI-X1 (pin SPEC-S@1) ◄── WI-X2      nhánh X — bị ảnh hưởng
//   WI-Y1 (pin SPEC-T@1) ◄── WI-Y2      nhánh Y — độc lập, đã hoàn thành

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
    `Skipping Dopaios KC-15 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC15-B3-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-15 B3 — ca 2: thay đổi spec chỉ thay thế phần bị ảnh hưởng", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  const sopSha = componentSha("sop-business-test");
  const outSha = componentSha("t1-output-rev1");
  const selfSha = componentSha("t1-selfcheck-rev1");
  const reviewSha = componentSha("t1-review-evidence-rev1");
  const outRev2Sha = componentSha("t1-output-rev2");
  const selfRev2Sha = componentSha("t1-selfcheck-rev2");
  const reviewRev2Sha = componentSha("t1-review-evidence-rev2");

  const SHA_S1 = "c".repeat(64);
  const SHA_S2 = "d".repeat(64);
  const SHA_T1 = "e".repeat(64);

  const RUN = "RUN-KC15-C2";
  const executor = fx02.fixture_package.executor as string;
  const reviewer = "FIXTURE-REVIEWER-001";
  const decider = fx02.fixture_package.decider as string;
  const pod = fx02.fixture_package.pod as string;
  const SPEC_AUTHOR = "SPEC-AUTHOR-KC15";
  const SPEC_APPROVER = "SPEC-APPROVER-KC15";

  const S1: SourceRef = { artifactId: "SPEC-S", revision: 1, sha256: SHA_S1 };
  const S2: SourceRef = { artifactId: "SPEC-S", revision: 2, sha256: SHA_S2 };
  const T1: SourceRef = { artifactId: "SPEC-T", revision: 1, sha256: SHA_T1 };

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

  async function seedApprovedSpec(id: string, sha256: string): Promise<void> {
    await registerDraftArtifact(db, cmd(`spec-draft-${id}`), {
      artifactId: id,
      revision: 1,
      sha256,
      createdBy: SPEC_AUTHOR,
      artifactType: "source-spec",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd(`spec-submit-${id}`), { artifactId: id, revision: 1 });
    await assembleDecisionPackage(db, cmd(`spec-pkg-${id}`), {
      packageId: `PKG-${id}-r1`,
      revision: 1,
      target: { artifactId: id, revision: 1, sha256 },
      refs: { evidence: `ev-${id}-r1` },
      fields: {},
    });
    await recordApprovalDecision(db, cmd(`spec-approve-${id}`), {
      recordId: `REC-${id}-r1`,
      packageId: `PKG-${id}-r1`,
      packageRevision: 1,
      target: { artifactId: id, revision: 1, sha256 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: `ev-${id}-r1` },
      actor: SPEC_APPROVER,
    });
  }

  async function runChainToCheckPassed(wi: string, sourceRefs?: SourceRef[]): Promise<void> {
    await runFixtureExecution(db, cmd(`exec-${wi}`), {
      workItemId: wi,
      executor,
      outputId: OUT(wi),
      outputRevision: 1,
      contentSha256: outSha,
      outputType: "code-change",
      qualityContractRef: qcRef,
      ...(sourceRefs ? { sourceRefs } : {}),
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

  async function advanceAndApprove(wi: string, step: string): Promise<void> {
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
      outcome: "approve",
      openedStep: step,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc15-b3-");
    db = createDb(tempDb.connectionString);
    for (const [id, actor] of [
      ["a-decider", { actorId: decider, kind: "human", active: true, capabilities: ["run-decider"] }],
      ["a-pod", { actorId: pod, kind: "human", active: true, capabilities: ["pod"] }],
      [
        "a-spec-author",
        { actorId: SPEC_AUTHOR, kind: "human", active: true, capabilities: ["product-governance"] },
      ],
      [
        "a-spec-approver",
        { actorId: SPEC_APPROVER, kind: "human", active: true, capabilities: ["governance-approver"] },
      ],
    ] as Array<[string, Parameters<typeof registerActor>[2]]>) {
      await registerActor(db, cmd(id), actor);
    }
    await pinSeparationPolicy(db, cmd("policy"), {
      policyId: "SEP-SOURCE-SPEC",
      artifactType: "source-spec",
      revision: 1,
      policy: {
        policy_id: "SEP-SOURCE-SPEC",
        scope_level: "company",
        approver_capability: "governance-approver",
        effective_at: "2026-08-01T00:00:00Z",
        invalidation_rule: "revision-superseded",
      },
      pinnedBy: SPEC_APPROVER,
    });
    await seedApprovedSpec("SPEC-S", SHA_S1);
    await seedApprovedSpec("SPEC-T", SHA_T1);
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-KC15-B3",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC15-B3",
      registeredBy: decider,
    });
    await registerApprovedArtifact(db, cmd("sop"), {
      artifactId: "SOP-KC15-B3",
      revision: 1,
      sha256: sopSha,
    });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-KC15-B3",
      revision: 1,
      sopPin: { artifactId: "SOP-KC15-B3", revision: 1, sha256: sopSha },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-KC15-B3",
      definitionContentSha256: sopSha,
      expectedSopSha256: sopSha,
    });
    await requestTestRun(db, cmd("run"), {
      runId: RUN,
      definitionRef: { definitionId: "DEF-KC15-B3" },
      decider,
      pod,
      fixturePackage: { id: "KC15-C2", reuses: "FX-02", executor },
    });
    await activateSopRun(db, cmd("act"), { runId: RUN, workItemId: "WI-X1" });
    await executeCommand(db, {
      commandId: cmd("seed-items"),
      payload: {},
      handler: async (ctx) => {
        for (const itemId of ["WI-X2", "WI-Y1", "WI-Y2"]) {
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
      ["WI-X2", "WI-X1"],
      ["WI-Y2", "WI-Y1"],
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

  it("S1: hai nhánh chạy — X1 duyệt mở T-X2; nhánh Y hoàn thành trọn", async () => {
    await runChainToCheckPassed("WI-X1", [S1]);
    await advanceAndApprove("WI-X1", "T-X2");
    await runChainToCheckPassed("WI-Y1", [T1]);
    await advanceAndApprove("WI-Y1", "T-Y2");
    await runChainToCheckPassed("WI-Y2", [T1]);
    await advanceAndApprove("WI-Y2", "T-Y3");
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-X1")} AND revision = 1) AS x1,
        (SELECT state FROM dopaios_work_items WHERE id = 'WI-Y2') AS y2,
        (SELECT count(*)::int FROM dopaios_run_steps WHERE run_id = ${RUN} AND state = 'open') AS open_steps
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ x1: "APPROVED", y2: "COMPLETED", open_steps: 3 });
  });

  it("S2: spec đổi nghĩa → impact trục run TÍNH TỪ SỔ DÙNG CHUNG, cùng transaction, đúng impact set", async () => {
    // Đọc impact set qua graph-repo trước khi đổi: phần trực tiếp + hạ nguồn.
    const direct = await inCommand("KC15-B3-READ-DIRECT", (ctx) =>
      currentOutputsPinningSource(ctx, "SPEC-S"),
    );
    expect(direct).toEqual([
      { outputId: OUT("WI-X1"), revision: 1, workItemId: "WI-X1", runId: RUN },
    ]);
    const downstream = await inCommand("KC15-B3-READ-DOWN", (ctx) =>
      transitiveDependents(ctx, ["WI-X1"]),
    );
    expect(downstream).toEqual(["WI-X2"]);

    const result = await createArtifactRevision(db, "KC15-B3-SPEC-S-R2", {
      artifactId: "SPEC-S",
      revision: 2,
      sha256: SHA_S2,
      createdBy: SPEC_AUTHOR,
      semanticChange: true,
      dependents: [],
    });
    expect(result["runLevelInvalidated"]).toBe(1);

    const rows = (await db.execute(sql`
      SELECT
        (SELECT invalidation_reason FROM dopaios_approval_records WHERE id = 'AR-WI-X1-1') AS x1_reason,
        (SELECT count(*)::int FROM dopaios_approval_records
          WHERE id IN ('AR-WI-Y1-1', 'AR-WI-Y2-1') AND invalidated_at IS NOT NULL) AS y_invalidated,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${RUN} AND step_id = 'T-X2') AS step_x2,
        (SELECT count(*)::int FROM dopaios_run_steps
          WHERE run_id = ${RUN} AND step_id IN ('T-Y2', 'T-Y3') AND state = 'open') AS y_steps,
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-X1")} AND revision = 1) AS x1_version
    `)) as unknown as Array<Record<string, unknown>>;
    // Approval X1 hết hiệu lực + T-X2 tái chặn; nhánh Y nguyên vẹn; lifecycle
    // của phiên bản X1 KHÔNG bị viết lại (SFR-031/050).
    expect(rows[0]).toEqual({
      x1_reason: "source-changed: SPEC-S@2 khai đổi nghĩa (SFR-031/050)",
      y_invalidated: 0,
      step_x2: "reblocked",
      y_steps: 2,
      x1_version: "APPROVED",
    });
  });

  it("S3: hạ nguồn phần bị ảnh hưởng bị chặn tại ready-check; nhánh Y không bị chạm", async () => {
    await expect(
      runFixtureExecution(db, "KC15-B3-BLOCK-X2", {
        workItemId: "WI-X2",
        executor,
        outputId: OUT("WI-X2"),
        outputRevision: 1,
        contentSha256: outSha,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
    ).rejects.toMatchObject({
      code: "ERR-DEP-UNSATISFIED",
      message: expect.stringContaining("WI-X1:output-not-effectively-approved"),
    });
    const states = (await db.execute(
      sql`SELECT id, state FROM dopaios_work_items WHERE id IN ('WI-X2', 'WI-Y1', 'WI-Y2') ORDER BY id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(states).toEqual([
      { id: "WI-X2", state: "ACCEPTED" },
      { id: "WI-Y1", state: "COMPLETED" },
      { id: "WI-Y2", state: "COMPLETED" },
    ]);
  });

  it("S4: revision nguồn mới được duyệt — bản cũ superseded (SFR-028)", async () => {
    await submitArtifactForReview(db, cmd("spec-s2-submit"), { artifactId: "SPEC-S", revision: 2 });
    await assembleDecisionPackage(db, cmd("spec-s2-pkg"), {
      packageId: "PKG-SPEC-S-r2",
      revision: 1,
      target: { artifactId: "SPEC-S", revision: 2, sha256: SHA_S2 },
      refs: { evidence: "ev-SPEC-S-r2" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-s2-approve"), {
      recordId: "REC-SPEC-S-r2",
      packageId: "PKG-SPEC-S-r2",
      packageRevision: 1,
      target: { artifactId: "SPEC-S", revision: 2, sha256: SHA_S2 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-SPEC-S-r2" },
      actor: SPEC_APPROVER,
    });
    const rows = (await db.execute(
      sql`SELECT revision, artifact_state FROM dopaios_artifacts WHERE id = 'SPEC-S' ORDER BY revision`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { revision: 1, artifact_state: "superseded" },
      { revision: 2, artifact_state: "approved" },
    ]);
  });

  it("S5: re-entry pin nguồn superseded bị chặn — chỉ đi qua revision được duyệt (FS-002)", async () => {
    await expect(
      submitFixtureRevision(db, "KC15-B3-REENTRY-STALE", {
        outputId: OUT("WI-X1"),
        newRevision: 2,
        contentSha256: outRev2Sha,
        outputType: "code-change",
        qualityContractRef: qcRef,
        sourceRefs: [S1],
        selfCheckEvidence: {
          ref: "t1-selfcheck-rev2.json",
          sha256: selfRev2Sha,
          targetSha256: outRev2Sha,
          by: executor,
        },
        expectedSelfCheckSha256: selfRev2Sha,
        reviewEvidence: {
          ref: "t1-review-evidence-rev2.json",
          sha256: reviewRev2Sha,
          targetSha256: outRev2Sha,
          conclusion: "ready",
          by: reviewer,
        },
        expectedReviewSha256: reviewRev2Sha,
      }),
    ).rejects.toMatchObject({
      code: "ERR-SOURCE",
      message: expect.stringContaining("superseded"),
    });
    // Không phiên bản nào bị ghi bởi lệnh bị chặn.
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_output_versions WHERE id = ${OUT("WI-X1")}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);
  });

  it("S6: bản sửa pin nguồn được duyệt vào trục và QUAY LẠI ĐÚNG CỔNG T-X2", async () => {
    const submitted = await submitFixtureRevision(db, "KC15-B3-REENTRY-OK", {
      outputId: OUT("WI-X1"),
      newRevision: 2,
      contentSha256: outRev2Sha,
      outputType: "code-change",
      qualityContractRef: qcRef,
      sourceRefs: [S2],
      selfCheckEvidence: {
        ref: "t1-selfcheck-rev2.json",
        sha256: selfRev2Sha,
        targetSha256: outRev2Sha,
        by: executor,
      },
      expectedSelfCheckSha256: selfRev2Sha,
      reviewEvidence: {
        ref: "t1-review-evidence-rev2.json",
        sha256: reviewRev2Sha,
        targetSha256: outRev2Sha,
        conclusion: "ready",
        by: reviewer,
      },
      expectedReviewSha256: reviewRev2Sha,
      decisionPoint: {
        packageId: "PKG-WI-X1",
        newPackageRevision: 2,
        refs: { outputId: OUT("WI-X1"), revision: 2, sha256: outRev2Sha },
        newDecisionRequestId: "REQ-WI-X1-2",
      },
    });
    expect(submitted).toMatchObject({ newRevision: 2, replacesRevision: 1, state: "AWAITING_DECISION" });

    await recordApproval(db, cmd("approve-x1-r2"), {
      requestId: "REQ-WI-X1-2",
      recordId: "AR-WI-X1-2",
      packageId: "PKG-WI-X1",
      packageRevision: 2,
      pinnedRefs: { outputId: OUT("WI-X1"), revision: 2, sha256: outRev2Sha },
      actor: decider,
      outputId: OUT("WI-X1"),
      outputRevision: 2,
      outcome: "approve",
      openedStep: "T-X2",
    });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-X1")} AND revision = 1) AS rev1,
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-X1")} AND revision = 2) AS rev2,
        (SELECT source_refs FROM dopaios_output_versions WHERE id = ${OUT("WI-X1")} AND revision = 2) AS rev2_sources,
        (SELECT state FROM dopaios_run_steps WHERE run_id = ${RUN} AND step_id = 'T-X2') AS step_x2,
        (SELECT opened_by_record_id FROM dopaios_run_steps WHERE run_id = ${RUN} AND step_id = 'T-X2') AS step_x2_by
    `)) as unknown as Array<Record<string, unknown>>;
    // Rev1 GIỮ APPROVED (lịch sử không viết lại — hiệu lực nằm ở record);
    // rev2 APPROVED; cổng T-X2 mở lại theo ĐÚNG record mới.
    expect(rows[0]).toEqual({
      rev1: "APPROVED",
      rev2: "APPROVED",
      rev2_sources: [{ artifactId: "SPEC-S", revision: 2, sha256: SHA_S2 }],
      step_x2: "open",
      step_x2_by: "AR-WI-X1-2",
    });
  });

  it("S7: phần hạ nguồn mở lại sau re-entry — nhánh Y nguyên vẹn suốt kịch bản", async () => {
    await runChainToCheckPassed("WI-X2");
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_work_items WHERE id = 'WI-X2') AS x2,
        (SELECT count(*)::int FROM dopaios_approval_records WHERE invalidated_at IS NOT NULL) AS invalidated_total,
        (SELECT count(*)::int FROM dopaios_run_steps WHERE run_id = ${RUN} AND state = 'open') AS open_steps
    `)) as unknown as Array<Record<string, unknown>>;
    // Đúng MỘT approval từng hết hiệu lực trong toàn kịch bản (AR-WI-X1-1);
    // ba cổng T-X2/T-Y2/T-Y3 đang mở.
    expect(rows[0]).toEqual({ x2: "COMPLETED", invalidated_total: 1, open_steps: 3 });
  });

  it("S8: replay dựng lại toàn kịch bản byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
