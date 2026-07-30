import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
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
import { AUTH_CIRCUIT_TRIP_THRESHOLD } from "../services/adapter-auth-circuit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres auth circuit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("adapter auth circuit breaker (Dopaios, issue #9539)", () => {
  let stopDatabase: (() => Promise<void>) | null = null;
  let db: ReturnType<typeof createDb>;

  const setupDb = (async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-auth-circuit-");
    stopDatabase = started.stop;
    db = createDb(started.connectionString);
  })();

  afterEach(() => {
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await stopDatabase?.();
  });

  async function seedAgentFixture(opts?: { circuitOpen?: boolean }) {
    await setupDb;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

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
      name: "ClaudeWorker",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    if (opts?.circuitOpen) {
      const now = new Date().toISOString();
      await db.insert(agentRuntimeState).values({
        agentId,
        companyId,
        adapterType: "claude_local",
        stateJson: {
          authCircuit: {
            consecutiveFailures: AUTH_CIRCUIT_TRIP_THRESHOLD,
            firstFailureAt: now,
            trippedAt: now,
            lastErrorCode: "claude_auth_required",
            lastRunId: randomUUID(),
          },
        },
      });
    }

    return { companyId, agentId };
  }

  it("skips automatic wakeups while the auth circuit is open — no retry storm", async () => {
    const { agentId } = await seedAgentFixture({ circuitOpen: true });
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system" });
    const second = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "system" });
    expect(first).toBeNull();
    expect(second).toBeNull();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
    for (const wakeup of wakeups) {
      expect(wakeup.status).toBe("skipped");
      expect(wakeup.reason).toBe("adapter.auth_circuit_open");
    }

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("lets a user-initiated wake pass the open circuit (manual resume path)", async () => {
    const { agentId } = await seedAgentFixture({ circuitOpen: true });
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
    });
    expect(run).not.toBeNull();
  });

  it("does not skip wakeups when the circuit is closed", async () => {
    const { agentId } = await seedAgentFixture();
    const heartbeat = heartbeatService(db);

    const run = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system" });
    expect(run).not.toBeNull();

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.every((wakeup) => wakeup.reason !== "adapter.auth_circuit_open")).toBe(true);
  });
});
