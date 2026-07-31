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
import { detectStalledSessions } from "../dopaios/sessions.ts";
import {
  FakeEngine,
  latestConfirmedCheckpoint,
  runWorkItemSession,
  type ExecutionContract,
} from "../dopaios/engine.ts";

// KC-02 B3: cùng một work-item dưới Hợp đồng thực hiện AI chạy qua adapter
// hình ACP với FakeEngine — trọn chuỗi gián đoạn → thử lại → giao lại,
// không cần token thật.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-02 engine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dopaios KC-02 engine harness (FakeEngine)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  const contract: ExecutionContract = {
    workItemId: "WI-ENG-01",
    contractRevision: 1,
    sopRef: { definitionId: "DEF-ENG", revision: 1 },
    steps: ["plan", "build", "selfcheck", "submit"],
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc02-eng-");
    db = createDb(tempDb.connectionString);
    const sha = "d".repeat(64);
    await registerApprovedArtifact(db, "E-SEED-ART", { artifactId: "SOP-ENG", revision: 1, sha256: sha });
    await createSopDefinition(db, "E-SEED-DEF", {
      definitionId: "DEF-ENG",
      revision: 1,
      sopPin: { artifactId: "SOP-ENG", revision: 1, sha256: sha },
    });
    await publishSopDefinition(db, "E-SEED-PUB", {
      definitionId: "DEF-ENG",
      definitionContentSha256: sha,
      expectedSopSha256: sha,
    });
    await requestTestRun(db, "E-SEED-RUN", {
      runId: "RUN-ENG",
      definitionRef: { definitionId: "DEF-ENG", revision: 1 },
      decider: "DECIDER-1",
      pod: "POD-1",
      fixturePackage: {},
    });
    await activateSopRun(db, "E-SEED-ACT", { runId: "RUN-ENG", workItemId: "WI-ENG-01" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("interrupted → retry (resume from checkpoint) → interrupted → reassign → succeeded, without losing confirmed artifacts", async () => {
    // Engine chết sau "build" (phiên 1) rồi sau "selfcheck" (phiên 2 - retry).
    const engine = new FakeEngine(["build", "selfcheck"]);

    // Phiên 1: chết cứng sau bước build — phiên Ở NGUYÊN RUNNING.
    const run1 = await runWorkItemSession(db, {
      sessionId: "ENG-A",
      agentId: "AGENT-1",
      adapter: engine,
      contract,
    });
    expect(run1).toEqual({ kind: "process-lost", sessionId: "ENG-A", afterStep: "build" });
    let rows = (await db.execute(
      sql`SELECT state FROM dopaios_ai_sessions WHERE id = 'ENG-A'`,
    )) as unknown as Array<{ state: string }>;
    expect(rows[0]?.state).toBe("RUNNING");

    // Watchdog phát hiện im lặng (đồng hồ giả lập +6 phút) → INTERRUPTED.
    const lastSignal = (await db.execute(
      sql`SELECT last_signal_at FROM dopaios_ai_sessions WHERE id = 'ENG-A'`,
    )) as unknown as Array<{ last_signal_at: Date }>;
    const detected = await detectStalledSessions(db, {
      thresholdMs: FIVE_MINUTES_MS,
      nowMs: new Date(lastSignal[0].last_signal_at).getTime() + 6 * 60_000,
    });
    expect(detected.map((d) => d.sessionId)).toEqual(["ENG-A"]);

    // Thử lại: successor cùng agent, resume từ checkpoint xác nhận cuối.
    const resumeA = await latestConfirmedCheckpoint(db, "ENG-A");
    expect(resumeA).toMatchObject({ nextStepIndex: 2 });
    const run2 = await runWorkItemSession(db, {
      sessionId: "ENG-B",
      agentId: "AGENT-1",
      adapter: engine,
      contract,
      predecessor: { id: "ENG-A", relation: "retry" },
      resume: { nextStepIndex: resumeA!.nextStepIndex },
    });
    expect(run2).toEqual({ kind: "process-lost", sessionId: "ENG-B", afterStep: "selfcheck" });

    const lastSignalB = (await db.execute(
      sql`SELECT last_signal_at FROM dopaios_ai_sessions WHERE id = 'ENG-B'`,
    )) as unknown as Array<{ last_signal_at: Date }>;
    await detectStalledSessions(db, {
      thresholdMs: FIVE_MINUTES_MS,
      nowMs: new Date(lastSignalB[0].last_signal_at).getTime() + 6 * 60_000,
    });

    // Giao lại: agent khác, resume từ checkpoint của phiên 2.
    const resumeB = await latestConfirmedCheckpoint(db, "ENG-B");
    expect(resumeB).toMatchObject({ nextStepIndex: 3 });
    const run3 = await runWorkItemSession(db, {
      sessionId: "ENG-C",
      agentId: "AGENT-2",
      adapter: engine,
      contract,
      predecessor: { id: "ENG-B", relation: "reassign" },
      resume: { nextStepIndex: resumeB!.nextStepIndex },
    });
    expect(run3).toEqual({ kind: "succeeded", sessionId: "ENG-C" });

    // Chuỗi phiên đúng quan hệ; không phiên nào bị gộp lịch sử.
    const chain = (await db.execute(sql`
      SELECT id, predecessor_id, relation, state, agent_id, detection_latency_ms
      FROM dopaios_ai_sessions WHERE id LIKE 'ENG-%' ORDER BY id
    `)) as unknown as Array<Record<string, unknown>>;
    expect(chain).toEqual([
      { id: "ENG-A", predecessor_id: null, relation: null, state: "INTERRUPTED", agent_id: "AGENT-1", detection_latency_ms: 6 * 60_000 },
      { id: "ENG-B", predecessor_id: "ENG-A", relation: "retry", state: "INTERRUPTED", agent_id: "AGENT-1", detection_latency_ms: 6 * 60_000 },
      { id: "ENG-C", predecessor_id: "ENG-B", relation: "reassign", state: "TERMINAL", agent_id: "AGENT-2", detection_latency_ms: null },
    ]);

    // Checkpoint đã xác nhận của các phiên trước còn nguyên (không mất khi retry/giao lại).
    const artifacts = (await db.execute(sql`
      SELECT session_id, count(*)::int AS n FROM dopaios_session_artifacts
      WHERE session_id LIKE 'ENG-%' GROUP BY session_id ORDER BY session_id
    `)) as unknown as Array<{ session_id: string; n: number }>;
    expect(artifacts).toEqual([
      { session_id: "ENG-A", n: 2 }, // plan, build
      { session_id: "ENG-B", n: 1 }, // selfcheck
      { session_id: "ENG-C", n: 2 }, // submit + output
    ]);
    const output = (await db.execute(sql`
      SELECT kind, confirmed FROM dopaios_session_artifacts
      WHERE session_id = 'ENG-C' AND kind = 'output'
    `)) as unknown as Array<{ kind: string; confirmed: boolean }>;
    expect(output).toEqual([{ kind: "output", confirmed: true }]);
  });

  it("a clean run succeeds in one session with per-step signals", async () => {
    const run = await runWorkItemSession(db, {
      sessionId: "ENG-CLEAN",
      agentId: "AGENT-3",
      adapter: new FakeEngine(),
      contract,
    });
    expect(run).toEqual({ kind: "succeeded", sessionId: "ENG-CLEAN" });
    const rows = (await db.execute(sql`
      SELECT state, outcome FROM dopaios_ai_sessions WHERE id = 'ENG-CLEAN'
    `)) as unknown as Array<{ state: string; outcome: string }>;
    expect(rows[0]).toEqual({ state: "TERMINAL", outcome: "succeeded" });
  });

  it("replay rebuilds the whole engine-harness history byte-identically", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
