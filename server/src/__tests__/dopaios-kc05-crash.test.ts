import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  CommandRejectedError,
} from "../dopaios/event-store.ts";
import { provisionWorkspace, activateWorkspace } from "../dopaios/workspace.ts";
import {
  initFixtureRepo,
  materializeWorkspace,
  listTree,
  type MaterializedWorkspace,
} from "../dopaios/workspace-fs.ts";
import { requestActivation, claimActivation, completeActivation } from "../dopaios/activation.ts";
import { FakeEngine, runWorkItemSession, latestConfirmedCheckpoint } from "../dopaios/engine.ts";
import { recordSessionArtifact, detectStalledSessions } from "../dopaios/sessions.ts";
import { requeueExpiredActivations } from "../dopaios/runner.ts";

// KC-05 B4: dừng ĐỘT NGỘT một worker thật (tiến trình con bị SIGKILL khi đang
// giữ claim và vừa ghi checkpoint đầu) rồi khởi động lại — tiêu chí: không
// mất claim, không hai tác nhân cùng ghi một work-item. Tái dùng nguyên khối
// watchdog KC-02 (detectStalledSessions), requeue theo epoch + fence
// ERR-LEASE-EPOCH của KC-13, phiên kế nhiệm resume từ checkpoint đã xác nhận.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-05 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RELEASE_ID = "RUN-REL-K";
const WORK_ITEM_ID = `WI-${RELEASE_ID}`;
const ACTIVATION_ID = `ACT-${RELEASE_ID}`;
const SESSION_E0 = `SES-${RELEASE_ID}-e0`;
const SESSION_E1 = `SES-${RELEASE_ID}-e1`;
const LEASE_MS = 3_000;
const STEPS = ["plan", "build", "test"];
const serverDir = fileURLToPath(new URL("../..", import.meta.url));

function waitForMarker(child: ChildProcess, marker: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(
      () => rejectPromise(new Error(`Chờ marker ${marker} quá ${timeoutMs}ms; stdout:\n${buffer}`)),
      timeoutMs,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        resolvePromise(buffer);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!buffer.includes(marker)) {
        rejectPromise(new Error(`Worker thoát (code ${code}) trước khi có marker ${marker}; output:\n${buffer}`));
      }
    });
  });
}

