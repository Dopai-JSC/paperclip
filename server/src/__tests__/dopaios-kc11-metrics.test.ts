import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  activateSopRun,
  advanceToDecision,
  createSopDefinition,
  publishSopDefinition,
  recordApproval,
  registerActor,
  registerApprovedArtifact,
  requestTestRun,
  reviewFixtureExecution,
  runFixtureExecution,
  validateSelfCheck,
} from "../dopaios/commands.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import type { QualityContractRef } from "../dopaios/lifecycle.ts";
import { FakeEngine, runWorkItemSession, latestConfirmedCheckpoint } from "../dopaios/engine.ts";
import {
  completeSession,
  detectStalledSessions,
  startAiSession,
} from "../dopaios/sessions.ts";
import {
  METRIC_DICTIONARY,
  automationStats,
  automationStatsFromEventLog,
  costPerAcceptedFunction,
  gateLoad,
} from "../dopaios/metric-sources.ts";
import { workItemCostSummary } from "../dopaios/cost-summary.ts";

// KC-11 B3: nguồn event cho tỷ lệ tự động, sản lượng nghiệm thu/giờ người và
// tải tại cổng — mẫu số chống gaming SM-C4, kiểm bằng recount độc lập dựng
// thẳng từ event log (không qua projection).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-11 metric tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "9".repeat(64);
const SELF_SHA = "5".repeat(64);
const REVIEW_SHA = "4".repeat(64);
let seq = 0;
const cmd = (label: string) => `KC11-M-${label}-${(seq += 1)}`;

const STEP_USAGE = {
  model: "claude-sonnet-5",
  billingType: "subscription_included",
  inputTokens: 1000,
  cachedInputTokens: 500,
  cacheCreationInputTokens: 0,
  outputTokens: 400,
  costUsdReported: null,
};

