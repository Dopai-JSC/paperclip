import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import {
  activateSopRun,
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "../dopaios/commands.ts";
import { FakeEngine, type EngineAdapter, type EngineRunInput, type EngineRunResult, type ExecutionContract } from "../dopaios/engine.ts";
import {
  AuthError,
  BreakerOpenError,
  claimActivation,
  requestActivation,
  resetAuthBreaker,
  runActivation,
  withAuthBreaker,
} from "../dopaios/activation.ts";

// KC-02 B5: entry kích hoạt kiểu KC-13 (SFR-011 idempotent, DEV-010 claim
// compare-and-set) + circuit-breaker chuỗi lỗi auth — điều kiện gác trước V-01.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-02 activation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

class AlwaysAuthFailEngine implements EngineAdapter {
  readonly name = "authfail";
  calls = 0;
  async execute(_input: EngineRunInput): Promise<EngineRunResult> {
    this.calls += 1;
    throw new AuthError();
  }
}

describeEmbeddedPostgres("dopaios KC-02 activation entry + auth breaker", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const contract: ExecutionContract = {
    workItemId: "WI-ACT-01",
    contractRevision: 1,
    sopRef: { definitionId: "DEF-ACT", revision: 1 },
    steps: ["plan", "submit"],
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc02-act-");
    db = createDb(tempDb.connectionString);
    const sha = "e".repeat(64);
    await registerApprovedArtifact(db, "A-SEED-ART", { artifactId: "SOP-ACT", revision: 1, sha256: sha });
    await createSopDefinition(db, "A-SEED-DEF", {
      definitionId: "DEF-ACT",
      revision: 1,
      sopPin: { artifactId: "SOP-ACT", revision: 1, sha256: sha },
    });
    await publishSopDefinition(db, "A-SEED-PUB", {
      definitionId: "DEF-ACT",
      definitionContentSha256: sha,
      expectedSopSha256: sha,
    });
    await requestTestRun(db, "A-SEED-RUN", {
      runId: "RUN-ACT",
      definitionRef: { definitionId: "DEF-ACT", revision: 1 },
      decider: "DECIDER-1",
      pod: "POD-1",
      fixturePackage: {},
    });
    await activateSopRun(db, "A-SEED-ACT", { runId: "RUN-ACT", workItemId: "WI-ACT-01" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("queued activation is claimed exactly once under concurrency, then runs to DONE", async () => {
    await requestActivation(db, "ACT-01", {
      activationId: "ACT-A",
      workItemId: "WI-ACT-01",
      agentId: "AGENT-1",
      engine: "fake",
    });

    // Yêu cầu lặp cùng command id → replay, không tạo activation thứ hai.
    const replay = await requestActivation(db, "ACT-01", {
      activationId: "ACT-A",
      workItemId: "WI-ACT-01",
      agentId: "AGENT-1",
      engine: "fake",
    });
    expect(replay).toMatchObject({ idempotentReplay: true });

    // Hai claimer song song: đúng một bên thắng (DEV-010).
    const [first, second] = await Promise.allSettled([
      claimActivation(db, "ACT-CLAIM-P1", { activationId: "ACT-A", claimedBy: "P1" }),
      claimActivation(db, "ACT-CLAIM-P2", { activationId: "ACT-A", claimedBy: "P2" }),
    ]);
    const outcomes = [first, second].map((r) => r.status);
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((s) => s === "rejected")).toHaveLength(1);

    const rows = (await db.execute(
      sql`SELECT state, claimed_by FROM dopaios_activations WHERE id = 'ACT-A'`,
    )) as unknown as Array<{ state: string; claimed_by: string }>;
    expect(rows[0]?.state).toBe("RUNNING");
    expect(["P1", "P2"]).toContain(rows[0]?.claimed_by);
  });

  it("the full activation path drives a session end-to-end", async () => {
    await requestActivation(db, "ACT-02", {
      activationId: "ACT-B",
      workItemId: "WI-ACT-01",
      agentId: "AGENT-1",
      engine: "fake",
    });
    const outcome = await runActivation(db, {
      activationId: "ACT-B",
      claimedBy: "runner-1",
      sessionId: "SES-ACT-B",
      agentId: "AGENT-1",
      adapter: new FakeEngine(),
      contract,
    });
    expect(outcome).toEqual({ kind: "succeeded", sessionId: "SES-ACT-B" });
    const rows = (await db.execute(
      sql`SELECT state, outcome FROM dopaios_activations WHERE id = 'ACT-B'`,
    )) as unknown as Array<{ state: string; outcome: string }>;
    expect(rows[0]).toEqual({ state: "DONE", outcome: "succeeded" });
  });

  it("auth breaker hard-stops after the threshold without calling the engine, until an operator resets it", async () => {
    const failing = new AlwaysAuthFailEngine();
    const guarded = withAuthBreaker(db, failing);
    const input: EngineRunInput = {
      sessionId: "SES-BRK",
      contract,
      onSignal: async () => {},
      onCheckpoint: async () => {},
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(guarded.execute(input)).rejects.toBeInstanceOf(AuthError);
    }
    expect(failing.calls).toBe(3);

    // Ngưỡng chạm — breaker OPEN: lần 4 bị chặn cứng, engine KHÔNG được gọi.
    await expect(guarded.execute(input)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(failing.calls).toBe(3);

    const state = (await db.execute(
      sql`SELECT state, consecutive_failures FROM dopaios_auth_breakers WHERE id = 'authfail:WI-ACT-01'`,
    )) as unknown as Array<{ state: string; consecutive_failures: number }>;
    expect(state[0]).toEqual({ state: "OPEN", consecutive_failures: 3 });

    // Người vận hành reset → engine gọi được lại (và vẫn fail auth như cũ).
    await resetAuthBreaker(db, "BRK-RESET-1", { breakerId: "authfail:WI-ACT-01" });
    await expect(guarded.execute(input)).rejects.toBeInstanceOf(AuthError);
    expect(failing.calls).toBe(4);
  });

  it("replay rebuilds activations and breaker state byte-identically", async () => {
    const before = await snapshotProjections(db);
    expect(before["dopaios_activations"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_auth_breakers"]!.length).toBeGreaterThan(0);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
