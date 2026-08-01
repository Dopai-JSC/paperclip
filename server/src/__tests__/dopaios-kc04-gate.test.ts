import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand } from "../dopaios/event-store.ts";
import {
  registerActor,
  runFixtureExecution,
  validateSelfCheck,
  reviewFixtureExecution,
  advanceToDecision,
  attachCheckEvidence,
} from "../dopaios/commands.ts";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
} from "../dopaios/approval.ts";
import { startAiSession, recordSessionArtifact } from "../dopaios/sessions.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-04 B4 — FR-21 nghiệm thu: "trường hợp kiểm thử thiếu liên kết bị chặn"
// (+ FR-50: hồ sơ mất nguồn không thể được chấp nhận). Hợp đồng chất lượng
// khai khóa "trace-complete" → maybePassChecks tự đánh giá liên kết truy vết
// bằng MÁY qua graph-repo (guard hình dạng production — ASM-001): thiếu
// liên kết spec/nguồn hoặc không có Phiên chạy AI ghi nhận nội dung thì đầu
// ra không đạt CHECK_PASSED và không thể trình điểm quyết định
// (AC-FR-24.2). Bằng chứng đính kèm cho khóa này KHÔNG được đọc — tác nhân
// sản xuất không thể tự khai cho qua (FR-29). Contract không khai khóa:
// hành vi giữ nguyên (tương thích ngược).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-04 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_SPEC1 = "3".repeat(64);
const SHA_OK = "4".repeat(64);
const SHA_NOSRC = "5".repeat(64);
const SHA_NOSES = "6".repeat(64);
const SHA_COMPAT = "9".repeat(64);
const SELF_SHA = "7".repeat(64);
const REVIEW_SHA = "8".repeat(64);
const FORGE_SHA = "e".repeat(64);

const RUN = "RUN-KC04-B4";