describeEmbeddedPostgres("dopaios KC-11 metric event sources", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let qcRef!: QualityContractRef;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc11m-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, kind, capabilities] of [
      ["STAFF-DECIDER", "human", ["run-decider"]],
      ["STAFF-POD", "human", ["pod"]],
    ] as const) {
      await registerActor(db, cmd(`a-${actorId}`), {
        actorId,
        kind,
        active: true,
        capabilities: [...capabilities],
      });
    }
    await registerApprovedArtifact(db, cmd("art"), { artifactId: "SOP-M", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-M",
      revision: 1,
      sopPin: { artifactId: "SOP-M", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-M",
      definitionContentSha256: SHA,
      expectedSopSha256: SHA,
    });
    qcRef = await seedApprovedQualityContract(db, {
      id: "QC-KC11-M",
      outputType: "code-change",
      requiredChecks: ["self-check", "independent-review"],
      cmdPrefix: "KC11-M-QC",
    });
    for (const [runId, workItemId] of [
      ["RUN-M1", "WI-M1"],
      ["RUN-M2", "WI-M2"],
      ["RUN-M3", "WI-M3"],
      ["RUN-M4", "WI-M4"],
    ] as const) {
      await requestTestRun(db, cmd(`run-${runId}`), {
        runId,
        definitionRef: { definitionId: "DEF-M" },
        decider: "STAFF-DECIDER",
        pod: "STAFF-POD",
        fixturePackage: { id: "FX-02", sha256: SHA },
      });
      await activateSopRun(db, cmd(`act-${runId}`), { runId, workItemId });
    }

    // WI-M1: hoàn thành tự động thuần — một phiên succeeded.
    await runWorkItemSession(db, {
      sessionId: "SES-M1",
      agentId: "AGENT-M",
      adapter: new FakeEngine([], STEP_USAGE),
      contract: { workItemId: "WI-M1", contractRevision: 1, sopRef: {}, steps: ["b1", "b2"] },
    });

    // WI-M2: crash → watchdog interrupt → retry succeeded. Chuỗi retry vẫn là
    // tự động (không thao tác người) nhưng KHÔNG được gộp phiên.
    const crashEngine = new FakeEngine(["b1"], STEP_USAGE);
    const first = await runWorkItemSession(db, {
      sessionId: "SES-M2A",
      agentId: "AGENT-M",
      adapter: crashEngine,
      contract: { workItemId: "WI-M2", contractRevision: 1, sopRef: {}, steps: ["b1", "b2"] },
    });
    expect(first.kind).toBe("process-lost");
    const interrupted = await detectStalledSessions(db, {
      thresholdMs: 0,
      nowMs: Date.now() + 60_000,
    });
    expect(interrupted.map((s) => s.sessionId)).toContain("SES-M2A");
    const resume = await latestConfirmedCheckpoint(db, "SES-M2A");
    const second = await runWorkItemSession(db, {
      sessionId: "SES-M2B",
      agentId: "AGENT-M",
      adapter: crashEngine,
      contract: { workItemId: "WI-M2", contractRevision: 1, sopRef: {}, steps: ["b1", "b2"] },
      predecessor: { id: "SES-M2A", relation: "retry" },
      resume: resume ? { nextStepIndex: resume.nextStepIndex } : undefined,
    });
    expect(second.kind).toBe("succeeded");

    // WI-M3: lời nhắc thủ công — phiên engine 'manual' rồi thất bại. SM-C4:
    // không được tính vào tử số tự động và không được tính là hoàn thành.
    await startAiSession(db, cmd("m3-start"), {
      sessionId: "SES-M3",
      workItemId: "WI-M3",
      agentId: "AGENT-M",
      engine: "manual",
    });
    await completeSession(db, cmd("m3-done"), { sessionId: "SES-M3", outcome: "failed" });

    // WI-M4: chuỗi quyết định đầy đủ tới điểm phê duyệt — nguồn tải tại cổng.
    await runFixtureExecution(db, cmd("m4-exec"), {
      workItemId: "WI-M4",
      executor: "AI-BUILD",
      outputId: "OUT-M4",
      outputRevision: 1,
      contentSha256: SHA,
      outputType: "code-change",
      qualityContractRef: qcRef,
    });
    await validateSelfCheck(db, cmd("m4-vsc"), {
      outputId: "OUT-M4",
      outputRevision: 1,
      evidence: { ref: "SC-OUT-M4", sha256: SELF_SHA, targetSha256: SHA, by: "AI-BUILD" },
      expectedSha256: SELF_SHA,
    });
    await reviewFixtureExecution(db, cmd("m4-rev"), {
      workItemId: "WI-M4",
      outputId: "OUT-M4",
      outputRevision: 1,
      executor: "AI-BUILD",
      reviewer: "AI-REVIEWER",
      reviewEvidence: {
        ref: "RE-OUT-M4",
        sha256: REVIEW_SHA,
        targetSha256: SHA,
        conclusion: "ready",
      },
      expectedReviewSha256: REVIEW_SHA,
    });
    await advanceToDecision(db, cmd("m4-adv"), {
      runId: "RUN-M4",
      outputId: "OUT-M4",
      outputRevision: 1,
      packageId: "PKG-M4",
      packageRevision: 1,
      refs: { outputId: "OUT-M4", revision: 1, sha256: SHA },
      requestId: "REQ-M4",
    });
    await recordApproval(db, cmd("m4-approve"), {
      requestId: "REQ-M4",
      recordId: "APR-M4",
      packageId: "PKG-M4",
      packageRevision: 1,
      pinnedRefs: { outputId: "OUT-M4", revision: 1, sha256: SHA },
      actor: "STAFF-DECIDER",
      outputId: "OUT-M4",
      outputRevision: 1,
      outcome: "approve",
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("computes automation rate with SM-C4 denominators (no merged retries, no manual, no un-passed)", async () => {
    const stats = await automationStats(db);
    expect(stats.denominator).toBe(3);
    expect(stats.numerator).toBe(2);
    expect(stats.automationRate).toBeCloseTo(2 / 3, 10);

    const byId = Object.fromEntries(stats.workItems.map((w) => [w.workItemId, w]));
    expect(byId["WI-M1"]).toMatchObject({
      sessionCount: 1,
      retrySessionCount: 0,
      manualSessionCount: 0,
      completed: true,
      automated: true,
    });
    // Chuỗi retry hiện rõ hai phiên — không gộp; vẫn là tự động.
    expect(byId["WI-M2"]).toMatchObject({
      sessionCount: 2,
      retrySessionCount: 1,
      manualSessionCount: 0,
      completed: true,
      automated: true,
    });
    // Lời nhắc thủ công + đầu ra chưa đạt: rớt cả completed lẫn automated.
    expect(byId["WI-M3"]).toMatchObject({
      sessionCount: 1,
      manualSessionCount: 1,
      completed: false,
      automated: false,
    });
  });

  it("independent recount from the raw event log agrees with the projection path", async () => {
    const fromProjection = await automationStats(db);
    const fromEventLog = await automationStatsFromEventLog(db);
    expect(fromEventLog).toEqual(fromProjection);
  });

  it("sources gate load from approval records, gate records and action requests", async () => {
    const load = await gateLoad(db);
    // Hai approval record thật: seedApprovedQualityContract duyệt Hợp đồng
    // chất lượng (điểm phê duyệt artifact) + quyết định WI-M4 (điểm phê duyệt
    // run) — tải tại cổng đếm MỌI điểm phê duyệt, không lọc theo nguồn.
    expect(load.approvalsByOutcome).toEqual({ approve: 2 });
    // Điểm phê duyệt run test không phải Cổng A/B/C — không được có Gate Record.
    expect(load.gateRecordsByGate).toEqual({});
    // Yêu cầu quyết định của WI-M4 được ghi và chuyển trạng thái khi quyết —
    // chuyển cấp không bị bỏ ghi nhận (SM-C4).
    const keys = Object.keys(load.actionRequestsByKindState);
    expect(keys.length).toBeGreaterThan(0);
    const total = Object.values(load.actionRequestsByKindState).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
    expect(keys[0]).toMatch(/^decision\//u);
  });

  it("computes the NFR-2 slice with a frozen denominator and refuses invalid denominators", async () => {
    const m1 = await workItemCostSummary(db, "WI-M1");
    const m2 = await workItemCostSummary(db, "WI-M2");
    // WI-M1: 2 bước; WI-M2: crash sau b1 (1 usage) + retry chạy b2 (1 usage)
    // → tổng 4 bước × 0.0061.
    const total = (Number(m1.totals.costUsdComputed) + Number(m2.totals.costUsdComputed)).toFixed(8);
    expect(total).toBe("0.02440000");
    const slice = costPerAcceptedFunction(total, ["F-M1", "F-M2"]);
    expect(slice).toEqual({ costPerFunctionUsd: "0.01220000", frozenCount: 2 });
    expect(() => costPerAcceptedFunction(total, [])).toThrowError(/non-empty frozen/u);
    expect(() => costPerAcceptedFunction(total, ["F1", "F1"])).toThrowError(/duplicates/u);
    expect(METRIC_DICTIONARY.metrics.costPerAcceptedFunction.exclusions[0]).toMatch(
      /mẫu số không đổi/u,
    );
  });
});
