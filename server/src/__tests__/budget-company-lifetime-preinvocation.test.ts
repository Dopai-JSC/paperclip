import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "ok",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { budgetService } from "../services/budgets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget pre-invocation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Dopaios Bước nền: a company-scope, lifetime-window, hard-stop budget policy must
// block a simulated over-limit invocation BEFORE the model adapter is called.
describeEmbeddedPostgres("company lifetime budget hard-stop pre-invocation", () => {
  let stopDatabase: (() => Promise<void>) | null = null;
  let db: ReturnType<typeof createDb>;

  const setupDb = (async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-budget-lifetime-");
    stopDatabase = started.stop;
    db = createDb(started.connectionString);
  })();

  afterEach(() => {
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await stopDatabase?.();
  });

  async function seedFixture() {
    await setupDb;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    // budgetMonthlyCents stays 0 so no auto-created monthly company policy can
    // shadow the lifetime policy (the invocation-block query does not filter on
    // windowKind and has no orderBy).
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SpikeWorker",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    return { companyId, agentId };
  }

  async function seedOverLimitSpend(companyId: string, agentId: string) {
    // Direct insert (not through costService) — no real spend, no side effects.
    // The 2020 date proves the LIFETIME window is what counts the spend: a
    // calendar-month policy would ignore an out-of-month event entirely.
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "synthetic",
      costCents: 5000,
      occurredAt: new Date("2020-01-01T00:00:00Z"),
    });
  }

  it("blocks an over-limit wakeup before the model adapter is ever called", async () => {
    const { companyId, agentId } = await seedFixture();
    await seedOverLimitSpend(companyId, agentId);
    const heartbeat = heartbeatService(db);

    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block).toMatchObject({
      scopeType: "company",
      scopeId: companyId,
      reason: "Company cannot start new work because its budget hard-stop is exceeded.",
    });

    await expect(
      heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "system" }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Company cannot start new work because its budget hard-stop is exceeded.",
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({ status: "skipped", reason: "budget.blocked" });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("negative control: the same wakeup passes once the cap is above observed spend", async () => {
    const { companyId, agentId } = await seedFixture();
    await seedOverLimitSpend(companyId, agentId);
    await db
      .update(budgetPolicies)
      .set({ amount: 10000 })
      .where(eq(budgetPolicies.companyId, companyId));

    const block = await budgetService(db).getInvocationBlock(companyId, agentId);
    expect(block).toBeNull();

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "system" });
    expect(run).not.toBeNull();
  });
});
