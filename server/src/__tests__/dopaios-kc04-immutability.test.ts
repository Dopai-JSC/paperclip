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
import { createArtifactRevision } from "../dopaios/lifecycle.ts";
import { startAiSession, recordSessionArtifact } from "../dopaios/sessions.ts";
import { traceCriticalOutput } from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-04 B3 — tiêu chí 3: "Thay artifact phải tạo phiên bản mới, không đổi
// bằng chứng cũ." Thay spec (createArtifactRevision, đường KC-14/KC-15) rồi
// chứng minh trên TRUY VẾT:
//  - hàng revision cũ trong sổ cái byte-identical trước/sau;
//  - phiên bản đầu ra cũ và bằng chứng kiểm không đổi;
//  - Approval Record cũ KHÔNG bị viết lại — chỉ nhận dấu invalidated_at
//    (ngữ nghĩa KC-14; hiệu lực đổi, lịch sử giữ nguyên);
//  - trace của đầu ra cũ vẫn giải được về ĐÚNG phiên bản spec cũ, còn mối
//    "quyết định kiểm" phản ánh mất hiệu lực;
//  - bằng chứng Phiên chạy AI bất biến (ghi đè cùng seq bị chặn);
//  - replay tái dựng y hệ (SQR-003) — không có đường UPDATE lịch sử ngoài
//    event log.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-04 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_SPEC1 = "3".repeat(64);
const SHA_SPEC2 = "6".repeat(64);
const SHA_CODE1 = "4".repeat(64);
const SELF_SHA = "7".repeat(64);
const REVIEW_SHA = "8".repeat(64);

const RUN = "RUN-KC04-B3";
const WI = "WI-KC04-B3";
const OUT = "OUT-KC04-B3";