describeEmbeddedPostgres("dopaios KC-05 B4 — worker SIGKILL giữa chừng rồi khởi động lại", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let rootAbs!: string;
  let ws!: MaterializedWorkspace;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc05-b4-");
    db = createDb(tempDb.connectionString);
    rootAbs = await mkdtemp(join(tmpdir(), "kc05-b4-"));
    const repo = await initFixtureRepo(rootAbs);

    await executeCommand(db, {
      commandId: `KC05-SEED-${RELEASE_ID}`,
      payload: { runId: RELEASE_ID },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosSopRun-${RELEASE_ID}`,
          type: "TestRunRequested",
          data: {
            runId: RELEASE_ID,
            definitionRef: { id: "SOPDEF-KC05", revision: 1 },
            decider: "ORCH-KC05",
            pod: "POD-KC05",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosWorkItem-${WORK_ITEM_ID}`,
          type: "WorkItemCreated",
          data: { workItemId: WORK_ITEM_ID, runId: RELEASE_ID, state: "ACCEPTED" },
          expectedVersion: -1,
        });
        return { runId: RELEASE_ID };
      },
    });

    const provisioned = await provisionWorkspace(db, `KC05-B4-PROV-${RELEASE_ID}`, {
      workspaceId: `WS-${RELEASE_ID}`,
      releaseId: RELEASE_ID,
      portPool: [15901],
      baseRef: repo.headSha,
    });
    ws = await materializeWorkspace({
      rootAbs,
      repoPath: repo.repoPath,
      workspaceId: `WS-${RELEASE_ID}`,
      releaseId: RELEASE_ID,
      relPath: provisioned["relPath"] as string,
      cacheRelPath: provisioned["cacheRelPath"] as string,
      port: provisioned["port"] as number,
      credentialRef: provisioned["credentialRef"] as { id: string; sha256: string },
      baseRef: repo.headSha,
    });
    await activateWorkspace(db, `KC05-B4-ACT-${RELEASE_ID}`, {
      workspaceId: `WS-${RELEASE_ID}`,
      materialized: { worktreeHead: ws.worktreeHead, boundPort: ws.port },
    });
    await requestActivation(db, `KC05-B4-REQ-${RELEASE_ID}`, {
      activationId: ACTIVATION_ID,
      workItemId: WORK_ITEM_ID,
      agentId: "AI-STAFF-K",
      engine: "fake-acp-shape+workspace",
    });
  }, 120_000);

  afterAll(async () => {
    ws?.server.close();
    await tempDb?.cleanup();
    if (rootAbs) {
      await rm(rootAbs, { recursive: true, force: true });
    }
  });

  it("SIGKILL worker đang giữ claim: claim không mất, phiên và checkpoint còn nguyên", async () => {
    const child = spawn("pnpm", ["exec", "tsx", "src/dopaios/kc05-worker.ts"], {
      cwd: serverDir,
      env: {
        ...process.env,
        NODE_ENV: "test",
        KC05_DATABASE_URL: tempDb!.connectionString,
        KC05_ACTIVATION_ID: ACTIVATION_ID,
        KC05_WORK_ITEM_ID: WORK_ITEM_ID,
        KC05_RELEASE_ID: RELEASE_ID,
        KC05_AGENT_ID: "AI-STAFF-K",
        KC05_SESSION_ID: SESSION_E0,
        KC05_ROOT_ABS: rootAbs,
        KC05_LEASE_MS: String(LEASE_MS),
        KC05_SLOW_MS: "30000",
        KC05_EPOCH: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Chờ worker claim xong VÀ ghi checkpoint bước đầu, rồi giết cứng giữa
    // cửa sổ sleep — không cleanup, không thoát êm.
    await waitForMarker(child, "KC05-CKPT step=plan");
    child.kill("SIGKILL");
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));

    const activation = (await db.execute(
      sql`SELECT state, claimed_by, lease_epoch, (claim_lease_until IS NOT NULL) AS leased
          FROM dopaios_activations WHERE id = ${ACTIVATION_ID}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(activation).toEqual([
      { state: "RUNNING", claimed_by: "AI-STAFF-K", lease_epoch: 0, leased: true },
    ]);

    const session = (await db.execute(
      sql`SELECT state FROM dopaios_ai_sessions WHERE id = ${SESSION_E0}`,
    )) as unknown as Array<{ state: string }>;
    expect(session).toEqual([{ state: "RUNNING" }]);

    const checkpoints = (await db.execute(
      sql`SELECT seq, kind, confirmed FROM dopaios_session_artifacts WHERE session_id = ${SESSION_E0}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(checkpoints).toEqual([{ seq: 1, kind: "checkpoint", confirmed: true }]);

    const artifacts = (await listTree(ws.wsAbs)).filter((p) => p.startsWith("artifacts/"));
    expect(artifacts).toEqual([`artifacts/${SESSION_E0}/plan.ckpt.json`]);
  }, 120_000);

  it("watchdog + requeue theo epoch: phiên INTERRUPTED, activation về QUEUED epoch 1 — claim không mất mà được thu hồi có kiểm soát", async () => {
    const interrupted = await detectStalledSessions(db, {
      thresholdMs: 1,
      nowMs: Date.now() + 60_000,
    });
    expect(interrupted.map((s) => s.sessionId)).toContain(SESSION_E0);

    const actions = await requeueExpiredActivations(db, { nowMs: Date.now() + LEASE_MS + 60_000 });
    expect(actions).toEqual([
      { command: "requeue-activation", target: ACTIVATION_ID, outcome: "ok" },
    ]);
    const activation = (await db.execute(
      sql`SELECT state, claimed_by, lease_epoch FROM dopaios_activations WHERE id = ${ACTIVATION_ID}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(activation).toEqual([{ state: "QUEUED", claimed_by: null, lease_epoch: 1 }]);
  });

  it("khởi động lại: worker mới claim epoch 1, phiên kế nhiệm resume từ checkpoint; writer cũ bị fence — không hai tác nhân cùng ghi", async () => {
    await claimActivation(db, `KC05-B4-CLAIM-${ACTIVATION_ID}-e1`, {
      activationId: ACTIVATION_ID,
      claimedBy: "AI-STAFF-K",
      lease: { untilMs: Date.now() + 60_000 },
    });

    const resume = await latestConfirmedCheckpoint(db, SESSION_E0);
    expect(resume?.nextStepIndex).toBe(1);

    const { workspaceBoundEngine } = await import("../dopaios/workspace-fs.ts");
    const outcome = await runWorkItemSession(db, {
      sessionId: SESSION_E1,
      agentId: "AI-STAFF-K",
      adapter: workspaceBoundEngine(new FakeEngine(), { wsAbs: ws.wsAbs, cacheAbs: ws.cacheAbs }),
      contract: {
        workItemId: WORK_ITEM_ID,
        contractRevision: 1,
        sopRef: { id: "SOPDEF-KC05", revision: 1 },
        steps: STEPS,
      },
      predecessor: { id: SESSION_E0, relation: "retry" },
      resume: { nextStepIndex: resume!.nextStepIndex },
    });
    expect(outcome.kind).toBe("succeeded");

    // Writer cũ (epoch 0) ghi muộn: bị fence ERR-LEASE-EPOCH — đường "hai tác
    // nhân cùng ghi một work-item" không tồn tại ở trạng thái xác nhận.
    let staleCode = "NO-REJECTION";
    try {
      await completeActivation(db, `KC05-B4-STALE-DONE-${ACTIVATION_ID}`, {
        activationId: ACTIVATION_ID,
        outcome: "succeeded",
        leaseEpoch: 0,
      });
    } catch (error) {
      if (error instanceof CommandRejectedError) staleCode = error.code;
      else throw error;
    }
    expect(staleCode).toBe("ERR-LEASE-EPOCH");

    // Phiên cũ đã INTERRUPTED — checkpoint ghi muộn vào phiên cũ cũng bị chặn.
    let staleSessionCode = "NO-REJECTION";
    try {
      await recordSessionArtifact(db, `KC05-B4-STALE-CKPT-${SESSION_E0}`, {
        sessionId: SESSION_E0,
        seq: 99,
        kind: "checkpoint",
        ref: `ckpt/${SESSION_E0}/99`,
        sha256: "f".repeat(64),
        confirmed: true,
      });
    } catch (error) {
      if (error instanceof CommandRejectedError) staleSessionCode = error.code;
      else throw error;
    }
    expect(staleSessionCode).toBe("ERR-SESSION-STATE");

    // Claimer mới (epoch 1) hoàn tất — đúng MỘT kết quả thắng.
    const done = await completeActivation(db, `KC05-B4-DONE-${ACTIVATION_ID}-e1`, {
      activationId: ACTIVATION_ID,
      outcome: "succeeded",
      leaseEpoch: 1,
    });
    expect(done["state"]).toBe("DONE");

    // Chuỗi phiên nối predecessor; artifact tạm gồm plan của e0 + build/test
    // của e1 — đầu ra hợp lệ được giữ, chỉ phần dở dang làm lại (NFR-3).
    const sessions = (await db.execute(
      sql`SELECT id, state, predecessor_id, relation FROM dopaios_ai_sessions ORDER BY id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(sessions).toEqual([
      { id: SESSION_E0, state: "INTERRUPTED", predecessor_id: null, relation: null },
      { id: SESSION_E1, state: "TERMINAL", predecessor_id: SESSION_E0, relation: "retry" },
    ]);
    const artifacts = (await listTree(ws.wsAbs)).filter((p) => p.startsWith("artifacts/"));
    expect(artifacts.sort()).toEqual(
      [
        `artifacts/${SESSION_E0}/plan.ckpt.json`,
        `artifacts/${SESSION_E1}/build.ckpt.json`,
        `artifacts/${SESSION_E1}/test.ckpt.json`,
      ].sort(),
    );
    const e1Ckpt = JSON.parse(
      await readFile(join(ws.wsAbs, `artifacts/${SESSION_E1}/build.ckpt.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(e1Ckpt["sessionId"]).toBe(SESSION_E1);

    const activation = (await db.execute(
      sql`SELECT state, lease_epoch FROM dopaios_activations WHERE id = ${ACTIVATION_ID}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(activation).toEqual([{ state: "DONE", lease_epoch: 1 }]);
  }, 120_000);

  it("replay dựng lại đúng trạng thái sau chuỗi crash–requeue–restart (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
