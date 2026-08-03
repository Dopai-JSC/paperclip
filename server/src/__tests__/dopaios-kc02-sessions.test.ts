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
import { activateSopRun, registerActor, registerApprovedArtifact, createSopDefinition, publishSopDefinition, requestTestRun } from "../dopaios/commands.ts";
import {
  completeSession,
  createSuccessorSession,
  detectStalledSessions,
  interruptSession,
  recordSessionArtifact,
  recordSessionSignal,
  startAiSession,
} from "../dopaios/sessions.ts";

// KC-02 B2: record Phiên chạy AI trên event store KC-01 — bất biến PRD Mục 3.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-02 session tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dopaios KC-02 AI session records", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc02-");
    db = createDb(tempDb.connectionString);
    // Nền tối thiểu: một work-item ACCEPTED trên một run test (tái dùng chuỗi KC-01).
    const sha = "a".repeat(64);
    await registerApprovedArtifact(db, "S-SEED-ART", { artifactId: "SOP-X", revision: 1, sha256: sha });
    await createSopDefinition(db, "S-SEED-DEF", {
      definitionId: "DEF-X",
      revision: 1,
      sopPin: { artifactId: "SOP-X", revision: 1, sha256: sha },
    });
    await publishSopDefinition(db, "S-SEED-PUB", {
      definitionId: "DEF-X",
      definitionContentSha256: sha,
      expectedSopSha256: sha,
    });
    await requestTestRun(db, "S-SEED-RUN", {
      runId: "RUN-KC02",
      definitionRef: { definitionId: "DEF-X", revision: 1 },
      decider: "DECIDER-1",
      pod: "POD-1",
      fixturePackage: {},
    });
    await activateSopRun(db, "S-SEED-ACT", { runId: "RUN-KC02", workItemId: "WI-KC02" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("starts a session bound to a work item and records activity signals", async () => {
    const started = await startAiSession(db, "S-01", {
      sessionId: "SES-A",
      workItemId: "WI-KC02",
      agentId: "AGENT-1",
      engine: "fake",
    });
    expect(started).toMatchObject({ state: "RUNNING" });
    await recordSessionSignal(db, "S-02", { sessionId: "SES-A" });
    const rows = (await db.execute(
      sql`SELECT state, last_signal_at FROM dopaios_ai_sessions WHERE id = 'SES-A'`,
    )) as unknown as Array<{ state: string; last_signal_at: Date }>;
    expect(rows[0]?.state).toBe("RUNNING");
    expect(rows[0]?.last_signal_at).toBeTruthy();

    await expect(
      startAiSession(db, "S-03", {
        sessionId: "SES-GHOST",
        workItemId: "WI-KHONG-TON-TAI",
        agentId: "AGENT-1",
        engine: "fake",
      }),
    ).rejects.toMatchObject({ code: "ERR-WORKITEM" });
  });

  it("confirmed artifacts are append-only and immutable", async () => {
    await recordSessionArtifact(db, "S-04", {
      sessionId: "SES-A",
      seq: 1,
      kind: "checkpoint",
      ref: "ckpt/1",
      sha256: "b".repeat(64),
      confirmed: true,
    });
    await expect(
      recordSessionArtifact(db, "S-05", {
        sessionId: "SES-A",
        seq: 1,
        kind: "checkpoint",
        ref: "ckpt/1-overwrite",
        sha256: "c".repeat(64),
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "ERR-ARTIFACT-IMMUTABLE" });
  });

  it("watchdog detects silence beyond the threshold and freezes the NFR-8 latency into the event", async () => {
    const rows = (await db.execute(
      sql`SELECT last_signal_at FROM dopaios_ai_sessions WHERE id = 'SES-A'`,
    )) as unknown as Array<{ last_signal_at: Date }>;
    const lastSignalMs = new Date(rows[0].last_signal_at).getTime();

    // Đồng hồ watchdog mới quá hạn 1 phút: chưa được phép ngắt.
    const early = await detectStalledSessions(db, {
      thresholdMs: FIVE_MINUTES_MS,
      nowMs: lastSignalMs + 60_000,
    });
    expect(early).toEqual([]);

    // Im lặng 6 phút (giả lập bằng đồng hồ watchdog): ngắt, trễ phát hiện ≈ 6 phút.
    const detected = await detectStalledSessions(db, {
      thresholdMs: FIVE_MINUTES_MS,
      nowMs: lastSignalMs + 6 * 60_000,
    });
    expect(detected).toHaveLength(1);
    expect(detected[0].sessionId).toBe("SES-A");
    expect(detected[0].detectionLatencyMs).toBe(6 * 60_000);

    // Tick lặp lại với cùng trạng thái không bắn lần hai (command id dẫn xuất).
    const repeat = await detectStalledSessions(db, {
      thresholdMs: FIVE_MINUTES_MS,
      nowMs: lastSignalMs + 7 * 60_000,
    });
    expect(repeat).toEqual([]);

    const state = (await db.execute(
      sql`SELECT state, detection_latency_ms FROM dopaios_ai_sessions WHERE id = 'SES-A'`,
    )) as unknown as Array<{ state: string; detection_latency_ms: number }>;
    expect(state[0]).toEqual({ state: "INTERRUPTED", detection_latency_ms: 6 * 60_000 });
  });

  it("retry then reassign create linked successors; histories stay on separate streams", async () => {
    await createSuccessorSession(db, "S-06", {
      sessionId: "SES-B",
      predecessorId: "SES-A",
      relation: "retry",
      agentId: "AGENT-1",
      engine: "fake",
    });
    await recordSessionSignal(db, "S-07", { sessionId: "SES-B" });
    await interruptSession(db, "S-08", {
      sessionId: "SES-B",
      detectedAtMs: Date.now() + 1,
      reason: "forced",
    });
    await createSuccessorSession(db, "S-09", {
      sessionId: "SES-C",
      predecessorId: "SES-B",
      relation: "reassign",
      agentId: "AGENT-2",
      engine: "fake",
    });
    await completeSession(db, "S-10", { sessionId: "SES-C", outcome: "succeeded" });

    const chain = (await db.execute(sql`
      SELECT id, predecessor_id, relation, state, agent_id FROM dopaios_ai_sessions ORDER BY id
    `)) as unknown as Array<Record<string, string | null>>;
    expect(chain).toEqual([
      { id: "SES-A", predecessor_id: null, relation: null, state: "INTERRUPTED", agent_id: "AGENT-1" },
      { id: "SES-B", predecessor_id: "SES-A", relation: "retry", state: "INTERRUPTED", agent_id: "AGENT-1" },
      { id: "SES-C", predecessor_id: "SES-B", relation: "reassign", state: "TERMINAL", agent_id: "AGENT-2" },
    ]);

    // Lịch sử không gộp: mỗi stream chỉ chứa event của chính phiên đó.
    for (const sessionId of ["SES-A", "SES-B", "SES-C"]) {
      const events = await readStream(db, `dopaiosAiSession-${sessionId}`);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.data["sessionId"]).toBe(sessionId);
      }
    }
  });

  it("guards: no successor from RUNNING or succeeded-terminal; reassign must change agent; terminal never reopens", async () => {
    await startAiSession(db, "S-11", {
      sessionId: "SES-D",
      workItemId: "WI-KC02",
      agentId: "AGENT-3",
      engine: "fake",
    });
    await expect(
      createSuccessorSession(db, "S-12", {
        sessionId: "SES-E",
        predecessorId: "SES-D",
        relation: "retry",
        agentId: "AGENT-3",
        engine: "fake",
      }),
    ).rejects.toMatchObject({ code: "ERR-PREDECESSOR-RUNNING" });

    await expect(
      createSuccessorSession(db, "S-13", {
        sessionId: "SES-F",
        predecessorId: "SES-C",
        relation: "retry",
        agentId: "AGENT-2",
        engine: "fake",
      }),
    ).rejects.toMatchObject({ code: "ERR-TERMINAL-REOPEN" });

    await expect(
      createSuccessorSession(db, "S-14", {
        sessionId: "SES-G",
        predecessorId: "SES-B",
        relation: "reassign",
        agentId: "AGENT-1",
        engine: "fake",
      }),
    ).rejects.toMatchObject({ code: "ERR-REASSIGN-SAME-AGENT" });

    await expect(
      recordSessionSignal(db, "S-15", { sessionId: "SES-C" }),
    ).rejects.toMatchObject({ code: "ERR-SESSION-STATE" });
    await expect(
      interruptSession(db, "S-16", { sessionId: "SES-C", detectedAtMs: Date.now(), reason: "x" }),
    ).rejects.toMatchObject({ code: "ERR-SESSION-STATE" });
    await expect(
      completeSession(db, "S-17", { sessionId: "SES-C", outcome: "failed" }),
    ).rejects.toMatchObject({ code: "ERR-SESSION-TERMINAL" });
  });

  it("blocks and audits the next active-session action after Staff revocation", async () => {
    await registerActor(db, "S-KC09-REGISTER-ACTOR", {
      actorId: "AGENT-KC09-REVOKE",
      kind: "ai",
      active: true,
      capabilities: ["work-item-executor"],
    });
    await db.execute(sql`
      INSERT INTO dopaios_work_items (id, state, executor, project_id)
      VALUES ('WI-KC09-REVOKE', 'ACCEPTED', 'AGENT-KC09-REVOKE', 'PROJECT-KC09')
    `);
    await startAiSession(db, "S-KC09-START", {
      sessionId: "SES-KC09-REVOKE",
      workItemId: "WI-KC09-REVOKE",
      agentId: "AGENT-KC09-REVOKE",
      engine: "fake",
    });
    await db.execute(sql`
      UPDATE dopaios_actors SET active = false WHERE id = 'AGENT-KC09-REVOKE'
    `);

    try {
      await expect(
        recordSessionSignal(db, "S-KC09-AFTER-REVOKE", { sessionId: "SES-KC09-REVOKE" }),
      ).rejects.toMatchObject({ code: "ERR-AUTH-REVOKED" });
      const audit = await readStream(db, "dopaiosAudit-S-KC09-AFTER-REVOKE");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        type: "CommandRejected",
        data: { commandId: "S-KC09-AFTER-REVOKE", code: "ERR-AUTH-REVOKED" },
      });
      await expect(
        recordSessionArtifact(db, "S-KC09-ARTIFACT-AFTER-REVOKE", {
          sessionId: "SES-KC09-REVOKE",
          seq: 1,
          kind: "checkpoint",
          ref: "ckpt/revoked",
          sha256: "9".repeat(64),
          confirmed: true,
        }),
      ).rejects.toMatchObject({ code: "ERR-AUTH-REVOKED" });
      const artifactAudit = await readStream(db, "dopaiosAudit-S-KC09-ARTIFACT-AFTER-REVOKE");
      expect(artifactAudit).toHaveLength(1);
      expect(artifactAudit[0]).toMatchObject({
        type: "CommandRejected",
        data: { commandId: "S-KC09-ARTIFACT-AFTER-REVOKE", code: "ERR-AUTH-REVOKED" },
      });
    } finally {
      await db.execute(sql`
        UPDATE dopaios_actors SET active = true WHERE id = 'AGENT-KC09-REVOKE'
      `);
      await db.execute(sql`DELETE FROM dopaios_work_items WHERE id = 'WI-KC09-REVOKE'`);
    }
  });

  it("blocks and audits a new session for an already revoked Staff actor", async () => {
    await registerActor(db, "S-KC09-REGISTER-REVOKED", {
      actorId: "AGENT-KC09-ALREADY-REVOKED",
      kind: "ai",
      active: false,
      capabilities: ["work-item-executor"],
    });
    await db.execute(sql`
      INSERT INTO dopaios_work_items (id, state, executor, project_id)
      VALUES ('WI-KC09-ALREADY-REVOKED', 'ACCEPTED', 'AGENT-KC09-ALREADY-REVOKED', 'PROJECT-KC09')
    `);

    try {
      await expect(
        startAiSession(db, "S-KC09-START-REVOKED", {
          sessionId: "SES-KC09-ALREADY-REVOKED",
          workItemId: "WI-KC09-ALREADY-REVOKED",
          agentId: "AGENT-KC09-ALREADY-REVOKED",
          engine: "fake",
        }),
      ).rejects.toMatchObject({ code: "ERR-AUTH-REVOKED" });
      const audit = await readStream(db, "dopaiosAudit-S-KC09-START-REVOKED");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        type: "CommandRejected",
        data: { commandId: "S-KC09-START-REVOKED", code: "ERR-AUTH-REVOKED" },
      });
    } finally {
      await db.execute(sql`DELETE FROM dopaios_work_items WHERE id = 'WI-KC09-ALREADY-REVOKED'`);
    }
  });

  it("replay rebuilds session chains and artifacts byte-identically", async () => {
    const before = await snapshotProjections(db);
    expect(before["dopaios_ai_sessions"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_session_artifacts"]!.length).toBeGreaterThan(0);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
