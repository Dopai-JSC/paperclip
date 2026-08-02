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
  runFixtureExecution,
  validateSelfCheck,
  reviewFixtureExecution,
} from "../dopaios/commands.ts";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
} from "../dopaios/approval.ts";
import { createArtifactRevision } from "../dopaios/lifecycle.ts";
import { startAiSession, recordSessionArtifact, completeSession } from "../dopaios/sessions.ts";
import {
  traceCriticalOutput,
  outputsPinningSourceRevision,
  artifactProvenance,
} from "../dopaios/graph-repo.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";

// KC-04 B6 — chốt các finding vòng review đối kháng 2 lens bằng test:
//  - (m-4) event ArtifactRegistered KIỂU CŨ (không mang sourceRefs/storageRef)
//    project ra null nhất quán live/replay;
//  - (m-5/m6) phủ đầu vào dị dạng của parser trên cả cửa bootstrap
//    registerApprovedArtifact: revision 0/âm, sourceRefs không phải mảng,
//    sha sai định dạng, entry lồng mảng, artifactId rỗng;
//  - (M-3) hàng sổ cái CŨ (source_refs null) trùng nội dung KHÔNG chặn oan
//    đầu ra mới tại cổng trace-complete — vế "artifact chưa khai nguồn" nằm
//    ở khóa run-level `artifact-khai-nguon`, ngoài cổng;
//  - (L1-m4) spec HAI revision cùng sống: truy vấn xuôi rev1/rev2 loại trừ
//    nhau trên dữ liệu thật, không rỗng tầm thường;
//  - (M-2/m-7) artifactProvenance neo producer vào work-item thực sự nộp
//    nội dung + chỉ bản ghi confirmed — session lạc trùng nội dung và bản
//    ghi chưa confirmed không nhiễm vào.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-04 B6 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_SPEC1 = "3".repeat(64);
const SHA_SPEC2 = "6".repeat(64);
const SHA_A = "4".repeat(64);
const SHA_B = "5".repeat(64);
const SHA_GATE = "9".repeat(64);
const SHA_DUP = "b".repeat(64);
const SELF_SHA = "7".repeat(64);
const REVIEW_SHA = "8".repeat(64);

const RUN = "RUN-KC04-B6";
const ITEMS = ["WI-B6-A", "WI-B6-B", "WI-B6-GATE", "WI-B6-REAL", "WI-B6-STRAY"];

