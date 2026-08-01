import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand, type CommandContext } from "../dopaios/event-store.ts";
import {
  registerActor,
  registerApprovedArtifact,
  createProjectShell,
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
import { startAiSession, recordSessionArtifact, completeSession } from "../dopaios/sessions.ts";
import {
  declareWorkItemDependency,
  traceCriticalOutput,
  outputsPinningSourceRevision,
  listCurrentRunOutputs,
  artifactProvenance,
} from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-04 B2 — "chức năng mẫu" (QD-3): một chức năng fixture đi trọn chuỗi
// spec → code → test → artifact → kết quả kiểm trên FakeEngine, rồi truy vấn:
//  - XUÔI từ ĐÚNG phiên bản spec (FR-21 "chức năng X xong chưa?"):
//    outputsPinningSourceRevision;
//  - NGƯỢC câu bất biến kế hoạch KC-04: traceCriticalOutput giải đủ sáu mối
//    work-item → kế hoạch/spec → artifact → nguồn → quyết định kiểm → Phiên
//    chạy AI cho MỌI đầu ra trọng yếu của run (QD-6);
//  - tiêu chí 2: artifactProvenance chỉ ra Project, work-item, Phiên chạy AI,
//    phiên bản, hash và nơi lưu.
// Truy vết là cách ĐỌC trên liên kết pin sẵn có qua graph-repo (QD-1) —
// không bảng trace_links mới.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-04 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_BRIEF = "1".repeat(64); // nguồn ngoài sổ — chỉ có hash nội dung
const SHA_TPL = "2".repeat(64);
const SHA_SPEC1 = "3".repeat(64);
const SHA_CODE1 = "4".repeat(64);
const SHA_TEST1 = "5".repeat(64);
const SELF_SHA = "7".repeat(64);
const REVIEW_SHA = "8".repeat(64);

const PROJECT = "PROJ-KC04";
const RUN = "RUN-KC04";
const WI_CODE = "WI-KC04-CODE";
const WI_TEST = "WI-KC04-TEST";
const OUT_CODE = "OUT-KC04-CODE";
const OUT_TEST = "OUT-KC04-TEST";

let seq = 0;
const cmd = (label: string) => `KC04-B2-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-04 B2 — truy vết chức năng mẫu", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcCode!: QualityContractRef;
  let qcTest!: QualityContractRef;

  // Truy vấn graph-repo trong transaction lệnh — cùng snapshot với guard
  // (SFR-048/049), đúng nếp KC-15.
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

  // Artifact được output pin phải có Approval Record hiệu lực
  // (validateSourceRefs/findEffectiveApproval) — đi đường KC-03 thật:
  // draft → in-review → Gói quyết định → approve (nếp seedApprovedSpec KC-15).
  async function seedApprovedViaLedger(input: {
    artifactId: string;
    sha256: string;
    artifactType: string;
    createdBy: string;
    sourceRefs?: Array<Record<string, unknown>>;
    storageRef?: string;
  }): Promise<void> {
    await registerDraftArtifact(db, cmd(`draft-${input.artifactId}`), {
      artifactId: input.artifactId,
      revision: 1,
      sha256: input.sha256,
      createdBy: input.createdBy,
      artifactType: input.artifactType,
      hasRegionSchema: false,
      sourceRefs: input.sourceRefs,
      storageRef: input.storageRef,
    });
    await submitArtifactForReview(db, cmd(`submit-${input.artifactId}`), {
      artifactId: input.artifactId,
      revision: 1,
    });
    await assembleDecisionPackage(db, cmd(`pkg-${input.artifactId}`), {
      packageId: `PKG-${input.artifactId}-r1`,
      revision: 1,
      target: { artifactId: input.artifactId, revision: 1, sha256: input.sha256 },
      refs: { evidence: `ev-${input.artifactId}-r1` },
      fields: {},
    });
    await recordApprovalDecision(db, cmd(`approve-${input.artifactId}`), {
      recordId: `REC-${input.artifactId}-r1`,
      packageId: `PKG-${input.artifactId}-r1`,
      packageRevision: 1,
      target: { artifactId: input.artifactId, revision: 1, sha256: input.sha256 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: `ev-${input.artifactId}-r1` },
      actor: "SPEC-APPROVER-KC04",
    });
  }

  // Dựng run test + work-item gắn Project (nếp seed KC-15, thêm projectId —
  // WorkItemCreated đã nhận projectId từ 0510/KC-13).
  async function seedRunWithItems(runId: string, itemIds: string[]): Promise<void> {
    await executeCommand(db, {
      commandId: cmd(`seed-${runId}`),
      payload: { runId, itemIds },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosSopRun-${runId}`,
          type: "TestRunRequested",
          data: {
            runId,
            definitionRef: { definitionId: `DEF-${runId}` },
            decider: "STAFF-DECIDER",
            pod: "STAFF-POD",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosSopRun-${runId}`,
          type: "SopRunStateChanged",
          data: { runId, state: "RUNNING" },
        });
        for (const itemId of itemIds) {
          await ctx.emit({
            streamName: `dopaiosWorkItem-${itemId}`,
            type: "WorkItemCreated",
            data: { workItemId: itemId, runId, state: "ACCEPTED", projectId: PROJECT },
            expectedVersion: -1,
          });
        }
        return { seeded: itemIds.length };
      },
    });
  }

  // Một chặng thực hiện đủ chuỗi kiểm: Phiên chạy AI (FakeEngine) ghi nhận
  // nội dung → nộp đầu ra pin nguồn → tự kiểm → kiểm độc lập → trình điểm →
  // quyết định approve (mở bước) — "kết quả kiểm" của chuỗi truy vết.
  async function executeAndApprove(input: {
    workItemId: string;
    sessionId: string;
    agent: string;
    outputId: string;
    contentSha256: string;
    contentRef: string;
    outputType: string;
    qcRef: QualityContractRef;
    sourceRefs: Array<{ artifactId: string; revision: number; sha256: string }>;
    recordId: string;
    openedStep: string;
  }): Promise<void> {
    await startAiSession(db, cmd(`ses-${input.sessionId}`), {
      sessionId: input.sessionId,
      workItemId: input.workItemId,
      agentId: input.agent,
      engine: "fake-engine",
    });
    await recordSessionArtifact(db, cmd(`sa-${input.sessionId}`), {
      sessionId: input.sessionId,
      seq: 1,
      kind: "output",
      ref: input.contentRef,
      sha256: input.contentSha256,
      confirmed: true,
    });
    await completeSession(db, cmd(`done-${input.sessionId}`), {
      sessionId: input.sessionId,
      outcome: "succeeded",
    });
    await runFixtureExecution(db, cmd(`exec-${input.outputId}`), {
      workItemId: input.workItemId,
      executor: input.agent,
      outputId: input.outputId,
      outputRevision: 1,
      contentSha256: input.contentSha256,
      outputType: input.outputType,
      qualityContractRef: input.qcRef,
      sourceRefs: input.sourceRefs,
    });
    await validateSelfCheck(db, cmd(`vsc-${input.outputId}`), {
      outputId: input.outputId,
      outputRevision: 1,
      evidence: {
        ref: `SC-${input.outputId}`,
        sha256: SELF_SHA,
        targetSha256: input.contentSha256,
        by: input.agent,
      },
      expectedSha256: SELF_SHA,
    });
    await reviewFixtureExecution(db, cmd(`rev-${input.outputId}`), {
      workItemId: input.workItemId,
      outputId: input.outputId,
      outputRevision: 1,
      executor: input.agent,
      reviewer: "AI-REVIEWER",
      reviewEvidence: {
        ref: `RE-${input.outputId}`,
        sha256: REVIEW_SHA,
        targetSha256: input.contentSha256,
        conclusion: "ready",
      },
      expectedReviewSha256: REVIEW_SHA,
    });
    await advanceToDecision(db, cmd(`adv-${input.outputId}`), {
      runId: RUN,
      outputId: input.outputId,
      outputRevision: 1,
      packageId: `PKG-${input.outputId}`,
      packageRevision: 1,
      refs: { outputId: input.outputId, revision: 1, sha256: input.contentSha256 },
      requestId: `REQ-${input.outputId}`,
    });
    await recordApproval(db, cmd(`appr-${input.outputId}`), {
      requestId: `REQ-${input.outputId}`,
      recordId: input.recordId,
      packageId: `PKG-${input.outputId}`,
      packageRevision: 1,
      pinnedRefs: { outputId: input.outputId, revision: 1, sha256: input.contentSha256 },
      actor: "STAFF-DECIDER",
      outputId: input.outputId,
      outputRevision: 1,
      outcome: "approve",
      openedStep: input.openedStep,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc04-b2-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, kind, capabilities] of [
      ["STAFF-DECIDER", "human", ["run-decider"]],
      ["STAFF-POD", "human", ["pod"]],
      ["STAFF-ORCH", "human", ["orchestrator", "project-creator"]],
      ["AI-BUILD", "ai", ["producer"]],
      ["AI-TEST", "ai", ["producer"]],
      ["AI-REVIEWER", "ai", ["reviewer"]],
      ["SPEC-AUTHOR-KC04", "human", ["product-governance"]],
      ["SPEC-APPROVER-KC04", "human", ["governance-approver"]],
    ] as const) {
      await registerActor(db, cmd(`a-${actorId}`), {
        actorId,
        kind,
        active: true,
        capabilities: [...capabilities],
      });
    }
    await registerApprovedArtifact(db, cmd("tpl"), {
      artifactId: "TPL-KC04",
      revision: 1,
      sha256: SHA_TPL,
      artifactType: "project-template",
    });
    await createProjectShell(db, cmd("proj"), {
      projectId: PROJECT,
      actor: "STAFF-ORCH",
      templateRef: { template_id: "TPL-KC04", revision: 1, sha256: SHA_TPL },
      expectedTemplateSha256: SHA_TPL,
      orchestrator: "STAFF-ORCH",
    });
    qcCode = await seedApprovedQualityContract(db, {
      id: "QC-KC04-CODE",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC04-B2-QC1",
      registeredBy: "STAFF-ORCH",
    });
    qcTest = await seedApprovedQualityContract(db, {
      id: "QC-KC04-TEST",
      outputType: "test-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC04-B2-QC2",
      registeredBy: "STAFF-ORCH",
    });
    // Separation policy fail-closed theo LOẠI artifact (SFR-014) cho hai loại
    // được phê duyệt qua sổ trong fixture này.
    for (const artifactType of ["feature-spec", "code"]) {
      await pinSeparationPolicy(db, cmd(`policy-${artifactType}`), {
        policyId: `SEP-${artifactType}`,
        artifactType,
        revision: 1,
        policy: {
          policy_id: `SEP-${artifactType}`,
          scope_level: "company",
          approver_capability: "governance-approver",
          effective_at: "2026-08-01T00:00:00Z",
          invalidation_rule: "revision-superseded",
        },
        pinnedBy: "SPEC-APPROVER-KC04",
      });
    }
    await seedRunWithItems(RUN, [WI_CODE, WI_TEST]);
    // Spec của chức năng mẫu: nguồn là tài liệu gốc ngoài sổ (pin hash);
    // được phê duyệt qua đường KC-03 thật để output pin được.
    await seedApprovedViaLedger({
      artifactId: "ART-KC04-SPEC",
      sha256: SHA_SPEC1,
      artifactType: "feature-spec",
      createdBy: "SPEC-AUTHOR-KC04",
      sourceRefs: [{ sha256: SHA_BRIEF }],
      storageRef: "fixtures/content/kc04-spec-r1.md",
    });

    // Chặng CODE của chức năng mẫu.
    await executeAndApprove({
      workItemId: WI_CODE,
      sessionId: "SES-KC04-CODE",
      agent: "AI-BUILD",
      outputId: OUT_CODE,
      contentSha256: SHA_CODE1,
      contentRef: "fixtures/content/kc04-code-r1.ts",
      outputType: "code-change",
      qcRef: qcCode,
      sourceRefs: [{ artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC1 }],
      recordId: "AR-KC04-CODE",
      openedStep: "T3",
    });
    // Code đã duyệt vào sổ cái — nguồn để chặng TEST pin (spec–code–test);
    // createdBy là chính AI sản xuất, người duyệt độc lập theo policy.
    await seedApprovedViaLedger({
      artifactId: "ART-KC04-CODE",
      sha256: SHA_CODE1,
      artifactType: "code",
      createdBy: "AI-BUILD",
      sourceRefs: [{ artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC1 }],
      storageRef: "fixtures/content/kc04-code-r1.ts",
    });
    await declareWorkItemDependency(db, cmd("dep"), {
      workItemId: WI_TEST,
      dependsOnWorkItemId: WI_CODE,
      declaredBy: "STAFF-ORCH",
      basis: { needsOutputOf: WI_CODE },
    });
    // Chặng TEST pin đúng phiên bản spec VÀ code.
    await executeAndApprove({
      workItemId: WI_TEST,
      sessionId: "SES-KC04-TEST",
      agent: "AI-TEST",
      outputId: OUT_TEST,
      contentSha256: SHA_TEST1,
      contentRef: "fixtures/content/kc04-test-r1.ts",
      outputType: "test-change",
      qcRef: qcTest,
      sourceRefs: [
        { artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC1 },
        { artifactId: "ART-KC04-CODE", revision: 1, sha256: SHA_CODE1 },
      ],
      recordId: "AR-KC04-TEST",
      openedStep: "T4",
    });
    await registerApprovedArtifact(db, cmd("art-test"), {
      artifactId: "ART-KC04-TEST",
      revision: 1,
      sha256: SHA_TEST1,
      artifactType: "test",
      sourceRefs: [
        { artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC1 },
        { artifactId: "ART-KC04-CODE", revision: 1, sha256: SHA_CODE1 },
      ],
      storageRef: "fixtures/content/kc04-test-r1.ts",
    });
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("truy vấn XUÔI từ ĐÚNG phiên bản spec: rev 1 ra trọn chuỗi code+test, rev 2 rỗng (FR-21)", async () => {
    const fromRev1 = await inCommand(cmd("q-fwd1"), (ctx) =>
      outputsPinningSourceRevision(ctx, "ART-KC04-SPEC", 1),
    );
    expect(fromRev1).toEqual([
      { outputId: OUT_CODE, revision: 1, state: "APPROVED", workItemId: WI_CODE },
      { outputId: OUT_TEST, revision: 1, state: "APPROVED", workItemId: WI_TEST },
    ]);
    const fromRev2 = await inCommand(cmd("q-fwd2"), (ctx) =>
      outputsPinningSourceRevision(ctx, "ART-KC04-SPEC", 2),
    );
    expect(fromRev2).toEqual([]);
  });

  it("câu bất biến: MỌI đầu ra trọng yếu của run giải đủ sáu mối (missing rỗng)", async () => {
    const critical = await inCommand(cmd("q-crit"), (ctx) => listCurrentRunOutputs(ctx, RUN));
    expect(critical).toEqual([
      { outputId: OUT_CODE, revision: 1 },
      { outputId: OUT_TEST, revision: 1 },
    ]);
    for (const { outputId, revision } of critical) {
      const trace = await inCommand(cmd(`q-tr-${outputId}`), (ctx) =>
        traceCriticalOutput(ctx, outputId, revision),
      );
      expect(trace.missing).toEqual([]);
    }
  });

  it("trace đầu ra TEST: đúng spec revision, artifact + nơi lưu, quyết định kiểm hiệu lực, Phiên chạy AI", async () => {
    const trace = await inCommand(cmd("q-test"), (ctx) => traceCriticalOutput(ctx, OUT_TEST, 1));
    expect(trace.output).toMatchObject({ state: "APPROVED", contentSha256: SHA_TEST1 });
    expect(trace.workItem).toEqual({ id: WI_TEST, runId: RUN, projectId: PROJECT, state: "COMPLETED" });
    // Mối kế hoạch/spec + nguồn: cả hai pin giải được trong sổ, đúng revision.
    expect(trace.sources.map((s) => s.resolved)).toEqual([
      {
        artifactId: "ART-KC04-SPEC",
        revision: 1,
        sha256: SHA_SPEC1,
        artifactType: "feature-spec",
        artifactState: "approved",
      },
      {
        artifactId: "ART-KC04-CODE",
        revision: 1,
        sha256: SHA_CODE1,
        artifactType: "code",
        artifactState: "approved",
      },
    ]);
    expect(trace.registeredArtifacts).toEqual([
      expect.objectContaining({
        artifactId: "ART-KC04-TEST",
        revision: 1,
        storageRef: "fixtures/content/kc04-test-r1.ts",
      }),
    ]);
    expect(trace.effectiveApprovals).toEqual([{ recordId: "AR-KC04-TEST", outcome: "approve" }]);
    expect(trace.aiSessions).toEqual([
      { sessionId: "SES-KC04-TEST", agentId: "AI-TEST", engine: "fake-engine" },
    ]);
  });

  it("tiêu chí 2: artifact chỉ ra Project, work-item, Phiên chạy AI, phiên bản, hash và nơi lưu", async () => {
    const provenance = await inCommand(cmd("q-prov"), (ctx) =>
      artifactProvenance(ctx, "ART-KC04-CODE", 1),
    );
    expect(provenance.artifact).toEqual({
      artifactId: "ART-KC04-CODE",
      revision: 1,
      sha256: SHA_CODE1,
      artifactType: "code",
      artifactState: "approved",
      storageRef: "fixtures/content/kc04-code-r1.ts",
      sourceRefs: [{ artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC1 }],
      createdBy: "AI-BUILD",
    });
    expect(provenance.producers).toEqual([
      {
        sessionId: "SES-KC04-CODE",
        agentId: "AI-BUILD",
        engine: "fake-engine",
        workItemId: WI_CODE,
        runId: RUN,
        projectId: PROJECT,
      },
    ]);
  });
});
