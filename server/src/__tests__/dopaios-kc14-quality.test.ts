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
  pinProductBaseline,
} from "../dopaios/commands.ts";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
  type RecordApprovalPayload,
} from "../dopaios/approval.ts";
import { closeCondition, dispositionImpact } from "../dopaios/conditions.ts";
import {
  createArtifactRevision,
  beginImplementation,
  freezeArtifact,
  retireArtifact,
  registerQualityContract,
  qualityContractContentSha256,
} from "../dopaios/lifecycle.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";

// KC-14 B2 — hoàn tất bảng `artifact_state` FS-002 (create-revision /
// begin-implementation / freeze-artifact / retire-artifact) và Hợp đồng
// chất lượng theo QD-2:
//  - begin-implementation chứng minh guard TRỤC KÉP: approved + approval
//    hiệu lực đúng hash CHƯA đủ — impact_status phải ∈ {clear, reaffirmed};
//  - pin hợp đồng lúc nộp là ID@revision@hash; hợp đồng chưa duyệt, sai
//    hash, superseded hoặc đang impact-pending đều bị chặn tại ready-check;
//  - CHECK_PASSED chỉ khi MỌI kiểm bắt buộc theo hợp đồng ĐƯỢC PIN có bằng
//    chứng hợp lệ; revision hợp đồng mới không đổi âm thầm phiên bản đang
//    chạy (phiên bản giữ pin cũ, bản nộp mới phải pin bản hiệu lực).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "1".repeat(64);
const SHA2 = "2".repeat(64);
const SELF_SHA = "3".repeat(64);
const REVIEW_SHA = "4".repeat(64);
const BUILD_SHA = "5".repeat(64);
let seq = 0;
const cmd = (label: string) => `KC14-B2-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-14 B2 — trục artifact FS-002 + Hợp đồng chất lượng", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function decision(
    overrides: Partial<RecordApprovalPayload> &
      Pick<RecordApprovalPayload, "recordId" | "packageId" | "target" | "actor">,
  ): RecordApprovalPayload {
    return {
      packageRevision: 1,
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: `ev-${overrides.target.artifactId}` },
      ...overrides,
    };
  }

  // Đường KC-03 trọn vẹn: draft → in-review → gói → approve — tạo Approval
  // Record có target để begin-implementation tra hiệu lực.
  async function stageAndApprove(
    artifactId: string,
    opts?: {
      artifactType?: string;
      sha256?: string;
      outcome?: "approve" | "approve-with-conditions";
      conditions?: RecordApprovalPayload["conditions"];
      revision?: number;
      skipRegister?: boolean;
    },
  ): Promise<{ recordId: string }> {
    const revision = opts?.revision ?? 1;
    const sha = opts?.sha256 ?? SHA;
    if (!opts?.skipRegister) {
      await registerDraftArtifact(db, cmd(`reg-${artifactId}`), {
        artifactId,
        revision,
        sha256: sha,
        createdBy: "STAFF-AUTHOR",
        artifactType: opts?.artifactType ?? "governance-doc",
        hasRegionSchema: false,
      });
    }
    await submitArtifactForReview(db, cmd(`sub-${artifactId}`), { artifactId, revision });
    await assembleDecisionPackage(db, cmd(`pkg-${artifactId}`), {
      packageId: `PKG-${artifactId}-r${revision}`,
      revision: 1,
      target: { artifactId, revision, sha256: sha },
      refs: { evidence: `ev-${artifactId}` },
      fields: {},
    });
    const recordId = `REC-${artifactId}-r${revision}`;
    await recordApprovalDecision(
      db,
      cmd(`apr-${artifactId}`),
      decision({
        recordId,
        packageId: `PKG-${artifactId}-r${revision}`,
        target: { artifactId, revision, sha256: sha },
        actor: "STAFF-APPROVER",
        outcome: opts?.outcome ?? "approve",
        conditions: opts?.conditions,
      }),
    );
    return { recordId };
  }

  // Chuỗi run test tối thiểu cho các ca pin/nộp: một run mới với work-item T1.
  let runSeq = 0;
  async function newRunWithWorkItem(): Promise<{ runId: string; workItemId: string }> {
    runSeq += 1;
    const runId = `RUN-B2-${runSeq}`;
    const workItemId = `WI-B2-${runSeq}`;
    await requestTestRun(db, cmd(`run-${runId}`), {
      runId,
      definitionRef: { definitionId: "DEF-B2" },
      decider: "STAFF-DECIDER",
      pod: "POD-B2",
      fixturePackage: { id: "FX-02", sha256: SHA },
    });
    await activateSopRun(db, cmd(`act-${runId}`), { runId, workItemId });
    return { runId, workItemId };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b2-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("a1"), {
      actorId: "STAFF-AUTHOR",
      kind: "human",
      active: true,
      capabilities: ["product-governance"],
    });
    await registerActor(db, cmd("a2"), {
      actorId: "STAFF-APPROVER",
      kind: "human",
      active: true,
      capabilities: ["governance-approver"],
    });
    await registerActor(db, cmd("a3"), {
      actorId: "STAFF-DECIDER",
      kind: "human",
      active: true,
      capabilities: ["run-decider"],
    });
    await registerActor(db, cmd("a4"), {
      actorId: "AI-GOV",
      kind: "ai",
      active: true,
      capabilities: ["governance-approver"],
    });
    for (const [policyId, artifactType] of [
      ["SEP-DOC", "governance-doc"],
      ["SEP-QC", "quality-contract"],
    ] as const) {
      await pinSeparationPolicy(db, cmd(`pol-${policyId}`), {
        policyId,
        artifactType,
        revision: 1,
        policy: {
          policy_id: policyId,
          scope_level: "company",
          approver_capability: "governance-approver",
          effective_at: "2026-08-01T00:00:00Z",
          invalidation_rule: "revision-superseded",
        },
        pinnedBy: "STAFF-APPROVER",
      });
    }
    // Nền run test: SOP artifact approved → definition published.
    await registerApprovedArtifact(db, cmd("sop"), { artifactId: "SOP-B2", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-B2",
      revision: 1,
      sopPin: { artifactId: "SOP-B2", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-B2",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("create-revision: revision mới draft/clear kế thừa loại; khai đổi nghĩa mở impact record cho phụ thuộc (SFR-010)", async () => {
    await registerDraftArtifact(db, cmd("src"), {
      artifactId: "SRC-A",
      revision: 1,
      sha256: SHA,
      createdBy: "STAFF-AUTHOR",
      artifactType: "governance-doc",
      hasRegionSchema: false,
    });
    await stageAndApprove("DEP-A");

    // Sai số revision và artifact không tồn tại đều bị chặn.
    await expect(
      createArtifactRevision(db, cmd("bad-rev"), {
        artifactId: "SRC-A",
        revision: 3,
        sha256: SHA2,
        createdBy: "STAFF-AUTHOR",
        semanticChange: false,
        dependents: [],
      }),
    ).rejects.toMatchObject({ code: "ERR-REVISION" });
    await expect(
      createArtifactRevision(db, cmd("no-art"), {
        artifactId: "SRC-KHONG-TON-TAI",
        revision: 1,
        sha256: SHA2,
        createdBy: "STAFF-AUTHOR",
        semanticChange: false,
        dependents: [],
      }),
    ).rejects.toMatchObject({ code: "ERR-TARGET" });

    const result = await createArtifactRevision(db, cmd("rev2"), {
      artifactId: "SRC-A",
      revision: 2,
      sha256: SHA2,
      createdBy: "STAFF-AUTHOR",
      semanticChange: true,
      dependents: [{ artifactId: "DEP-A", revision: 1 }],
    });
    expect(result).toMatchObject({ state: "draft", impactedDependents: 1 });

    const rows = (await db.execute(sql`
      SELECT
        (SELECT artifact_state FROM dopaios_artifacts WHERE id = 'SRC-A' AND revision = 2) AS src_state,
        (SELECT impact_status FROM dopaios_artifacts WHERE id = 'SRC-A' AND revision = 2) AS src_impact,
        (SELECT artifact_type FROM dopaios_artifacts WHERE id = 'SRC-A' AND revision = 2) AS src_type,
        (SELECT impact_status FROM dopaios_artifacts WHERE id = 'DEP-A' AND revision = 1) AS dep_impact,
        (SELECT state FROM dopaios_impact_records WHERE id = 'IMP-SRC-Ar2-DEP-Ar1') AS impact_record
    `)) as unknown as Array<Record<string, string>>;
    expect(rows[0]).toEqual({
      src_state: "draft",
      src_impact: "clear",
      src_type: "governance-doc",
      dep_impact: "impact-pending",
      impact_record: "open",
    });
  });

  it("begin-implementation: guard TRỤC KÉP — approved + impact-pending bị chặn; reaffirmed mở lại (FS-002 d.108-115)", async () => {
    // DEP-A đang approved nhưng impact-pending (ca trên) — bị chặn SỬ DỤNG.
    await expect(
      beginImplementation(db, cmd("bi-blocked"), { artifactId: "DEP-A", revision: 1, actor: "STAFF-AUTHOR" }),
    ).rejects.toMatchObject({ code: "SFR-011" });

    await dispositionImpact(db, cmd("disp"), {
      impactId: "IMP-SRC-Ar2-DEP-Ar1",
      conclusion: "keep-value",
      actor: "STAFF-APPROVER",
      basis: "đổi nghĩa của SRC-A không chạm phần DEP-A dùng",
    });
    const ok = await beginImplementation(db, cmd("bi-ok"), {
      artifactId: "DEP-A",
      revision: 1,
      actor: "STAFF-AUTHOR",
    });
    expect(ok).toMatchObject({ state: "implementing" });

    // Artifact approved kiểu bootstrap KHÔNG có Approval Record → không có
    // hiệu lực để tiêu thụ — begin-implementation bị chặn.
    await registerApprovedArtifact(db, cmd("boot"), { artifactId: "ART-BOOT", revision: 1, sha256: SHA });
    await expect(
      beginImplementation(db, cmd("bi-boot"), { artifactId: "ART-BOOT", revision: 1, actor: "STAFF-AUTHOR" }),
    ).rejects.toMatchObject({ code: "ERR-APPROVAL" });
  });

  it("freeze-artifact: chặn khi condition thuộc phạm vi còn mở; đóng condition xong mới released-frozen", async () => {
    const { recordId } = await stageAndApprove("ART-AWC", {
      outcome: "approve-with-conditions",
      conditions: [
        {
          conditionId: "CON-AWC-1",
          scope: { area: "phần phụ" },
          risk: "thấp",
          owner: "STAFF-AUTHOR",
          deadline: "2027-01-01T00:00:00Z",
          closureCriteria: "bổ sung tài liệu vận hành",
          blocksNextStep: false,
        },
      ],
    });
    await beginImplementation(db, cmd("bi-awc"), { artifactId: "ART-AWC", revision: 1, actor: "STAFF-AUTHOR" });
    await expect(
      freezeArtifact(db, cmd("fz-open"), { artifactId: "ART-AWC", revision: 1, actor: "STAFF-AUTHOR" }),
    ).rejects.toMatchObject({ code: "ERR-CONDITION-OPEN" });

    await closeCondition(db, cmd("close"), {
      conditionId: "CON-AWC-1",
      actor: "STAFF-APPROVER",
      closureEvidence: "tài liệu vận hành đã bổ sung, đường dẫn evidence",
    });
    const frozen = await freezeArtifact(db, cmd("fz-ok"), {
      artifactId: "ART-AWC",
      revision: 1,
      actor: "STAFF-AUTHOR",
    });
    expect(frozen).toMatchObject({ state: "released-frozen" });
    expect(recordId).toBe("REC-ART-AWC-r1");
  });

  it("retire-artifact: chặn khi còn chỗ pin; retire xong ID không tái sử dụng (SFR-004); AI không có quyền retire (SFR-023)", async () => {
    await stageAndApprove("ART-PINNED");
    await pinProductBaseline(db, cmd("bl"), {
      baselineId: "BL-B2",
      revision: 1,
      pinnedBy: "STAFF-APPROVER",
      items: [{ artifactId: "ART-PINNED", revision: 1, sha256: SHA }],
    });
    await expect(
      retireArtifact(db, cmd("ret-pinned"), { artifactId: "ART-PINNED", actor: "STAFF-APPROVER" }),
    ).rejects.toMatchObject({ code: "ERR-PINNED" });

    await stageAndApprove("ART-RET");
    await expect(
      retireArtifact(db, cmd("ret-ai"), { artifactId: "ART-RET", actor: "AI-GOV" }),
    ).rejects.toMatchObject({ code: "SFR-023" });
    const retired = await retireArtifact(db, cmd("ret-ok"), {
      artifactId: "ART-RET",
      actor: "STAFF-APPROVER",
    });
    expect(retired).toMatchObject({ retiredRevisions: 1 });

    await expect(
      registerDraftArtifact(db, cmd("reg-retired"), {
        artifactId: "ART-RET",
        revision: 2,
        sha256: SHA2,
        createdBy: "STAFF-AUTHOR",
        artifactType: "governance-doc",
        hasRegionSchema: false,
      }),
    ).rejects.toMatchObject({ code: "SFR-004" });
    await expect(
      createArtifactRevision(db, cmd("rev-retired"), {
        artifactId: "ART-RET",
        revision: 2,
        sha256: SHA2,
        createdBy: "STAFF-AUTHOR",
        semanticChange: false,
        dependents: [],
      }),
    ).rejects.toMatchObject({ code: "SFR-004" });
  });

  it("registerQualityContract: binding hash thật với sổ artifact — thiếu sổ, sai loại, sai hash đều chặn", async () => {
    const checks = ["self-check", "independent-review"];
    const contentSha = qualityContractContentSha256({ outputType: "code-change", requiredChecks: checks });

    await expect(
      registerQualityContract(db, cmd("qc-noledger"), {
        contractId: "QC-NOLEDGER",
        revision: 1,
        outputType: "code-change",
        requiredChecks: checks,
        registeredBy: "STAFF-AUTHOR",
      }),
    ).rejects.toMatchObject({ code: "ERR-TARGET" });

    await registerApprovedArtifact(db, cmd("qc-wrongtype"), {
      artifactId: "QC-WRONGTYPE",
      revision: 1,
      sha256: contentSha,
    });
    await expect(
      registerQualityContract(db, cmd("qc-wrongtype-reg"), {
        contractId: "QC-WRONGTYPE",
        revision: 1,
        outputType: "code-change",
        requiredChecks: checks,
        registeredBy: "STAFF-AUTHOR",
      }),
    ).rejects.toMatchObject({ code: "ERR-TYPE" });

    await registerApprovedArtifact(db, cmd("qc-badhash"), {
      artifactId: "QC-BADHASH",
      revision: 1,
      sha256: SHA,
      artifactType: "quality-contract",
    });
    await expect(
      registerQualityContract(db, cmd("qc-badhash-reg"), {
        contractId: "QC-BADHASH",
        revision: 1,
        outputType: "code-change",
        requiredChecks: checks,
        registeredBy: "STAFF-AUTHOR",
      }),
    ).rejects.toMatchObject({ code: "SFR-007" });
  });

  it("ready-check chặn pin không hiệu lực: chưa duyệt, sai hash, impact-pending — work-item giữ ACCEPTED, không phiên bản nào được ghi", async () => {
    // (a) hợp đồng chỉ mới draft trong sổ.
    const draftChecks = ["self-check", "independent-review"];
    const draftSha = qualityContractContentSha256({ outputType: "code-change", requiredChecks: draftChecks });
    await registerDraftArtifact(db, cmd("qc-draft"), {
      artifactId: "QC-DRAFT",
      revision: 1,
      sha256: draftSha,
      createdBy: "STAFF-AUTHOR",
      artifactType: "quality-contract",
      hasRegionSchema: false,
    });
    await registerQualityContract(db, cmd("qc-draft-reg"), {
      contractId: "QC-DRAFT",
      revision: 1,
      outputType: "code-change",
      requiredChecks: draftChecks,
      registeredBy: "STAFF-AUTHOR",
    });
    const run1 = await newRunWithWorkItem();
    await expect(
      runFixtureExecution(db, cmd("exec-draftqc"), {
        workItemId: run1.workItemId,
        executor: "AI-BUILD",
        outputId: `OUT-${run1.workItemId}`,
        outputRevision: 1,
        contentSha256: SHA,
        outputType: "code-change",
        qualityContractRef: { id: "QC-DRAFT", revision: 1, sha256: draftSha },
      }),
    ).rejects.toMatchObject({ code: "ERR-QC" });

    // (b) hợp đồng đã duyệt nhưng pin sai hash.
    const qcMain = await seedApprovedQualityContract(db, {
      id: "QC-MAIN",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B2-MAIN",
      registeredBy: "STAFF-AUTHOR",
    });
    await expect(
      runFixtureExecution(db, cmd("exec-badpin"), {
        workItemId: run1.workItemId,
        executor: "AI-BUILD",
        outputId: `OUT-${run1.workItemId}`,
        outputRevision: 1,
        contentSha256: SHA,
        outputType: "code-change",
        qualityContractRef: { ...qcMain, sha256: SHA2 },
      }),
    ).rejects.toMatchObject({ code: "SFR-007" });

    // (c) hợp đồng đã duyệt nhưng nguồn của nó vừa đổi nghĩa → impact-pending
    // → bị chặn SỬ DỤNG dù vẫn approved (trục kép trên chính hợp đồng).
    const qcImp = await seedApprovedQualityContract(db, {
      id: "QC-IMPACT",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC14-B2-IMP",
      registeredBy: "STAFF-AUTHOR",
    });
    await registerDraftArtifact(db, cmd("qc-src"), {
      artifactId: "QC-SRC",
      revision: 1,
      sha256: SHA,
      createdBy: "STAFF-AUTHOR",
      artifactType: "governance-doc",
      hasRegionSchema: false,
    });
    await createArtifactRevision(db, cmd("qc-src-rev"), {
      artifactId: "QC-SRC",
      revision: 2,
      sha256: SHA2,
      createdBy: "STAFF-AUTHOR",
      semanticChange: true,
      dependents: [{ artifactId: "QC-IMPACT", revision: 1 }],
    });
    await expect(
      runFixtureExecution(db, cmd("exec-impqc"), {
        workItemId: run1.workItemId,
        executor: "AI-BUILD",
        outputId: `OUT-${run1.workItemId}`,
        outputRevision: 1,
        contentSha256: SHA,
        outputType: "code-change",
        qualityContractRef: qcImp,
      }),
    ).rejects.toMatchObject({ code: "SFR-011" });

    // REC-001: mọi ca chặn không để lại dấu vết nửa chừng.
    const state = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_work_items WHERE id = ${run1.workItemId}) AS work_item,
        (SELECT count(*)::int FROM dopaios_output_versions WHERE id = ${"OUT-" + run1.workItemId}) AS outputs
    `)) as unknown as Array<{ work_item: string; outputs: number }>;
    expect(state[0]).toEqual({ work_item: "ACCEPTED", outputs: 0 });

    // (d) pin hợp lệ: chuỗi READY → CLAIMED → IN_PROGRESS → SUBMITTED và
    // phiên bản DRAFT → SUBMITTED cùng transaction, mang pin hợp đồng.
    const ok = await runFixtureExecution(db, cmd("exec-ok"), {
      workItemId: run1.workItemId,
      executor: "AI-BUILD",
      outputId: `OUT-${run1.workItemId}`,
      outputRevision: 1,
      contentSha256: SHA,
      outputType: "code-change",
      qualityContractRef: qcMain,
    });
    expect(ok).toMatchObject({ state: "SUBMITTED", outputState: "SUBMITTED" });
    const pinned = (await db.execute(sql`
      SELECT state, quality_contract_ref FROM dopaios_output_versions
      WHERE id = ${"OUT-" + run1.workItemId} AND revision = 1
    `)) as unknown as Array<{ state: string; quality_contract_ref: Record<string, unknown> }>;
    expect(pinned[0].state).toBe("SUBMITTED");
    expect(pinned[0].quality_contract_ref).toEqual(qcMain);
  });

  it("validate-self-check: bằng chứng sai hash bị từ chối GIỮ SUBMITTED; đúng hash sang SELF_CHECK — đã nộp không tự sinh đạt", async () => {
    const outputId = "OUT-WI-B2-1";
    await expect(
      validateSelfCheck(db, cmd("vsc-bad"), {
        outputId,
        outputRevision: 1,
        evidence: { ref: "SC-1", sha256: SHA2, targetSha256: SHA, by: "AI-BUILD" },
        expectedSha256: SELF_SHA,
      }),
    ).rejects.toMatchObject({ code: "SFR-020" });
    const still = (await db.execute(
      sql`SELECT state FROM dopaios_output_versions WHERE id = ${outputId} AND revision = 1`,
    )) as unknown as Array<{ state: string }>;
    expect(still[0].state).toBe("SUBMITTED");

    const ok = await validateSelfCheck(db, cmd("vsc-ok"), {
      outputId,
      outputRevision: 1,
      evidence: { ref: "SC-1", sha256: SELF_SHA, targetSha256: SHA, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    expect(ok).toMatchObject({ state: "SELF_CHECK" });
  });

  it("CHECK_PASSED chỉ khi đủ MỌI kiểm theo hợp đồng pin: hợp đồng 3 kiểm giữ INDEPENDENT_CHECK/UNDER_REVIEW tới khi bổ sung bằng chứng", async () => {
    const qc3 = await seedApprovedQualityContract(db, {
      id: "QC-3CHECK",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review", "build-log"],
      cmdPrefix: "KC14-B2-3C",
      registeredBy: "STAFF-AUTHOR",
    });
    const run2 = await newRunWithWorkItem();
    const outputId = `OUT-${run2.workItemId}`;
    await runFixtureExecution(db, cmd("exec-3c"), {
      workItemId: run2.workItemId,
      executor: "AI-BUILD",
      outputId,
      outputRevision: 1,
      contentSha256: SHA,
      outputType: "code-change",
      qualityContractRef: qc3,
    });
    await validateSelfCheck(db, cmd("vsc-3c"), {
      outputId,
      outputRevision: 1,
      evidence: { ref: "SC-3C", sha256: SELF_SHA, targetSha256: SHA, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    const review = await reviewFixtureExecution(db, cmd("rev-3c"), {
      workItemId: run2.workItemId,
      outputId,
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: { ref: "RE-3C", sha256: REVIEW_SHA, targetSha256: SHA, conclusion: "ready" },
      expectedReviewSha256: REVIEW_SHA,
    });
    // Thiếu build-log: work-item GIỮ UNDER_REVIEW, phiên bản GIỮ
    // INDEPENDENT_CHECK, lý do bền vững trong kết quả lệnh.
    expect(review).toMatchObject({
      state: "UNDER_REVIEW",
      outputState: "INDEPENDENT_CHECK",
      missingChecks: ["build-log"],
    });

    // Bằng chứng cho kiểm không thuộc hợp đồng bị chặn.
    await expect(
      attachCheckEvidence(db, cmd("att-alien"), {
        outputId,
        outputRevision: 1,
        checkKey: "kiem-la",
        evidence: { ref: "X", sha256: BUILD_SHA, targetSha256: SHA, by: "AI-BUILD" },
        expectedSha256: BUILD_SHA,
      }),
    ).rejects.toMatchObject({ code: "ERR-QC" });

    const attached = await attachCheckEvidence(db, cmd("att-build"), {
      outputId,
      outputRevision: 1,
      checkKey: "build-log",
      evidence: { ref: "BUILD-3C", sha256: BUILD_SHA, targetSha256: SHA, by: "AI-BUILD" },
      expectedSha256: BUILD_SHA,
    });
    expect(attached).toMatchObject({ outputState: "CHECK_PASSED", missingChecks: [] });
    const final = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_work_items WHERE id = ${run2.workItemId}) AS work_item,
        (SELECT state FROM dopaios_output_versions WHERE id = ${outputId} AND revision = 1) AS output
    `)) as unknown as Array<{ work_item: string; output: string }>;
    expect(final[0]).toEqual({ work_item: "COMPLETED", output: "CHECK_PASSED" });
  });

  it("revision hợp đồng mới không đổi âm thầm phiên bản đang chạy; bản nộp mới phải pin bản hiệu lực", async () => {
    // QC-MAIN rev2 qua đường KC-03 đầy đủ: rev1 thành superseded (SFR-028).
    const checks2 = ["self-check", "independent-review", "uat-note"];
    const content2 = qualityContractContentSha256({ outputType: "code-change", requiredChecks: checks2 });
    await createArtifactRevision(db, cmd("qc2-rev"), {
      artifactId: "QC-MAIN",
      revision: 2,
      sha256: content2,
      createdBy: "STAFF-AUTHOR",
      semanticChange: false,
      dependents: [],
    });
    await stageAndApprove("QC-MAIN", { revision: 2, sha256: content2, skipRegister: true });
    await registerQualityContract(db, cmd("qc2-reg"), {
      contractId: "QC-MAIN",
      revision: 2,
      outputType: "code-change",
      requiredChecks: checks2,
      registeredBy: "STAFF-AUTHOR",
    });

    const ledger = (await db.execute(sql`
      SELECT revision, artifact_state FROM dopaios_artifacts WHERE id = 'QC-MAIN' ORDER BY revision
    `)) as unknown as Array<{ revision: number; artifact_state: string }>;
    expect(ledger).toEqual([
      { revision: 1, artifact_state: "superseded" },
      { revision: 2, artifact_state: "approved" },
    ]);

    // Phiên bản OUT-WI-B2-1 pin QC-MAIN@1 từ trước: hoàn tất kiểm theo ĐÚNG
    // hợp đồng đã pin (2 kiểm) — không bị hợp đồng rev2 (3 kiểm) đổi âm thầm.
    const review = await reviewFixtureExecution(db, cmd("rev-main"), {
      workItemId: "WI-B2-1",
      outputId: "OUT-WI-B2-1",
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: { ref: "RE-MAIN", sha256: REVIEW_SHA, targetSha256: SHA, conclusion: "ready" },
      expectedReviewSha256: REVIEW_SHA,
    });
    expect(review).toMatchObject({ state: "COMPLETED", outputState: "CHECK_PASSED" });

    // Bản nộp MỚI pin QC-MAIN@1 (superseded) bị chặn tại ready-check.
    const qc1Sha = qualityContractContentSha256({
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
    });
    const run3 = await newRunWithWorkItem();
    await expect(
      runFixtureExecution(db, cmd("exec-superseded"), {
        workItemId: run3.workItemId,
        executor: "AI-BUILD",
        outputId: `OUT-${run3.workItemId}`,
        outputRevision: 1,
        contentSha256: SHA,
        outputType: "code-change",
        qualityContractRef: { id: "QC-MAIN", revision: 1, sha256: qc1Sha },
      }),
    ).rejects.toMatchObject({ code: "ERR-QC" });
  });

  it("replay rebuilds B2 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