let seq = 0;
const cmd = (label: string) => `KC04-B4-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-04 B4 — thiếu liên kết bị chặn tại cổng kiểm", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcTrace!: QualityContractRef;
  let qcPlain!: QualityContractRef;

  async function outputState(outputId: string): Promise<string | undefined> {
    const rows = (await db.execute(
      sql`SELECT state FROM dopaios_output_versions WHERE id = ${outputId} AND revision = 1`,
    )) as unknown as Array<{ state: string }>;
    return rows[0]?.state;
  }

  async function runChain(input: {
    workItemId: string;
    outputId: string;
    contentSha256: string;
    qcRef: QualityContractRef;
    sourceRefs?: Array<{ artifactId: string; revision: number; sha256: string }>;
    withSession: boolean;
  }): Promise<void> {
    if (input.withSession) {
      await startAiSession(db, cmd(`ses-${input.workItemId}`), {
        sessionId: `SES-${input.workItemId}`,
        workItemId: input.workItemId,
        agentId: "AI-BUILD",
        engine: "fake-engine",
      });
      await recordSessionArtifact(db, cmd(`sa-${input.workItemId}`), {
        sessionId: `SES-${input.workItemId}`,
        seq: 1,
        kind: "output",
        ref: `fixtures/content/${input.outputId}.ts`,
        sha256: input.contentSha256,
        confirmed: true,
      });
    }
    await runFixtureExecution(db, cmd(`exec-${input.workItemId}`), {
      workItemId: input.workItemId,
      executor: "AI-BUILD",
      outputId: input.outputId,
      outputRevision: 1,
      contentSha256: input.contentSha256,
      outputType: "code-change",
      qualityContractRef: input.qcRef,
      ...(input.sourceRefs ? { sourceRefs: input.sourceRefs } : {}),
    });
    await validateSelfCheck(db, cmd(`vsc-${input.workItemId}`), {
      outputId: input.outputId,
      outputRevision: 1,
      evidence: {
        ref: `SC-${input.outputId}`,
        sha256: SELF_SHA,
        targetSha256: input.contentSha256,
        by: "AI-BUILD",
      },
      expectedSha256: SELF_SHA,
    });
    await reviewFixtureExecution(db, cmd(`rev-${input.workItemId}`), {
      workItemId: input.workItemId,
      outputId: input.outputId,
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: {
        ref: `RE-${input.outputId}`,
        sha256: REVIEW_SHA,
        targetSha256: input.contentSha256,
        conclusion: "ready",
      },
      expectedReviewSha256: REVIEW_SHA,
    });
  }

  function advancePayload(outputId: string, contentSha256: string) {
    return {
      runId: RUN,
      outputId,
      outputRevision: 1,
      packageId: `PKG-${outputId}`,
      packageRevision: 1,
      refs: { outputId, revision: 1, sha256: contentSha256 },
      requestId: `REQ-${outputId}`,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc04-b4-");
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
    await registerDraftArtifact(db, cmd("draft"), {
      artifactId: "ART-B4-SPEC",
      revision: 1,
      sha256: SHA_SPEC1,
      createdBy: "SPEC-AUTHOR-KC04",
      artifactType: "feature-spec",
      hasRegionSchema: false,
      storageRef: "fixtures/content/kc04-b4-spec-r1.md",
    });
    await submitArtifactForReview(db, cmd("submit"), { artifactId: "ART-B4-SPEC", revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: "PKG-B4-SPEC-r1",
      revision: 1,
      target: { artifactId: "ART-B4-SPEC", revision: 1, sha256: SHA_SPEC1 },
      refs: { evidence: "ev-b4-spec-r1" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("approve"), {
      recordId: "REC-B4-SPEC-r1",
      packageId: "PKG-B4-SPEC-r1",
      packageRevision: 1,
      target: { artifactId: "ART-B4-SPEC", revision: 1, sha256: SHA_SPEC1 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-b4-spec-r1" },
      actor: "SPEC-APPROVER-KC04",
    });
    qcTrace = await seedApprovedQualityContract(db, {
      id: "QC-KC04-B4-TRACE",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review", "trace-complete"],
      cmdPrefix: "KC04-B4-QC1",
      registeredBy: "STAFF-DECIDER",
    });
    qcPlain = await seedApprovedQualityContract(db, {
      id: "QC-KC04-B4-PLAIN",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC04-B4-QC2",
      registeredBy: "STAFF-DECIDER",
    });
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
        for (const wi of ["WI-B4-OK", "WI-B4-NOSRC", "WI-B4-NOSES", "WI-B4-COMPAT"]) {
          await ctx.emit({
            streamName: `dopaiosWorkItem-${wi}`,
            type: "WorkItemCreated",
            data: { workItemId: wi, runId: RUN, state: "ACCEPTED", projectId: "PROJ-KC04-B4" },
            expectedVersion: -1,
          });
        }
        return { ok: true };
      },
    });
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("đủ liên kết: trace-complete máy-kiểm đạt → CHECK_PASSED và trình điểm được", async () => {
    await runChain({
      workItemId: "WI-B4-OK",
      outputId: "OUT-B4-OK",
      contentSha256: SHA_OK,
      qcRef: qcTrace,
      sourceRefs: [{ artifactId: "ART-B4-SPEC", revision: 1, sha256: SHA_SPEC1 }],
      withSession: true,
    });
    expect(await outputState("OUT-B4-OK")).toBe("CHECK_PASSED");
    await advanceToDecision(db, cmd("adv-ok"), advancePayload("OUT-B4-OK", SHA_OK));
    expect(await outputState("OUT-B4-OK")).toBe("AWAITING_DECISION");
  });

  it("FR-21: trường hợp kiểm thử thiếu liên kết spec bị chặn — không CHECK_PASSED, không trình điểm", async () => {
    await runChain({
      workItemId: "WI-B4-NOSRC",
      outputId: "OUT-B4-NOSRC",
      contentSha256: SHA_NOSRC,
      qcRef: qcTrace,
      withSession: true,
    });
    expect(await outputState("OUT-B4-NOSRC")).toBe("INDEPENDENT_CHECK");
    await expect(
      advanceToDecision(db, cmd("adv-nosrc"), advancePayload("OUT-B4-NOSRC", SHA_NOSRC)),
    ).rejects.toMatchObject({ code: "AC-FR-24.2" });
  });

  it("thiếu Phiên chạy AI ghi nhận nội dung: bị chặn cùng cổng", async () => {
    await runChain({
      workItemId: "WI-B4-NOSES",
      outputId: "OUT-B4-NOSES",
      contentSha256: SHA_NOSES,
      qcRef: qcTrace,
      sourceRefs: [{ artifactId: "ART-B4-SPEC", revision: 1, sha256: SHA_SPEC1 }],
      withSession: false,
    });
    expect(await outputState("OUT-B4-NOSES")).toBe("INDEPENDENT_CHECK");
    await expect(
      advanceToDecision(db, cmd("adv-noses"), advancePayload("OUT-B4-NOSES", SHA_NOSES)),
    ).rejects.toMatchObject({ code: "AC-FR-24.2" });
  });

  it("FR-29: đính bằng chứng giả cho trace-complete không được đọc — máy vẫn chặn", async () => {
    const forged = await attachCheckEvidence(db, cmd("forge"), {
      outputId: "OUT-B4-NOSRC",
      outputRevision: 1,
      checkKey: "trace-complete",
      evidence: {
        ref: "FORGED-TRACE-EVIDENCE",
        sha256: FORGE_SHA,
        targetSha256: SHA_NOSRC,
        by: "AI-BUILD",
      },
      expectedSha256: FORGE_SHA,
    });
    expect(forged).toMatchObject({
      outputState: "INDEPENDENT_CHECK",
      missingChecks: ["trace-complete:spec"],
    });
    expect(await outputState("OUT-B4-NOSRC")).toBe("INDEPENDENT_CHECK");
    await expect(
      advanceToDecision(db, cmd("adv-forge"), advancePayload("OUT-B4-NOSRC", SHA_NOSRC)),
    ).rejects.toMatchObject({ code: "AC-FR-24.2" });
  });

  it("tương thích ngược: contract không khai trace-complete giữ nguyên hành vi cũ", async () => {
    await runChain({
      workItemId: "WI-B4-COMPAT",
      outputId: "OUT-B4-COMPAT",
      contentSha256: SHA_COMPAT,
      qcRef: qcPlain,
      withSession: false,
    });
    expect(await outputState("OUT-B4-COMPAT")).toBe("CHECK_PASSED");
  });
});
