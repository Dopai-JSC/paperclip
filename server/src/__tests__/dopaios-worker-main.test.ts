import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand } from "../dopaios/core/event-store.ts";
import {
  activateSopRun,
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "../dopaios/core/commands.ts";
import { requestActivation } from "../dopaios/core/activation.ts";
import { requeueExpiredActivations } from "../dopaios/core/runner.ts";
import { FakeEngine, type EngineAdapter } from "../dopaios/core/engine.ts";
import { interruptSession } from "../dopaios/core/sessions.ts";
import {
  provisionWorkspace,
  activateWorkspace,
  beginWorkspaceClose,
} from "../dopaios/core/workspace.ts";
import { initFixtureRepo, materializeWorkspace } from "../dopaios/core/workspace-fs.ts";
import {
  workerTick,
  type WorkerEngineRegistry,
  type WorkerMainConfig,
} from "../dopaios/core/worker-main.ts";

// I-10 — worker-main: entry tiến trình worker production trên máy trạm.
// Contract test theo năng lực: (1) claim đúng việc của mình + chạy trọn
// phiên qua tầng lệnh, tick lặp không tác dụng kép; (2) không claim việc của
// Staff khác; (3) engine ngoài registry = fail-closed không claim; (4) dừng
// khẩn cấp thi hành tại ranh bước (fence) và phục hồi kế nhiệm sau requeue;
// (5) quan sát command cho máy: purge workspace đã đóng kèm bằng chứng.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios worker-main tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const AGENT = "STAFF-WKR-1";
const STEPS = ["plan", "build", "submit"];
const LEASE_MS = 60_000;

function baseConfig(overrides?: Partial<WorkerMainConfig>): WorkerMainConfig {
  return {
    agentId: AGENT,
    engines: { fake: () => new FakeEngine() },
    leaseMs: LEASE_MS,
    fallbackSteps: STEPS,
    ...overrides,
  };
}

describeEmbeddedPostgres("dopaios worker-main — tiến trình worker production", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function seedWorkItem(tag: string): Promise<{ runId: string; workItemId: string }> {
    const runId = `RUN-${tag}`;
    const workItemId = `WI-${tag}`;
    await requestTestRun(db, `T-SEED-RUN-${tag}`, {
      runId,
      definitionRef: { definitionId: "DEF-WKR", revision: 1 },
      decider: "DECIDER-1",
      pod: "POD-1",
      fixturePackage: {},
    });
    await activateSopRun(db, `T-SEED-ACT-${tag}`, { runId, workItemId });
    return { runId, workItemId };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-worker-main-");
    db = createDb(tempDb.connectionString);
    const sha = "a".repeat(64);
    await registerApprovedArtifact(db, "T-SEED-ART", { artifactId: "SOP-WKR", revision: 1, sha256: sha });
    await createSopDefinition(db, "T-SEED-DEF", {
      definitionId: "DEF-WKR",
      revision: 1,
      sopPin: { artifactId: "SOP-WKR", revision: 1, sha256: sha },
    });
    await publishSopDefinition(db, "T-SEED-PUB", {
      definitionId: "DEF-WKR",
      definitionContentSha256: sha,
      expectedSopSha256: sha,
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("claim việc của mình, chạy trọn phiên, nộp và hoàn tất; tick lặp không tác dụng kép", async () => {
    const { workItemId } = await seedWorkItem("W1");
    await requestActivation(db, "T-REQ-W1", {
      activationId: "ACT-W1",
      workItemId,
      agentId: AGENT,
      engine: "fake",
    });

    const report = await workerTick(db, baseConfig(), { nowMs: 1_000 });
    expect(report.claimed).toMatchObject({
      activationId: "ACT-W1",
      sessionId: "SES-ACT-W1-e0",
      outcome: "succeeded",
    });

    const activation = (await db.execute(
      sql`SELECT state, claimed_by FROM dopaios_activations WHERE id = 'ACT-W1'`,
    )) as unknown as Array<{ state: string; claimed_by: string }>;
    expect(activation[0]).toMatchObject({ state: "DONE", claimed_by: AGENT });

    const artifacts = (await db.execute(
      sql`SELECT kind, confirmed FROM dopaios_session_artifacts
          WHERE session_id = 'SES-ACT-W1-e0' ORDER BY seq`,
    )) as unknown as Array<{ kind: string; confirmed: boolean }>;
    expect(artifacts.filter((a) => a.kind === "checkpoint")).toHaveLength(STEPS.length);
    expect(artifacts.at(-1)).toMatchObject({ kind: "output", confirmed: true });

    // Tick lặp: không còn việc QUEUED — không claim lại, không phiên thứ hai.
    const second = await workerTick(db, baseConfig(), { nowMs: 2_000 });
    expect(second.claimed).toBeNull();
    const sessions = (await db.execute(
      sql`SELECT id FROM dopaios_ai_sessions WHERE work_item_id = ${workItemId}`,
    )) as unknown as Array<{ id: string }>;
    expect(sessions).toHaveLength(1);
  }, 60_000);

  it("không claim việc đã định tuyến cho Staff khác", async () => {
    const { workItemId } = await seedWorkItem("W2");
    await requestActivation(db, "T-REQ-W2", {
      activationId: "ACT-W2",
      workItemId,
      agentId: "STAFF-KHAC",
      engine: "fake",
    });

    const report = await workerTick(db, baseConfig(), { nowMs: 3_000 });
    expect(report.claimed).toBeNull();
    const activation = (await db.execute(
      sql`SELECT state FROM dopaios_activations WHERE id = 'ACT-W2'`,
    )) as unknown as Array<{ state: string }>;
    expect(activation[0]?.state).toBe("QUEUED");
  }, 60_000);

  it("engine ngoài registry của máy: fail-closed — không claim, không gọi engine", async () => {
    const { workItemId } = await seedWorkItem("W3");
    await requestActivation(db, "T-REQ-W3", {
      activationId: "ACT-W3",
      workItemId,
      agentId: AGENT,
      engine: "engine-la",
    });

    const report = await workerTick(db, baseConfig(), { nowMs: 4_000 });
    expect(report.claimed).toMatchObject({ activationId: "ACT-W3", outcome: "skipped" });
    const activation = (await db.execute(
      sql`SELECT state FROM dopaios_activations WHERE id = 'ACT-W3'`,
    )) as unknown as Array<{ state: string }>;
    expect(activation[0]?.state).toBe("QUEUED");
    // Dọn để không chặn các tick sau của cùng agent (ORDER BY id LIMIT 1).
    await db.execute(sql`DELETE FROM dopaios_activations WHERE id = 'ACT-W3'`);
  }, 60_000);

  it("dừng khẩn cấp thi hành tại ranh bước; sau requeue, kế nhiệm resume từ checkpoint", async () => {
    const { workItemId } = await seedWorkItem("W4");
    await requestActivation(db, "T-REQ-W4", {
      activationId: "ACT-W4",
      workItemId,
      agentId: AGENT,
      engine: "fake",
    });

    // Engine bị "dừng khẩn cấp" từ ngoài (giả lập watchdog/lệnh dừng) ngay
    // sau checkpoint đầu tiên — fence phải chặn TRƯỚC khi ghi checkpoint kế.
    const interrupting: WorkerEngineRegistry = {
      fake: () => {
        const base = new FakeEngine();
        let stopped = false;
        const adapter: EngineAdapter = {
          name: base.name,
          async execute(input) {
            return base.execute({
              ...input,
              onCheckpoint: async (payload) => {
                await input.onCheckpoint(payload);
                if (!stopped) {
                  stopped = true;
                  await interruptSession(db, `T-INT-${input.sessionId}`, {
                    sessionId: input.sessionId,
                    detectedAtMs: 5_000,
                    reason: "emergency-stop-drill",
                  });
                }
              },
            });
          },
        };
        return adapter;
      },
    };

    const first = await workerTick(db, baseConfig({ engines: interrupting }), { nowMs: 5_000 });
    expect(first.machineCommands).toContainEqual(
      expect.objectContaining({ kind: "fence-stop", sessionId: "SES-ACT-W4-e0" }),
    );
    expect(first.claimed).toMatchObject({ activationId: "ACT-W4", outcome: "skipped" });

    const stopped = (await db.execute(
      sql`SELECT state FROM dopaios_ai_sessions WHERE id = 'SES-ACT-W4-e0'`,
    )) as unknown as Array<{ state: string }>;
    expect(stopped[0]?.state).toBe("INTERRUPTED");
    const outputs = (await db.execute(
      sql`SELECT kind FROM dopaios_session_artifacts
          WHERE session_id = 'SES-ACT-W4-e0' AND kind = 'output'`,
    )) as unknown as Array<{ kind: string }>;
    expect(outputs).toHaveLength(0);

    // Lease hết hạn → requeue cấp epoch mới (việc của tick phía server).
    const requeued = await requeueExpiredActivations(db, { nowMs: 5_000 + LEASE_MS + 1 });
    expect(requeued.some((a) => a.outcome === "ok")).toBe(true);

    // Tick kế: worker claim epoch 1, mở phiên KẾ NHIỆM và resume từ
    // checkpoint đã xác nhận — không chạy lại bước 1.
    const second = await workerTick(db, baseConfig(), { nowMs: 6_000 + LEASE_MS });
    expect(second.claimed).toMatchObject({
      activationId: "ACT-W4",
      sessionId: "SES-ACT-W4-e1",
      outcome: "succeeded",
    });
    const successor = (await db.execute(
      sql`SELECT predecessor_id, relation FROM dopaios_ai_sessions WHERE id = 'SES-ACT-W4-e1'`,
    )) as unknown as Array<{ predecessor_id: string | null; relation: string | null }>;
    expect(successor[0]).toMatchObject({ predecessor_id: "SES-ACT-W4-e0", relation: "retry" });
    const checkpoints = (await db.execute(
      sql`SELECT ref FROM dopaios_session_artifacts
          WHERE session_id = 'SES-ACT-W4-e1' AND kind = 'checkpoint' ORDER BY seq`,
    )) as unknown as Array<{ ref: string }>;
    // Resume từ nextStepIndex=1: chỉ còn các bước sau checkpoint đã xác nhận.
    expect(checkpoints).toHaveLength(STEPS.length - 1);
    expect(checkpoints[0]?.ref).toBe("ckpt/SES-ACT-W4-e1/1");
    const activation = (await db.execute(
      sql`SELECT state FROM dopaios_activations WHERE id = 'ACT-W4'`,
    )) as unknown as Array<{ state: string }>;
    expect(activation[0]?.state).toBe("DONE");
  }, 120_000);

  it("quan sát command cho máy: purge workspace đã đóng kèm bằng chứng", async () => {
    const releaseId = "RUN-WS-PURGE";
    await executeCommand(db, {
      commandId: `T-SEED-${releaseId}`,
      payload: { runId: releaseId },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosSopRun-${releaseId}`,
          type: "TestRunRequested",
          data: {
            runId: releaseId,
            definitionRef: { id: "DEF-WKR", revision: 1 },
            decider: "DECIDER-1",
            pod: "POD-1",
          },
          expectedVersion: -1,
        });
        return { runId: releaseId };
      },
    });

    const rootAbs = await mkdtemp(join(tmpdir(), "worker-main-purge-"));
    const repo = await initFixtureRepo(rootAbs);
    const provisioned = await provisionWorkspace(db, `T-PROV-${releaseId}`, {
      workspaceId: `WS-${releaseId}`,
      releaseId,
      portPool: [15931, 15932],
      baseRef: repo.headSha,
    });
    const ws = await materializeWorkspace({
      rootAbs,
      repoPath: repo.repoPath,
      workspaceId: `WS-${releaseId}`,
      releaseId,
      relPath: provisioned["relPath"] as string,
      cacheRelPath: provisioned["cacheRelPath"] as string,
      port: provisioned["port"] as number,
      credentialRef: provisioned["credentialRef"] as { id: string; sha256: string },
      baseRef: repo.headSha,
    });
    await ws.server.close();
    await activateWorkspace(db, `T-ACT-${releaseId}`, {
      workspaceId: `WS-${releaseId}`,
      materialized: { worktreeHead: ws.worktreeHead, boundPort: provisioned["port"] as number },
    });
    await beginWorkspaceClose(db, `T-CLOSE-${releaseId}`, {
      workspaceId: `WS-${releaseId}`,
      reason: "release đóng — test worker-main",
    });
    expect(existsSync(join(rootAbs, "releases", releaseId))).toBe(true);

    const report = await workerTick(
      db,
      baseConfig({ rootAbs, repoPath: repo.repoPath }),
      { nowMs: 7_000 },
    );
    expect(report.machineCommands).toContainEqual(
      expect.objectContaining({
        kind: "workspace-purge",
        workspaceId: `WS-${releaseId}`,
        outcome: "purged",
      }),
    );

    const workspace = (await db.execute(
      sql`SELECT state, purge_report FROM dopaios_workspaces WHERE id = ${`WS-${releaseId}`}`,
    )) as unknown as Array<{ state: string; purge_report: Record<string, unknown> | null }>;
    expect(workspace[0]?.state).toBe("PURGED");
    expect(workspace[0]?.purge_report).toMatchObject({ actor: AGENT, residue: [] });
    expect(existsSync(join(rootAbs, "releases", releaseId))).toBe(false);
  }, 120_000);
});
