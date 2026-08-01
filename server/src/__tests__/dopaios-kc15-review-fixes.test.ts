import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand, CommandRejectedError } from "../dopaios/event-store.ts";
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
import { cancelTestRun } from "../dopaios/exceptions.ts";
import { declareWorkItemDependency } from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-15 B5 — xử finding vòng review đối kháng 2 lens trên toàn diff B1–B4:
//  - blocker lens 1: impact nguồn-đổi-nghĩa KHÔNG được chạm run terminal
//    (SFR-057);
//  - major lens 1+2: "chặn một phần" phải giữ ở CẢ cửa trình điểm/quyết
//    định/bản sửa/exhibit, không chỉ ready-check một lần; pin nguồn phải có
//    approval hiệu lực thật; quyền khai cạnh; cạnh deadlock chặn tại cửa;
//    payload sourceRefs dị dạng fail-closed; submit-fixture-revision có vệt
//    audit;
//  - major lens 2: bằng chứng TƯƠNG TRANH THẬT (SSI) cho guard đọc-rồi-ghi
//    trên đồ thị dùng chung — pattern hai-lệnh-song-song của KC-14 B7.

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
    `Skipping Dopaios KC-15 B5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC15-B5-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-15 B5 — xử finding review đối kháng", () => {
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

  const SHA_P1 = "f".repeat(64);
  const SHA_P2 = "1".repeat(64);

  const executor = fx02.fixture_package.executor as string;
  const reviewer = "FIXTURE-REVIEWER-001";
  const decider = fx02.fixture_package.decider as string;
  const pod = fx02.fixture_package.pod as string;
  const SPEC_AUTHOR = "SPEC-AUTHOR-KC15B5";
  const SPEC_APPROVER = "SPEC-APPROVER-KC15B5";

  const P1: SourceRef = { artifactId: "SPEC-P", revision: 1, sha256: SHA_P1 };

  const OUT = (wi: string) => `OUT-${wi}`;

  async function seedRun(runId: string, firstItem: string, extraItems: string[]): Promise<void> {
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-KC15-B5" },
      decider,
      pod,
      fixturePackage: { id: `KC15-B5-${runId}`, reuses: "FX-02", executor },
    });
    await activateSopRun(db, cmd(`act-${runId}`), { runId, workItemId: firstItem });
    if (extraItems.length > 0) {
      await executeCommand(db, {
        commandId: cmd(`seed-${runId}`),
        payload: { extraItems },
        handler: async (ctx) => {
          for (const itemId of extraItems) {
            await ctx.emit({
              streamName: `dopaiosWorkItem-${itemId}`,
              type: "WorkItemCreated",
              data: { workItemId: itemId, runId, state: "PROPOSED" },
              expectedVersion: -1,
            });
            await ctx.emit({
              streamName: `dopaiosWorkItem-${itemId}`,
              type: "WorkItemStateChanged",
              data: { workItemId: itemId, state: "ACCEPTED" },
            });
          }
          return { seeded: extraItems.length };
        },
      });
    }
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

  async function advanceAndApprove(runId: string, wi: string, step: string): Promise<void> {
    await advanceToDecision(db, cmd(`adv-${wi}`), {
      runId,
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
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc15-b5-");
    db = createDb(tempDb.connectionString);
    for (const [id, actor] of [
      ["a-decider", { actorId: decider, kind: "human", active: true, capabilities: ["run-decider"] }],
      ["a-pod", { actorId: pod, kind: "human", active: true, capabilities: ["pod"] }],
      ["a-author", { actorId: SPEC_AUTHOR, kind: "human", active: true, capabilities: ["product-governance"] }],
      ["a-approver", { actorId: SPEC_APPROVER, kind: "human", active: true, capabilities: ["governance-approver"] }],
      ["a-ai", { actorId: "AI-KC15-B5", kind: "ai", active: true, capabilities: [] }],
    ] as Array<[string, Parameters<typeof registerActor>[2]]>) {
      await registerActor(db, cmd(id), actor);
    }
    await pinSeparationPolicy(db, cmd("policy"), {
      policyId: "SEP-SOURCE-SPEC-B5",
      artifactType: "source-spec",
      revision: 1,
      policy: {
        policy_id: "SEP-SOURCE-SPEC-B5",
        scope_level: "company",
        approver_capability: "governance-approver",
        effective_at: "2026-08-01T00:00:00Z",
        invalidation_rule: "revision-superseded",
      },
      pinnedBy: SPEC_APPROVER,
    });
    await registerDraftArtifact(db, cmd("spec-draft"), {
      artifactId: "SPEC-P",
      revision: 1,
      sha256: SHA_P1,
      createdBy: SPEC_AUTHOR,
      artifactType: "source-spec",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("spec-submit"), { artifactId: "SPEC-P", revision: 1 });
    await assembleDecisionPackage(db, cmd("spec-pkg"), {
      packageId: "PKG-SPEC-P-r1",
      revision: 1,
      target: { artifactId: "SPEC-P", revision: 1, sha256: SHA_P1 },
      refs: { evidence: "ev-SPEC-P-r1" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-approve"), {
      recordId: "REC-SPEC-P-r1",
      packageId: "PKG-SPEC-P-r1",
      packageRevision: 1,
      target: { artifactId: "SPEC-P", revision: 1, sha256: SHA_P1 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-SPEC-P-r1" },
      actor: SPEC_APPROVER,
    });
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-KC15-B5",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC15-B5",
      registeredBy: decider,
    });
    await registerApprovedArtifact(db, cmd("sop"), {
      artifactId: "SOP-KC15-B5",
      revision: 1,
      sha256: sopSha,
    });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-KC15-B5",
      revision: 1,
      sopPin: { artifactId: "SOP-KC15-B5", revision: 1, sha256: sopSha },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-KC15-B5",
      definitionContentSha256: sopSha,
      expectedSopSha256: sopSha,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("F1 (blocker): nguồn đổi nghĩa KHÔNG chạm run terminal — SFR-057 giữ sau hủy", async () => {
    await seedRun("RUN-B5-TERM", "WI-T1", []);
    await runChainToCheckPassed("WI-T1", [P1]);
    await advanceAndApprove("RUN-B5-TERM", "WI-T1", "T-T2");
    await cancelTestRun(db, cmd("cancel-term"), {
      runId: "RUN-B5-TERM",
      actor: decider,
      reason: "đóng run để kiểm cách ly terminal",
      dispositions: {},
    });
    // Run terminal: record AR-WI-T1-1 còn hiệu lực, bước T-T2 còn 'open'
    // trong projection — nguồn đổi nghĩa KHÔNG được ghi gì vào chúng.
    const result = await createArtifactRevision(db, cmd("spec-p-r2"), {
      artifactId: "SPEC-P",
      revision: 2,
      sha256: SHA_P2,
      createdBy: SPEC_AUTHOR,
      semanticChange: true,
      dependents: [],
    });
    expect(result["runLevelInvalidated"]).toBe(0);
    const rows = (await db.execute(sql`
      SELECT
        (SELECT invalidated_at IS NULL FROM dopaios_approval_records WHERE id = 'AR-WI-T1-1') AS record_untouched,
        (SELECT state FROM dopaios_run_steps WHERE run_id = 'RUN-B5-TERM' AND step_id = 'T-T2') AS step
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ record_untouched: true, step: "open" });
  });

  it("F2: pin nguồn không có Approval Record hiệu lực bị chặn (hàng bootstrap không record)", async () => {
    await seedRun("RUN-B5-BOOT", "WI-BOOT", []);
    // SOP-KC15-B5 vào sổ qua hàng bootstrap KHÔNG record — không đủ chuẩn
    // làm pin nguồn.
    await expect(
      runFixtureExecution(db, "KC15-B5-BOOT-PIN", {
        workItemId: "WI-BOOT",
        executor,
        outputId: OUT("WI-BOOT"),
        outputRevision: 1,
        contentSha256: outSha,
        outputType: "code-change",
        qualityContractRef: qcRef,
        sourceRefs: [{ artifactId: "SOP-KC15-B5", revision: 1, sha256: sopSha }],
      }),
    ).rejects.toMatchObject({ code: "ERR-APPROVAL" });
  });

  it("F10: sourceRefs dị dạng bị chặn fail-closed tại cửa, không vào event", async () => {
    for (const [label, bad] of [
      ["scalar", "not-an-array"],
      ["object", { artifactId: "SPEC-P" }],
      ["bad-element", [{ artifactId: "SPEC-P", revision: "một", sha256: SHA_P1 }]],
    ] as Array<[string, unknown]>) {
      await expect(
        runFixtureExecution(db, `KC15-B5-BAD-${label}`, {
          workItemId: "WI-BOOT",
          executor,
          outputId: OUT("WI-BOOT"),
          outputRevision: 1,
          contentSha256: outSha,
          outputType: "code-change",
          qualityContractRef: qcRef,
          sourceRefs: bad as SourceRef[],
        }),
      ).rejects.toMatchObject({ code: "ERR-002" });
    }
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_output_versions WHERE id = ${OUT("WI-BOOT")}`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });

  it("F7/F9: quyền khai cạnh và cạnh-deadlock bị chặn tại cửa", async () => {
    await seedRun("RUN-B5-EDGE", "WI-E1", ["WI-E2", "WI-E3"]);
    // Pod không phải decider của run và không giữ orchestrator → chặn.
    await expect(
      declareWorkItemDependency(db, "KC15-B5-EDGE-POD", {
        workItemId: "WI-E2",
        dependsOnWorkItemId: "WI-E1",
        declaredBy: pod,
      }),
    ).rejects.toMatchObject({ code: "ERR-AUTH" });
    await expect(
      declareWorkItemDependency(db, "KC15-B5-EDGE-AI", {
        workItemId: "WI-E2",
        dependsOnWorkItemId: "WI-E1",
        declaredBy: "AI-KC15-B5",
      }),
    ).rejects.toMatchObject({ code: "ERR-AUTH" });
    // Thượng nguồn COMPLETED không có dòng đầu ra → cạnh không bao giờ thỏa
    // → chặn tại cửa khai.
    await executeCommand(db, {
      commandId: cmd("force-complete-e3"),
      payload: {},
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosWorkItem-WI-E3",
          type: "WorkItemStateChanged",
          data: { workItemId: "WI-E3", state: "COMPLETED" },
        });
        return { ok: true };
      },
    });
    await expect(
      declareWorkItemDependency(db, "KC15-B5-EDGE-BARREN", {
        workItemId: "WI-E2",
        dependsOnWorkItemId: "WI-E3",
        declaredBy: decider,
      }),
    ).rejects.toMatchObject({
      code: "ERR-STATE",
      message: expect.stringContaining("no output line"),
    });
  });

  it("F4/F5/F6: 'chặn một phần' giữ ở MỌI cửa — trình điểm, quyết định, bản sửa, exhibit", async () => {
    await seedRun("RUN-B5-GATE", "WI-G1", ["WI-G2"]);
    await declareWorkItemDependency(db, cmd("edge-g"), {
      workItemId: "WI-G2",
      dependsOnWorkItemId: "WI-G1",
      declaredBy: decider,
    });
    // G1 duyệt xong → G2 qua ready-check, chạy trọn chuỗi tới CHECK_PASSED.
    await runChainToCheckPassed("WI-G1");
    await advanceAndApprove("RUN-B5-GATE", "WI-G1", "T-G2");
    await runChainToCheckPassed("WI-G2");
    // G1 nộp bản sửa (thay bản APPROVED) → approval G1 vô hiệu (SFR-031)
    // trong lúc G2 in-flight tại CHECK_PASSED.
    await submitFixtureRevision(db, cmd("g1-rev2"), {
      outputId: OUT("WI-G1"),
      newRevision: 2,
      contentSha256: outRev2Sha,
      outputType: "code-change",
      qualityContractRef: qcRef,
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
    });
    // (F4a) G2 in-flight KHÔNG trình điểm được nữa.
    await expect(
      advanceToDecision(db, "KC15-B5-ADV-G2", {
        runId: "RUN-B5-GATE",
        outputId: OUT("WI-G2"),
        outputRevision: 1,
        packageId: "PKG-WI-G2",
        packageRevision: 1,
        refs: { outputId: OUT("WI-G2"), revision: 1, sha256: outSha },
        requestId: "REQ-WI-G2",
      }),
    ).rejects.toMatchObject({
      code: "ERR-DEP-UNSATISFIED",
      message: expect.stringContaining("WI-G1:output-not-effectively-approved"),
    });
    // (F5) Bản sửa của dòng thuộc item hạ nguồn đang bị chặn cũng không vào
    // trục — VÀ rejection có vệt audit (F11, submit qua executeAuditedCommand).
    await expect(
      submitFixtureRevision(db, "KC15-B5-G2-REV", {
        outputId: OUT("WI-G2"),
        newRevision: 2,
        contentSha256: outRev2Sha,
        outputType: "code-change",
        qualityContractRef: qcRef,
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
    ).rejects.toMatchObject({ code: "SFR-045" });
    const audits = (await db.execute(
      sql`SELECT count(*)::int AS n FROM message_store.messages
          WHERE type = 'CommandRejected' AND data->>'commandId' IN ('KC15-B5-ADV-G2', 'KC15-B5-G2-REV')`,
    )) as unknown as Array<{ n: number }>;
    expect(audits[0].n).toBe(2);
  });

  it("F4b: trình điểm re-check pin nguồn — nguồn superseded sau khi nộp thì không trình được", async () => {
    await seedRun("RUN-B5-SRC", "WI-S1", []);
    // WI-S1 nộp pin SPEC-P@2 (đã ở draft từ ca F1? — không: revision 2 đã
    // tạo ở ca F1 dạng draft; duyệt nó trước, rồi pin @2, rồi tạo @3 đổi
    // nghĩa và duyệt @3 → @2 superseded → advance bị chặn).
    await submitArtifactForReview(db, cmd("spec-p2-submit"), { artifactId: "SPEC-P", revision: 2 });
    await assembleDecisionPackage(db, cmd("spec-p2-pkg"), {
      packageId: "PKG-SPEC-P-r2",
      revision: 1,
      target: { artifactId: "SPEC-P", revision: 2, sha256: SHA_P2 },
      refs: { evidence: "ev-SPEC-P-r2" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-p2-approve"), {
      recordId: "REC-SPEC-P-r2",
      packageId: "PKG-SPEC-P-r2",
      packageRevision: 1,
      target: { artifactId: "SPEC-P", revision: 2, sha256: SHA_P2 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-SPEC-P-r2" },
      actor: SPEC_APPROVER,
    });
    await runChainToCheckPassed("WI-S1", [{ artifactId: "SPEC-P", revision: 2, sha256: SHA_P2 }]);
    // Nguồn tiến revision 3 đổi nghĩa và ĐƯỢC DUYỆT → @2 superseded.
    const SHA_P3 = "2".repeat(64);
    await createArtifactRevision(db, cmd("spec-p-r3"), {
      artifactId: "SPEC-P",
      revision: 3,
      sha256: SHA_P3,
      createdBy: SPEC_AUTHOR,
      semanticChange: true,
      dependents: [],
    });
    await submitArtifactForReview(db, cmd("spec-p3-submit"), { artifactId: "SPEC-P", revision: 3 });
    await assembleDecisionPackage(db, cmd("spec-p3-pkg"), {
      packageId: "PKG-SPEC-P-r3",
      revision: 1,
      target: { artifactId: "SPEC-P", revision: 3, sha256: SHA_P3 },
      refs: { evidence: "ev-SPEC-P-r3" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-p3-approve"), {
      recordId: "REC-SPEC-P-r3",
      packageId: "PKG-SPEC-P-r3",
      packageRevision: 1,
      target: { artifactId: "SPEC-P", revision: 3, sha256: SHA_P3 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-SPEC-P-r3" },
      actor: SPEC_APPROVER,
    });
    await expect(
      advanceToDecision(db, "KC15-B5-ADV-S1", {
        runId: "RUN-B5-SRC",
        outputId: OUT("WI-S1"),
        outputRevision: 1,
        packageId: "PKG-WI-S1",
        packageRevision: 1,
        refs: { outputId: OUT("WI-S1"), revision: 1, sha256: outSha },
        requestId: "REQ-WI-S1",
      }),
    ).rejects.toMatchObject({
      code: "ERR-SOURCE",
      message: expect.stringContaining("superseded"),
    });
  });

  it("F13: nguồn đổi nghĩa chuyển bản AWAITING_DECISION sang REWORK_REQUIRED — đối xứng SFR-031", async () => {
    const SHA_Q1 = "3".repeat(64);
    const SHA_Q2 = "4".repeat(64);
    await registerDraftArtifact(db, cmd("spec-q-draft"), {
      artifactId: "SPEC-Q",
      revision: 1,
      sha256: SHA_Q1,
      createdBy: SPEC_AUTHOR,
      artifactType: "source-spec",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("spec-q-submit"), { artifactId: "SPEC-Q", revision: 1 });
    await assembleDecisionPackage(db, cmd("spec-q-pkg"), {
      packageId: "PKG-SPEC-Q-r1",
      revision: 1,
      target: { artifactId: "SPEC-Q", revision: 1, sha256: SHA_Q1 },
      refs: { evidence: "ev-SPEC-Q-r1" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-q-approve"), {
      recordId: "REC-SPEC-Q-r1",
      packageId: "PKG-SPEC-Q-r1",
      packageRevision: 1,
      target: { artifactId: "SPEC-Q", revision: 1, sha256: SHA_Q1 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-SPEC-Q-r1" },
      actor: SPEC_APPROVER,
    });
    await seedRun("RUN-B5-AD", "WI-Q1", []);
    await runChainToCheckPassed("WI-Q1", [{ artifactId: "SPEC-Q", revision: 1, sha256: SHA_Q1 }]);
    await advanceToDecision(db, cmd("adv-q1"), {
      runId: "RUN-B5-AD",
      outputId: OUT("WI-Q1"),
      outputRevision: 1,
      packageId: "PKG-WI-Q1",
      packageRevision: 1,
      refs: { outputId: OUT("WI-Q1"), revision: 1, sha256: outSha },
      requestId: "REQ-WI-Q1",
    });
    await createArtifactRevision(db, cmd("spec-q-r2"), {
      artifactId: "SPEC-Q",
      revision: 2,
      sha256: SHA_Q2,
      createdBy: SPEC_AUTHOR,
      semanticChange: true,
      dependents: [],
    });
    const rows = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_output_versions WHERE id = ${OUT("WI-Q1")} AND revision = 1) AS version,
        (SELECT state FROM dopaios_decision_packages WHERE id = 'PKG-WI-Q1' AND revision = 1) AS pkg,
        (SELECT state FROM dopaios_action_requests WHERE id = 'REQ-WI-Q1') AS request
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      version: "REWORK_REQUIRED",
      pkg: "INVALIDATED-TARGET-CHANGED",
      request: "SUPERSEDED-TARGET-CHANGED",
    });
  });

  it("F12a (tương tranh): khai chéo hai cạnh tạo vòng — đúng một cạnh sống, một ERR-CYCLE, không bao giờ hai", async () => {
    await seedRun("RUN-B5-RACE1", "WI-R1", ["WI-R2"]);
    const results = await Promise.allSettled([
      declareWorkItemDependency(db, "KC15-B5-RACE1-A", {
        workItemId: "WI-R1",
        dependsOnWorkItemId: "WI-R2",
        declaredBy: decider,
      }),
      declareWorkItemDependency(db, "KC15-B5-RACE1-B", {
        workItemId: "WI-R2",
        dependsOnWorkItemId: "WI-R1",
        declaredBy: decider,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].reason).toBeInstanceOf(CommandRejectedError);
    expect((rejected[0].reason as CommandRejectedError).code).toBe("ERR-CYCLE");
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_work_item_dependencies WHERE run_id = 'RUN-B5-RACE1'`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);
  });

  it("F12b/F19 (tương tranh): đua khai TRÙNG cạnh khác command_id — một thắng, một ERR-DUP-EDGE sạch", async () => {
    await seedRun("RUN-B5-RACE2", "WI-D1", ["WI-D2"]);
    const results = await Promise.allSettled([
      declareWorkItemDependency(db, "KC15-B5-RACE2-A", {
        workItemId: "WI-D2",
        dependsOnWorkItemId: "WI-D1",
        declaredBy: decider,
      }),
      declareWorkItemDependency(db, "KC15-B5-RACE2-B", {
        workItemId: "WI-D2",
        dependsOnWorkItemId: "WI-D1",
        declaredBy: decider,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Không lỗi thô của event store — rejection sạch có mã, có audit.
    expect(rejected[0].reason).toBeInstanceOf(CommandRejectedError);
    expect((rejected[0].reason as CommandRejectedError).code).toBe("ERR-DUP-EDGE");
    const rows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_work_item_dependencies WHERE run_id = 'RUN-B5-RACE2'`,
    )) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(1);
  });

  it("F12c (tương tranh): ready-check hạ nguồn ∥ nguồn đổi nghĩa — không trạng thái cấm sau đua", async () => {
    const SHA_W1 = "5".repeat(64);
    await registerDraftArtifact(db, cmd("spec-w-draft"), {
      artifactId: "SPEC-W",
      revision: 1,
      sha256: SHA_W1,
      createdBy: SPEC_AUTHOR,
      artifactType: "source-spec",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("spec-w-submit"), { artifactId: "SPEC-W", revision: 1 });
    await assembleDecisionPackage(db, cmd("spec-w-pkg"), {
      packageId: "PKG-SPEC-W-r1",
      revision: 1,
      target: { artifactId: "SPEC-W", revision: 1, sha256: SHA_W1 },
      refs: { evidence: "ev-SPEC-W-r1" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-w-approve"), {
      recordId: "REC-SPEC-W-r1",
      packageId: "PKG-SPEC-W-r1",
      packageRevision: 1,
      target: { artifactId: "SPEC-W", revision: 1, sha256: SHA_W1 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-SPEC-W-r1" },
      actor: SPEC_APPROVER,
    });
    await seedRun("RUN-B5-RACE3", "WI-W1", ["WI-W2"]);
    await declareWorkItemDependency(db, cmd("edge-w"), {
      workItemId: "WI-W2",
      dependsOnWorkItemId: "WI-W1",
      declaredBy: decider,
    });
    await runChainToCheckPassed("WI-W1", [{ artifactId: "SPEC-W", revision: 1, sha256: SHA_W1 }]);
    await advanceAndApprove("RUN-B5-RACE3", "WI-W1", "T-W2");

    const SHA_W2 = "6".repeat(64);
    const results = await Promise.allSettled([
      runFixtureExecution(db, "KC15-B5-RACE3-EXEC", {
        workItemId: "WI-W2",
        executor,
        outputId: OUT("WI-W2"),
        outputRevision: 1,
        contentSha256: outSha,
        outputType: "code-change",
        qualityContractRef: qcRef,
      }),
      createArtifactRevision(db, "KC15-B5-RACE3-SRC", {
        artifactId: "SPEC-W",
        revision: 2,
        sha256: SHA_W2,
        createdBy: SPEC_AUTHOR,
        semanticChange: true,
        dependents: [],
      }),
    ]);
    // createArtifactRevision luôn phải thành công (retry SSI); ready-check
    // hoặc bị chặn ERR-DEP-UNSATISFIED (thấy vô hiệu trước) hoặc thành công
    // (commit trước) — cả hai là thứ tự serial hợp lệ; không lỗi thô nào.
    expect(results[1].status).toBe("fulfilled");
    if (results[0].status === "rejected") {
      const reason = (results[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(CommandRejectedError);
      expect((reason as CommandRejectedError).code).toBe("ERR-DEP-UNSATISFIED");
      const rows = (await db.execute(
        sql`SELECT state FROM dopaios_work_items WHERE id = 'WI-W2'`,
      )) as unknown as Array<{ state: string }>;
      expect(rows[0].state).toBe("ACCEPTED");
    } else {
      const rows = (await db.execute(sql`
        SELECT
          (SELECT state FROM dopaios_work_items WHERE id = 'WI-W2') AS item,
          (SELECT invalidated_at IS NOT NULL FROM dopaios_approval_records WHERE id = 'AR-WI-W1-1') AS invalidated
      `)) as unknown as Array<Record<string, unknown>>;
      // Thứ tự serial exec-trước-đổi-nguồn: item đã SUBMITTED, approval
      // thượng nguồn vô hiệu SAU đó — nhất quán; advance của W2 sẽ bị chặn
      // bởi re-check F4a.
      expect(rows[0]).toEqual({ item: "SUBMITTED", invalidated: true });
    }
  });
});
