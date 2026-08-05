import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  readStream,
  replayProjections,
  snapshotProjections,
} from "../dopaios/event-store.ts";
import {
  activateSopRun,
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "../dopaios/commands.ts";
import { FakeEngine, runWorkItemSession } from "../dopaios/engine.ts";
import { recordSessionUsage, completeSession } from "../dopaios/sessions.ts";
import {
  computeCostUsd,
  resolveModelPrice,
  PRICE_SOURCE,
  PriceResolutionError,
} from "../dopaios/pricing.ts";
import { workItemCostSummary } from "../dopaios/cost-summary.ts";

// KC-11 B1: usage/chi phí theo Phiên chạy AI trên event store KC-01 —
// mỗi bước engine một dòng usage; trần chi phí hợp đồng (limits.costUsd)
// hard-stop tại ranh bước theo FR-38; chuỗi retry không gộp phiên (SM-C4).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-11 usage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// FakeEngine usage tất định: claude-sonnet-5 tại pin LiteLLM có giá
// in 2e-6, cache-read 2e-7, cache-creation 2.5e-6, out 1e-5 → mỗi bước
// computed 1000×2e-6 + 500×2e-7 + 0×2.5e-6 + 400×1e-5 = 0.00610000 USD.
const STEP_TOKENS = {
  inputTokens: 1000,
  cachedInputTokens: 500,
  cacheCreationInputTokens: 0,
  outputTokens: 400,
};
const STEP_COMPUTED = "0.00610000";

describeEmbeddedPostgres("dopaios KC-11 usage and budget per AI session", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc11-");
    db = createDb(tempDb.connectionString);
    const sha = "a".repeat(64);
    await registerApprovedArtifact(db, "U-SEED-ART", { artifactId: "SOP-U", revision: 1, sha256: sha });
    await createSopDefinition(db, "U-SEED-DEF", {
      definitionId: "DEF-U",
      revision: 1,
      sopPin: { artifactId: "SOP-U", revision: 1, sha256: sha },
    });
    await publishSopDefinition(db, "U-SEED-PUB", {
      definitionId: "DEF-U",
      definitionContentSha256: sha,
      expectedSopSha256: sha,
    });
    for (const [runId, workItemId] of [
      ["RUN-KC11-A", "WI-KC11-A"],
      ["RUN-KC11-B", "WI-KC11-B"],
      ["RUN-KC11-C", "WI-KC11-C"],
    ] as const) {
      await requestTestRun(db, `U-SEED-RUN-${runId}`, {
        runId,
        definitionRef: { definitionId: "DEF-U", revision: 1 },
        decider: "DECIDER-1",
        pod: "POD-1",
        fixturePackage: {},
      });
      await activateSopRun(db, `U-SEED-ACT-${runId}`, { runId, workItemId });
    }
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("pins the LiteLLM price table and fails closed on unknown models", () => {
    const price = resolveModelPrice("claude-sonnet-5");
    expect(price).toEqual({
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.00001,
      cacheReadCostPerToken: 2e-7,
      cacheCreationCostPerToken: 0.0000025,
    });
    expect(computeCostUsd("claude-sonnet-5", STEP_TOKENS)).toBe(STEP_COMPUTED);
    // cache_creation tính theo đơn giá riêng (1,25× input tại pin) — không
    // được gộp vào input thường: 0.0061 + 100×2.5e-6 = 0.00635000.
    expect(
      computeCostUsd("claude-sonnet-5", { ...STEP_TOKENS, cacheCreationInputTokens: 100 }),
    ).toBe("0.00635000");
    expect(() => computeCostUsd("model-khong-ton-tai", STEP_TOKENS)).toThrowError(
      PriceResolutionError,
    );
  });

  it("records one usage row per engine step and aggregates session totals", async () => {
    const engine = new FakeEngine([], {
      model: "claude-sonnet-5",
      billingType: "subscription_included",
      ...STEP_TOKENS,
      costUsdReported: null,
    });
    const outcome = await runWorkItemSession(db, {
      sessionId: "SES-U1",
      agentId: "AGENT-1",
      adapter: engine,
      contract: {
        workItemId: "WI-KC11-A",
        contractRevision: 1,
        sopRef: {},
        steps: ["phan-tich", "viet-code", "tu-kiem"],
      },
    });
    expect(outcome.kind).toBe("succeeded");

    const usageRows = (await db.execute(sql`
      SELECT seq, step, model, billing_type, input_tokens, cached_input_tokens,
             cache_creation_input_tokens, output_tokens, cost_usd_reported,
             cost_usd_computed, price_source
      FROM dopaios_session_usage WHERE session_id = 'SES-U1' ORDER BY seq
    `)) as unknown as Array<Record<string, unknown>>;
    expect(usageRows).toHaveLength(3);
    expect(usageRows[0]).toMatchObject({
      seq: 1,
      step: "phan-tich",
      model: "claude-sonnet-5",
      billing_type: "subscription_included",
      input_tokens: 1000,
      cached_input_tokens: 500,
      cache_creation_input_tokens: 0,
      output_tokens: 400,
      cost_usd_reported: null,
      cost_usd_computed: STEP_COMPUTED,
      price_source: PRICE_SOURCE,
    });

    const session = (await db.execute(sql`
      SELECT usage_input_tokens, usage_cached_input_tokens, usage_output_tokens,
             usage_cost_usd_reported, usage_cost_usd_computed, budget_state
      FROM dopaios_ai_sessions WHERE id = 'SES-U1'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(session[0]).toMatchObject({
      usage_input_tokens: 3000,
      usage_cached_input_tokens: 1500,
      usage_output_tokens: 1200,
      budget_state: null,
    });
    expect(Number(session[0]["usage_cost_usd_computed"])).toBeCloseTo(0.0183, 8);
    expect(Number(session[0]["usage_cost_usd_reported"])).toBe(0);
  });

  it("rejects usage on a non-RUNNING session and enforces append-only seq", async () => {
    await expect(
      recordSessionUsage(db, "U-NEG-1", {
        sessionId: "SES-U1",
        seq: 99,
        step: "sau-terminal",
        model: "claude-sonnet-5",
        billingType: "subscription_included",
        ...STEP_TOKENS,
        costUsdReported: null,
        costUsdComputed: STEP_COMPUTED,
        priceSource: PRICE_SOURCE,
      }),
    ).rejects.toMatchObject({ code: "ERR-SESSION-STATE" });

    // Phiên đang chạy: ghi seq 1 thủ công rồi ghi trùng — phải bị từ chối.
    const engine = new FakeEngine();
    await runWorkItemSession(db, {
      sessionId: "SES-U2",
      agentId: "AGENT-1",
      adapter: engine,
      contract: { workItemId: "WI-KC11-A", contractRevision: 1, sopRef: {}, steps: [] },
    });
    // SES-U2 đã terminal (0 bước) — dùng phiên khác còn RUNNING qua đường lệnh
    // trực tiếp: mở phiên thủ công không qua engine.
    const { startAiSession } = await import("../dopaios/sessions.ts");
    await startAiSession(db, "U-START-RAW", {
      sessionId: "SES-U3",
      workItemId: "WI-KC11-A",
      agentId: "AGENT-1",
      engine: "manual",
    });
    const payload = {
      sessionId: "SES-U3",
      seq: 1,
      step: "b1",
      model: "claude-sonnet-5",
      billingType: "subscription_included",
      ...STEP_TOKENS,
      costUsdReported: null,
      costUsdComputed: STEP_COMPUTED,
      priceSource: PRICE_SOURCE,
    };
    await recordSessionUsage(db, "U-DUP-1", payload);
    await expect(recordSessionUsage(db, "U-DUP-2", payload)).rejects.toMatchObject({
      code: "ERR-USAGE-IMMUTABLE",
    });
    await completeSession(db, "U-DONE-U3", { sessionId: "SES-U3", outcome: "abandoned" });
  });

  it("warns near the contract cost limit and hard-stops at the limit with a frozen overshoot", async () => {
    // reported 0.00650000/bước thắng computed; trần 0.015, warn 80% = 0.012:
    // bước 1: 0.0065 — dưới warn; bước 2: 0.0130 ≥ warn → cảnh báo;
    // bước 3: 0.0195 ≥ trần → dừng cứng, overshoot 0.0045; bước 4 không chạy.
    const engine = new FakeEngine([], {
      model: "claude-sonnet-5",
      billingType: "subscription_included",
      ...STEP_TOKENS,
      costUsdReported: "0.00650000",
    });
    const outcome = await runWorkItemSession(db, {
      sessionId: "SES-B1",
      agentId: "AGENT-1",
      adapter: engine,
      contract: {
        workItemId: "WI-KC11-B",
        contractRevision: 1,
        sopRef: {},
        steps: ["b1", "b2", "b3", "b4"],
      },
      budget: { costUsdLimit: 0.015 },
    });
    expect(outcome).toMatchObject({
      kind: "budget-stopped",
      afterStep: "b3",
      limitUsd: "0.01500000",
      observedUsd: "0.01950000",
      overshootUsd: "0.00450000",
    });

    const session = (await db.execute(sql`
      SELECT state, outcome, budget_state, usage_cost_usd_reported
      FROM dopaios_ai_sessions WHERE id = 'SES-B1'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(session[0]).toMatchObject({
      state: "TERMINAL",
      outcome: "budget_stopped",
      budget_state: "stopped",
    });
    expect(Number(session[0]["usage_cost_usd_reported"])).toBeCloseTo(0.0195, 8);

    const usageCount = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_session_usage WHERE session_id = 'SES-B1'
    `)) as unknown as Array<{ n: number }>;
    expect(usageCount[0].n).toBe(3);

    const events = await readStream(db, "dopaiosAiSession-SES-B1");
    const types = events.map((event) => event.type);
    expect(types).toContain("AiSessionBudgetWarned");
    expect(types).toContain("AiSessionBudgetStopped");
    const stopEvent = events.find((event) => event.type === "AiSessionBudgetStopped");
    expect(stopEvent?.data).toMatchObject({
      limitUsd: "0.01500000",
      observedUsd: "0.01950000",
      overshootUsd: "0.00450000",
    });
    const warnEvent = events.find((event) => event.type === "AiSessionBudgetWarned");
    expect(warnEvent?.data).toMatchObject({ observedUsd: "0.01300000" });
  });

  it("allows a retry successor after budget_stopped and totals the work-item chain without merging sessions", async () => {
    // Kế nhiệm retry sau khi người có thẩm quyền nới trần (mô phỏng bằng trần
    // cao hơn + priorChainCostUsd của phiên trước): resume từ checkpoint bước 3.
    const engine = new FakeEngine([], {
      model: "claude-sonnet-5",
      billingType: "subscription_included",
      ...STEP_TOKENS,
      costUsdReported: "0.00650000",
    });
    const outcome = await runWorkItemSession(db, {
      sessionId: "SES-B2",
      agentId: "AGENT-1",
      adapter: engine,
      contract: {
        workItemId: "WI-KC11-B",
        contractRevision: 2,
        sopRef: {},
        steps: ["b1", "b2", "b3", "b4"],
      },
      predecessor: { id: "SES-B1", relation: "retry" },
      resume: { nextStepIndex: 3 },
      budget: { costUsdLimit: 0.05, priorChainCostUsd: 0.0195 },
    });
    expect(outcome.kind).toBe("succeeded");

    const summary = await workItemCostSummary(db, "WI-KC11-B");
    expect(summary.totals.sessionCount).toBe(2);
    expect(summary.totals.completedSessionCount).toBe(1);
    expect(summary.sessions.map((s) => s.sessionId)).toEqual(["SES-B1", "SES-B2"]);
    expect(summary.sessions[0]).toMatchObject({
      outcome: "budget_stopped",
      countsAsCompleted: false,
      costUsdReported: "0.01950000",
    });
    expect(summary.sessions[1]).toMatchObject({
      relation: "retry",
      predecessorId: "SES-B1",
      outcome: "succeeded",
      countsAsCompleted: true,
      costUsdReported: "0.00650000",
    });
    // Tổng work-item = tổng MỌI phiên kể cả phiên bị dừng vì trần (chi phí đã
    // tiêu là thật); "hoàn thành" chỉ đếm phiên succeeded — không gộp (SM-C4).
    expect(summary.totals.costUsdReported).toBe("0.02600000");
    expect(summary.totals.inputTokens).toBe(4000);
  });

  it("replays usage and budget projections byte-identically from the event log", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