let seq = 0;
const cmd = (label: string) => `KC04-B6-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-04 B6 — xử finding review đối kháng", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcPlain!: QualityContractRef;
  let qcTrace!: QualityContractRef;

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

  async function submitOutput(input: {
    workItemId: string;
    outputId: string;
    contentSha256: string;
    qcRef: QualityContractRef;
    sourceRefs: Array<{ artifactId: string; revision: number; sha256: string }>;
  }): Promise<void> {
    await runFixtureExecution(db, cmd(`exec-${input.outputId}`), {
      workItemId: input.workItemId,
      executor: "AI-BUILD",
      outputId: input.outputId,
      outputRevision: 1,
      contentSha256: input.contentSha256,
      outputType: "code-change",
      qualityContractRef: input.qcRef,
      sourceRefs: input.sourceRefs,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc04-b6-");
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
    qcPlain = await seedApprovedQualityContract(db, {
      id: "QC-B6-PLAIN",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC04-B6-QC1",
      registeredBy: "STAFF-DECIDER",
    });
    qcTrace = await seedApprovedQualityContract(db, {
      id: "QC-B6-TRACE",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review", "trace-complete"],
      cmdPrefix: "KC04-B6-QC2",
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
        for (const wi of ITEMS) {
          await ctx.emit({
            streamName: `dopaiosWorkItem-${wi}`,
            type: "WorkItemCreated",
            data: { workItemId: wi, runId: RUN, state: "ACCEPTED", projectId: "PROJ-KC04-B6" },
            expectedVersion: -1,
          });
        }
        return { ok: true };
      },
    });
    // Spec rev1 qua đường sổ cái thật.
    await registerDraftArtifact(db, cmd("spec-draft"), {
      artifactId: "SPEC-B6",
      revision: 1,
      sha256: SHA_SPEC1,
      createdBy: "SPEC-AUTHOR-KC04",
      artifactType: "feature-spec",
      hasRegionSchema: false,
      sourceRefs: [],
      storageRef: "fixtures/content/kc04-b6-spec-r1.md",
    });
    await submitArtifactForReview(db, cmd("spec-submit"), { artifactId: "SPEC-B6", revision: 1 });
    await assembleDecisionPackage(db, cmd("spec-pkg"), {
      packageId: "PKG-B6-SPEC-r1",
      revision: 1,
      target: { artifactId: "SPEC-B6", revision: 1, sha256: SHA_SPEC1 },
      refs: { evidence: "ev-b6-spec-r1" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec-approve"), {
      recordId: "REC-B6-SPEC-r1",
      packageId: "PKG-B6-SPEC-r1",
      packageRevision: 1,
      target: { artifactId: "SPEC-B6", revision: 1, sha256: SHA_SPEC1 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-b6-spec-r1" },
      actor: "SPEC-APPROVER-KC04",
    });
    // Đầu ra A pin rev1 (trước khi rev2 được duyệt).
    await submitOutput({
      workItemId: "WI-B6-A",
      outputId: "OUT-B6-A",
      contentSha256: SHA_A,
      qcRef: qcPlain,
      sourceRefs: [{ artifactId: "SPEC-B6", revision: 1, sha256: SHA_SPEC1 }],
    });
    // Hàng sổ cái KIỂU CŨ: event thô KHÔNG mang sourceRefs/storageRef —
    // đúng hình dạng event trước KC-04; nội dung TRÙNG với đầu ra GATE.
    await executeCommand(db, {
      commandId: cmd("legacy"),
      payload: { artifactId: "ART-B6-LEGACY" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosArtifact-ART-B6-LEGACY",
          type: "ArtifactRegistered",
          data: {
            artifactId: "ART-B6-LEGACY",
            revision: 1,
            sha256: SHA_GATE,
            artifactState: "approved",
            impactStatus: "clear",
          },
          expectedVersion: -1,
        });
        return { ok: true };
      },
    });
    // Chuỗi GATE: đầu ra pin sạch + Phiên chạy AI confirmed, nội dung trùng
    // hàng sổ cái cũ — cổng trace-complete KHÔNG được chặn oan (M-3).
    await startAiSession(db, cmd("ses-gate"), {
      sessionId: "SES-B6-GATE",
      workItemId: "WI-B6-GATE",
      agentId: "AI-BUILD",
      engine: "fake-engine",
    });
    await recordSessionArtifact(db, cmd("sa-gate"), {
      sessionId: "SES-B6-GATE",
      seq: 1,
      kind: "output",
      ref: "fixtures/content/kc04-b6-gate.ts",
      sha256: SHA_GATE,
      confirmed: true,
    });
    await submitOutput({
      workItemId: "WI-B6-GATE",
      outputId: "OUT-B6-GATE",
      contentSha256: SHA_GATE,
      qcRef: qcTrace,
      sourceRefs: [{ artifactId: "SPEC-B6", revision: 1, sha256: SHA_SPEC1 }],
    });
    await validateSelfCheck(db, cmd("vsc-gate"), {
      outputId: "OUT-B6-GATE",
      outputRevision: 1,
      evidence: { ref: "SC-OUT-B6-GATE", sha256: SELF_SHA, targetSha256: SHA_GATE, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    await reviewFixtureExecution(db, cmd("rev-gate"), {
      workItemId: "WI-B6-GATE",
      outputId: "OUT-B6-GATE",
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: {
        ref: "RE-OUT-B6-GATE",
        sha256: REVIEW_SHA,
        targetSha256: SHA_GATE,
        conclusion: "ready",
      },
      expectedReviewSha256: REVIEW_SHA,
    });
    // Kịch bản M-2: artifact nội dung SHA_DUP; producer THẬT là WI-B6-REAL
    // (có phiên confirmed + có đầu ra cùng sha); phiên LẠC ở WI-B6-STRAY
    // ghi cùng sha nhưng không nộp đầu ra; thêm một phiên chưa confirmed
    // ngay trên WI-B6-REAL.
    await registerApprovedArtifact(db, cmd("dup"), {
      artifactId: "ART-B6-DUP",
      revision: 1,
      sha256: SHA_DUP,
      artifactType: "code",
      sourceRefs: [{ artifactId: "SPEC-B6", revision: 1, sha256: SHA_SPEC1 }],
      storageRef: "fixtures/content/kc04-b6-dup.ts",
    });
    for (const [sessionId, wi, confirmed] of [
      ["SES-B6-REAL", "WI-B6-REAL", true],
      ["SES-B6-UNCONF", "WI-B6-REAL", false],
      ["SES-B6-STRAY", "WI-B6-STRAY", true],
    ] as const) {
      await startAiSession(db, cmd(`ses-${sessionId}`), {
        sessionId,
        workItemId: wi,
        agentId: "AI-BUILD",
        engine: "fake-engine",
      });
      await recordSessionArtifact(db, cmd(`sa-${sessionId}`), {
        sessionId,
        seq: 1,
        kind: "output",
        ref: `fixtures/content/${sessionId}.ts`,
        sha256: SHA_DUP,
        confirmed,
      });
      // KC-05 B7: guard mới một-work-item-một-phiên-RUNNING (ERR-SESSION-
      // CONFLICT) — kết thúc phiên REAL trước khi mở phiên chưa-confirmed
      // trên cùng work-item; provenance chỉ đọc bản ghi confirmed nên hành
      // vi được kiểm của KC-04 không đổi.
      if (sessionId === "SES-B6-REAL") {
        await completeSession(db, cmd("ses-real-done"), {
          sessionId: "SES-B6-REAL",
          outcome: "succeeded",
        });
      }
    }
    await submitOutput({
      workItemId: "WI-B6-REAL",
      outputId: "OUT-B6-REAL",
      contentSha256: SHA_DUP,
      qcRef: qcPlain,
      sourceRefs: [{ artifactId: "SPEC-B6", revision: 1, sha256: SHA_SPEC1 }],
    });
    // Spec rev2 vào sổ và được duyệt; đầu ra B pin rev2.
    await createArtifactRevision(db, cmd("spec-rev2"), {
      artifactId: "SPEC-B6",
      revision: 2,
      sha256: SHA_SPEC2,
      createdBy: "SPEC-AUTHOR-KC04",
      semanticChange: false,
      dependents: [],
      sourceRefs: [],
      storageRef: "fixtures/content/kc04-b6-spec-r2.md",
    });
    await submitArtifactForReview(db, cmd("spec2-submit"), { artifactId: "SPEC-B6", revision: 2 });
    await assembleDecisionPackage(db, cmd("spec2-pkg"), {
      packageId: "PKG-B6-SPEC-r2",
      revision: 1,
      target: { artifactId: "SPEC-B6", revision: 2, sha256: SHA_SPEC2 },
      refs: { evidence: "ev-b6-spec-r2" },
      fields: {},
    });
    await recordApprovalDecision(db, cmd("spec2-approve"), {
      recordId: "REC-B6-SPEC-r2",
      packageId: "PKG-B6-SPEC-r2",
      packageRevision: 1,
      target: { artifactId: "SPEC-B6", revision: 2, sha256: SHA_SPEC2 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: "ev-b6-spec-r2" },
      actor: "SPEC-APPROVER-KC04",
    });
    await submitOutput({
      workItemId: "WI-B6-B",
      outputId: "OUT-B6-B",
      contentSha256: SHA_B,
      qcRef: qcPlain,
      sourceRefs: [{ artifactId: "SPEC-B6", revision: 2, sha256: SHA_SPEC2 }],
    });
  }, 180_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("m-4: event kiểu cũ project ra null cả hai cột; replay giữ y hệ", async () => {
    const rows = (await db.execute(
      sql`SELECT source_refs, storage_ref FROM dopaios_artifacts
          WHERE id = ${"ART-B6-LEGACY"} AND revision = 1`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ source_refs: null, storage_ref: null }]);
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });

  it("m-5/m6: cửa bootstrap từ chối mọi pin dị dạng, không để lại row", async () => {
    const badPins: Array<[string, unknown]> = [
      ["rev0", [{ artifactId: "SPEC-B6", revision: 0 }]],
      ["rev-am", [{ artifactId: "SPEC-B6", revision: -1 }]],
      ["khong-mang", { artifactId: "SPEC-B6", revision: 1 }],
      ["sha-sai", [{ sha256: "XYZ" }]],
      ["long-mang", [[{ artifactId: "SPEC-B6", revision: 1 }]]],
      ["id-rong", [{ artifactId: "", sha256: SHA_DUP }]],
    ];
    for (const [label, sourceRefs] of badPins) {
      await expect(
        registerApprovedArtifact(db, cmd(`bad-${label}`), {
          artifactId: "ART-B6-BAD",
          revision: 1,
          sha256: SHA_A,
          artifactType: "code",
          sourceRefs: sourceRefs as Array<Record<string, unknown>>,
        }),
      ).rejects.toMatchObject({ code: "ERR-SOURCE-PIN" });
    }
    const rows = (await db.execute(
      sql`SELECT revision FROM dopaios_artifacts WHERE id = ${"ART-B6-BAD"}`,
    )) as unknown as unknown[];
    expect(rows).toEqual([]);
  });

  it("M-3: hàng sổ cái cũ trùng nội dung không chặn oan cổng trace-complete; vế khai-nguồn nằm ở khóa run-level", async () => {
    const state = (await db.execute(
      sql`SELECT state FROM dopaios_output_versions WHERE id = ${"OUT-B6-GATE"} AND revision = 1`,
    )) as unknown as Array<{ state: string }>;
    expect(state[0]?.state).toBe("CHECK_PASSED");
    const trace = await inCommand(cmd("trace-gate"), (ctx) =>
      traceCriticalOutput(ctx, "OUT-B6-GATE", 1),
    );
    expect(trace.missing).not.toContain("nguon");
    expect(trace.missing).toContain("artifact-khai-nguon");
    expect(trace.missing).toContain("noi-luu");
  });

  it("L1-m4: hai revision spec cùng sống — truy vấn xuôi rev1/rev2 loại trừ nhau trên dữ liệu thật", async () => {
    const fromRev1 = await inCommand(cmd("fwd1"), (ctx) =>
      outputsPinningSourceRevision(ctx, "SPEC-B6", 1),
    );
    expect(fromRev1.map((o) => o.outputId)).toEqual(["OUT-B6-A", "OUT-B6-GATE", "OUT-B6-REAL"]);
    const fromRev2 = await inCommand(cmd("fwd2"), (ctx) =>
      outputsPinningSourceRevision(ctx, "SPEC-B6", 2),
    );
    expect(fromRev2.map((o) => o.outputId)).toEqual(["OUT-B6-B"]);
  });

  it("M-2/m-7: provenance chỉ nhận producer thực sự nộp nội dung, confirmed — session lạc và bản ghi chưa confirmed không nhiễm", async () => {
    const provenance = await inCommand(cmd("prov"), (ctx) =>
      artifactProvenance(ctx, "ART-B6-DUP", 1),
    );
    expect(provenance.producers).toEqual([
      {
        sessionId: "SES-B6-REAL",
        agentId: "AI-BUILD",
        engine: "fake-engine",
        workItemId: "WI-B6-REAL",
        runId: RUN,
        projectId: "PROJ-KC04-B6",
      },
    ]);
  });
});