let seq = 0;
const cmd = (label: string) => `KC04-B3-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-04 B3 — bất biến bằng chứng khi thay artifact", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

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

  async function rowSnapshot(query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
    return (await db.execute(query)) as unknown as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc04-b3-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, kind, capabilities] of [
      ["STAFF-DECIDER", "human", ["run-decider"]],
      ["STAFF-POD", "human", ["pod"]],
      ["AI-BUILD", "ai", ["producer"]],
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
    await pinSeparationPolicy(db, cmd("policy"), {
      policyId: "SEP-feature-spec",
      artifactType: "feature-spec",
      revision: 1,
      policy: {
        policy_id: "SEP-feature-spec",
        scope_level: "company",
        approver_capability: "governance-approver",
        effective_at: "2026-08-01T00:00:00Z",
        invalidation_rule: "revision-superseded",
      },
      pinnedBy: "SPEC-APPROVER-KC04",
    });
    // Spec approved qua đường sổ cái thật.
    await registerDraftArtifact(db, cmd("draft"), {
      artifactId: "ART-B3-SPEC",
      revision: 1,
      sha256: SHA_SPEC1,
      createdBy: "SPEC-AUTHOR-KC04",
      artifactType: "feature-spec",
      hasRegionSchema: false,
      sourceRefs: [],
      storageRef: "fixtures/content/kc04-b3-spec-r1.md",
    });
    await submitArtifactForReview(db, cmd("submit"), { artifactId: "ART-B3-SPEC", revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: "PKG-B3-SPEC-r1",
      revision: 1,
      target: { artifactId: "ART-B3-SPEC", revision: 1, sha256: SHA_SPEC1 },
      refs: { evidence: "ev-b3-spec-r1" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("approve"), {
      recordId: "REC-B3-SPEC-r1",
      packageId: "PKG-B3-SPEC-r1",
      packageRevision: 1,
      target: { artifactId: "ART-B3-SPEC", revision: 1, sha256: SHA_SPEC1 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-b3-spec-r1" },
      actor: "SPEC-APPROVER-KC04",
    });
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-KC04-B3",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC04-B3-QC",
      registeredBy: "STAFF-DECIDER",
    });
    // Run + work item + Phiên chạy AI + đầu ra approve — chuỗi tối thiểu.
    await executeCommand(db, {
      commandId: cmd("seed-run"),
      payload: { runId: RUN },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosSopRun-${RUN}`,
          type: "TestRunRequested",
          data: {
            runId: RUN,
            definitionRef: { definitionId: `DEF-${RUN}` },
            decider: "STAFF-DECIDER",
            pod: "STAFF-POD",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosSopRun-${RUN}`,
          type: "SopRunStateChanged",
          data: { runId: RUN, state: "RUNNING" },
        });
        await ctx.emit({
          streamName: `dopaiosWorkItem-${WI}`,
          type: "WorkItemCreated",
          data: { workItemId: WI, runId: RUN, state: "ACCEPTED", projectId: "PROJ-KC04-B3" },
          expectedVersion: -1,
        });
        return { ok: true };
      },
    });
    await startAiSession(db, cmd("ses"), {
      sessionId: "SES-B3",
      workItemId: WI,
      agentId: "AI-BUILD",
      engine: "fake-engine",
    });
    await recordSessionArtifact(db, cmd("sa"), {
      sessionId: "SES-B3",
      seq: 1,
      kind: "output",
      ref: "fixtures/content/kc04-b3-code-r1.ts",
      sha256: SHA_CODE1,
      confirmed: true,
    });
    await runFixtureExecution(db, cmd("exec"), {
      workItemId: WI,
      executor: "AI-BUILD",
      outputId: OUT,
      outputRevision: 1,
      contentSha256: SHA_CODE1,
      outputType: "code-change",
      qualityContractRef: qcRef,
      sourceRefs: [{ artifactId: "ART-B3-SPEC", revision: 1, sha256: SHA_SPEC1 }],
    });
    await validateSelfCheck(db, cmd("vsc"), {
      outputId: OUT,
      outputRevision: 1,
      evidence: { ref: `SC-${OUT}`, sha256: SELF_SHA, targetSha256: SHA_CODE1, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    await reviewFixtureExecution(db, cmd("rev"), {
      workItemId: WI,
      outputId: OUT,
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: {
        ref: `RE-${OUT}`,
        sha256: REVIEW_SHA,
        targetSha256: SHA_CODE1,
        conclusion: "ready",
      },
      expectedReviewSha256: REVIEW_SHA,
    });
    await advanceToDecision(db, cmd("adv"), {
      runId: RUN,
      outputId: OUT,
      outputRevision: 1,
      packageId: `PKG-${OUT}`,
      packageRevision: 1,
      refs: { outputId: OUT, revision: 1, sha256: SHA_CODE1 },
      requestId: `REQ-${OUT}`,
    });
    await recordApproval(db, cmd("appr"), {
      requestId: `REQ-${OUT}`,
      recordId: "AR-B3",
      packageId: `PKG-${OUT}`,
      packageRevision: 1,
      pinnedRefs: { outputId: OUT, revision: 1, sha256: SHA_CODE1 },
      actor: "STAFF-DECIDER",
      outputId: OUT,
      outputRevision: 1,
      outcome: "approve",
      openedStep: "T3",
    });
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("thay spec: revision mới vào sổ, bằng chứng cũ byte-identical, approval chỉ nhận dấu invalidated_at", async () => {
    const specBefore = await rowSnapshot(
      sql`SELECT * FROM dopaios_artifacts WHERE id = ${"ART-B3-SPEC"} AND revision = 1`,
    );
    const outputBefore = await rowSnapshot(
      sql`SELECT * FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 1`,
    );
    const approvalBefore = await rowSnapshot(sql`SELECT * FROM dopaios_approval_records WHERE id = ${"AR-B3"}`);
    expect(approvalBefore[0]?.["invalidated_at"]).toBeNull();

    // Thay artifact: bản nội dung mới, khai đổi nghĩa — impact đi qua sổ
    // dùng chung (KC-15), KHÔNG ghi đè bản cũ.
    await createArtifactRevision(db, cmd("rev2"), {
      artifactId: "ART-B3-SPEC",
      revision: 2,
      sha256: SHA_SPEC2,
      createdBy: "SPEC-AUTHOR-KC04",
      semanticChange: true,
      dependents: [],
      sourceRefs: [],
      storageRef: "fixtures/content/kc04-b3-spec-r2.md",
    });

    const specRows = await rowSnapshot(
      sql`SELECT revision, sha256, artifact_state FROM dopaios_artifacts WHERE id = ${"ART-B3-SPEC"} ORDER BY revision`,
    );
    expect(specRows).toEqual([
      { revision: 1, sha256: SHA_SPEC1, artifact_state: "approved" },
      { revision: 2, sha256: SHA_SPEC2, artifact_state: "draft" },
    ]);
    // Bằng chứng cũ không đổi: hàng sổ cái rev1 và phiên bản đầu ra y nguyên.
    const specAfter = await rowSnapshot(
      sql`SELECT * FROM dopaios_artifacts WHERE id = ${"ART-B3-SPEC"} AND revision = 1`,
    );
    expect(specAfter).toEqual(specBefore);
    const outputAfter = await rowSnapshot(
      sql`SELECT * FROM dopaios_output_versions WHERE id = ${OUT} AND revision = 1`,
    );
    expect(outputAfter).toEqual(outputBefore);
    // Approval Record: mọi trường giữ nguyên trừ dấu mất hiệu lực.
    const approvalAfter = await rowSnapshot(sql`SELECT * FROM dopaios_approval_records WHERE id = ${"AR-B3"}`);
    expect(approvalAfter[0]?.["invalidated_at"]).not.toBeNull();
    const stripInvalidation = (row: Record<string, unknown>) => {
      const { invalidated_at: _a, invalidation_reason: _b, ...rest } = row;
      return rest;
    };
    expect(stripInvalidation(approvalAfter[0]!)).toEqual(stripInvalidation(approvalBefore[0]!));
  });

  it("trace đầu ra cũ vẫn giải về ĐÚNG spec@1; mối quyết định kiểm phản ánh mất hiệu lực", async () => {
    const trace = await inCommand(cmd("trace"), (ctx) => traceCriticalOutput(ctx, OUT, 1));
    expect(trace.sources.map((s) => s.resolved)).toEqual([
      {
        artifactId: "ART-B3-SPEC",
        revision: 1,
        sha256: SHA_SPEC1,
        artifactType: "feature-spec",
        artifactState: "approved",
      },
    ]);
    // Quyết định kiểm không còn hiệu lực — nhưng KHÔNG phải vì lịch sử bị
    // sửa: record vẫn nguyên, chỉ mất hiệu lực qua invalidated_at.
    expect(trace.effectiveApprovals).toEqual([]);
    expect(trace.missing).toContain("quyet-dinh-kiem");
    expect(trace.missing).not.toContain("spec");
    expect(trace.missing).not.toContain("nguon");
  });

  it("bằng chứng Phiên chạy AI bất biến: ghi đè cùng seq bị chặn", async () => {
    await expect(
      recordSessionArtifact(db, cmd("sa-overwrite"), {
        sessionId: "SES-B3",
        seq: 1,
        kind: "output",
        ref: "fixtures/content/kc04-b3-code-r1-TAMPERED.ts",
        sha256: SHA_SPEC2,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "ERR-ARTIFACT-IMMUTABLE" });
  });

  it("replay dựng lại projection y hệ từ event log (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
