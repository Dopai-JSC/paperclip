import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  provisionWorkspace,
  activateWorkspace,
  beginWorkspaceClose,
  recordWorkspacePurge,
  abortWorkspace,
  accessWorkspaceCredential,
  closeWorkspacesForTerminalReleases,
} from "../dopaios/workspace.ts";
import {
  initFixtureRepo,
  materializeWorkspace,
  purgeReleaseScopeOnDisk,
  writeScoped,
  hashTree,
  type MaterializedWorkspace,
} from "../dopaios/workspace-fs.ts";
import { requestActivation, claimActivation, completeActivation } from "../dopaios/activation.ts";
import { startAiSession, completeSession, recordSessionArtifact } from "../dopaios/sessions.ts";
import { requeueExpiredActivations } from "../dopaios/runner.ts";

// KC-05 B7: ca kiểm cho các finding của vòng review đối kháng 2 lens —
// blocker "purge khi writer còn sống / hai phiên RUNNING một work-item",
// major "ngõ cụt PROVISIONED", "residue branch/.git", "credential actor tự
// khai", "run terminal ↔ workspace", "symlink", "port còn bận", "hồ sơ thất
// bại FR-17 từng trường", cùng vòng đời corrective action.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-05 B7 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO-REJECTION";
  } catch (error) {
    if (error instanceof CommandRejectedError) return error.code;
    throw error;
  }
}

function closeServer(ws: MaterializedWorkspace): Promise<void> {
  return new Promise((resolvePromise) => ws.server.close(() => resolvePromise()));
}

describeEmbeddedPostgres("dopaios KC-05 B7 — xử finding review đối kháng", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let rootAbs!: string;
  let repoPath!: string;
  let baseSha!: string;
  const openServers: MaterializedWorkspace[] = [];

  async function seedRelease(runId: string, withWorkItem = true): Promise<void> {
    await executeCommand(db, {
      commandId: `KC05-B7-SEED-${runId}`,
      payload: { runId },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosSopRun-${runId}`,
          type: "TestRunRequested",
          data: {
            runId,
            definitionRef: { id: "SOPDEF-KC05", revision: 1 },
            decider: "ORCH-KC05",
            pod: "POD-KC05",
          },
          expectedVersion: -1,
        });
        if (withWorkItem) {
          await ctx.emit({
            streamName: `dopaiosWorkItem-WI-${runId}`,
            type: "WorkItemCreated",
            data: { workItemId: `WI-${runId}`, runId, state: "ACCEPTED" },
            expectedVersion: -1,
          });
        }
        return { runId };
      },
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc05-b7-");
    db = createDb(tempDb.connectionString);
    rootAbs = await mkdtemp(join(tmpdir(), "kc05-b7-"));
    const repo = await initFixtureRepo(rootAbs);
    repoPath = repo.repoPath;
    baseSha = repo.headSha;
  }, 120_000);

  afterAll(async () => {
    for (const ws of openServers) {
      ws.server.close();
    }
    await tempDb?.cleanup();
    if (rootAbs) {
      await rm(rootAbs, { recursive: true, force: true });
    }
  });

  it("purge bị chặn khi còn phiên hoặc claim sống trên Release (ERR-WS-SESSIONS-OPEN); đóng phiên xong mới purge được", async () => {
    await seedRelease("RUN-RF-A");
    await provisionWorkspace(db, "KC05-B7-PROV-A", {
      workspaceId: "WS-RF-A",
      releaseId: "RUN-RF-A",
      portPool: [15931],
      baseRef: "kc05-base",
    });
    await activateWorkspace(db, "KC05-B7-ACT-A", {
      workspaceId: "WS-RF-A",
      materialized: { worktreeHead: "a".repeat(40), boundPort: 15931 },
    });
    await startAiSession(db, "KC05-B7-SES-A", {
      sessionId: "SES-RF-A",
      workItemId: "WI-RUN-RF-A",
      agentId: "AI-RF-A",
      engine: "fake",
    });
    await beginWorkspaceClose(db, "KC05-B7-CLOSE-A", { workspaceId: "WS-RF-A", reason: "test" });

    const emptyReport = { actor: "runner", purgedScope: [], checksums: {}, residue: [] };
    expect(
      await rejectionCode(
        recordWorkspacePurge(db, "KC05-B7-PURGE-A1", {
          workspaceId: "WS-RF-A",
          outcome: "purged",
          report: emptyReport,
        }),
      ),
    ).toBe("ERR-WS-SESSIONS-OPEN");

    await completeSession(db, "KC05-B7-SES-A-DONE", { sessionId: "SES-RF-A", outcome: "succeeded" });

    // Claim sống (activation RUNNING) cũng chặn purge — writer tiềm năng.
    await requestActivation(db, "KC05-B7-REQ-A", {
      activationId: "ACT-RF-A",
      workItemId: "WI-RUN-RF-A",
      agentId: "AI-RF-A",
      engine: "fake",
    });
    await claimActivation(db, "KC05-B7-CLAIM-A", { activationId: "ACT-RF-A", claimedBy: "AI-RF-A" });
    expect(
      await rejectionCode(
        recordWorkspacePurge(db, "KC05-B7-PURGE-A2", {
          workspaceId: "WS-RF-A",
          outcome: "purged",
          report: emptyReport,
        }),
      ),
    ).toBe("ERR-WS-SESSIONS-OPEN");

    await completeActivation(db, "KC05-B7-DONE-A", { activationId: "ACT-RF-A", outcome: "succeeded" });
    const purged = await recordWorkspacePurge(db, "KC05-B7-PURGE-A3", {
      workspaceId: "WS-RF-A",
      outcome: "purged",
      report: emptyReport,
    });
    expect(purged["state"]).toBe("PURGED");
  });

  it("requeue tự interrupt phiên của claimer cũ TRONG CÙNG transaction; ghi muộn bị chặn; một work-item một phiên RUNNING", async () => {
    await seedRelease("RUN-RF-B");
    await requestActivation(db, "KC05-B7-REQ-B", {
      activationId: "ACT-RF-B",
      workItemId: "WI-RUN-RF-B",
      agentId: "AI-RF-B",
      engine: "fake",
    });
    const nowMs = Date.now();
    await claimActivation(db, "KC05-B7-CLAIM-B", {
      activationId: "ACT-RF-B",
      claimedBy: "AI-RF-B",
      lease: { untilMs: nowMs + 1_000 },
    });
    await startAiSession(db, "KC05-B7-SES-B0", {
      sessionId: "SES-RF-B0",
      workItemId: "WI-RUN-RF-B",
      agentId: "AI-RF-B",
      engine: "fake",
    });

    // Guard mới: phiên thứ hai trên cùng work-item khi phiên đầu còn RUNNING.
    expect(
      await rejectionCode(
        startAiSession(db, "KC05-B7-SES-B1-EARLY", {
          sessionId: "SES-RF-B1",
          workItemId: "WI-RUN-RF-B",
          agentId: "AI-RF-B2",
          engine: "fake",
        }),
      ),
    ).toBe("ERR-SESSION-CONFLICT");

    // Requeue KHÔNG cần watchdog chạy trước: chính requeue interrupt phiên.
    const actions = await requeueExpiredActivations(db, { nowMs: nowMs + 120_000 });
    expect(actions).toEqual([{ command: "requeue-activation", target: "ACT-RF-B", outcome: "ok" }]);
    const session = (await db.execute(
      sql`SELECT state FROM dopaios_ai_sessions WHERE id = 'SES-RF-B0'`,
    )) as unknown as Array<{ state: string }>;
    expect(session).toEqual([{ state: "INTERRUPTED" }]);

    // Ghi muộn của claimer cũ vào phiên đã interrupt: chặn ở tầng phiên.
    expect(
      await rejectionCode(
        recordSessionArtifact(db, "KC05-B7-STALE-B0", {
          sessionId: "SES-RF-B0",
          seq: 9,
          kind: "checkpoint",
          ref: "ckpt/SES-RF-B0/9",
          sha256: "b".repeat(64),
          confirmed: true,
        }),
      ),
    ).toBe("ERR-SESSION-STATE");

    // Phiên mới giờ mở sạch — không còn RUNNING nào trên work-item.
    const started = await startAiSession(db, "KC05-B7-SES-B1", {
      sessionId: "SES-RF-B1",
      workItemId: "WI-RUN-RF-B",
      agentId: "AI-RF-B2",
      engine: "fake",
    });
    expect(started["state"]).toBe("RUNNING");
    await completeSession(db, "KC05-B7-SES-B1-DONE", { sessionId: "SES-RF-B1", outcome: "succeeded" });
  });

  it("abort thoát ngõ cụt PROVISIONED; materialize idempotent dọn branch/worktree mồ côi; head đối chiếu baseRef", async () => {
    await seedRelease("RUN-RF-C", false);
    const first = await provisionWorkspace(db, "KC05-B7-PROV-C1", {
      workspaceId: "WS-RF-C1",
      releaseId: "RUN-RF-C",
      portPool: [15932],
      baseRef: baseSha,
    });
    // Vật chất hóa lần 1 rồi "crash" trước activate: branch ws/RUN-RF-C +
    // worktree + port bind là rác của lần chết.
    const c1 = await materializeWorkspace({
      rootAbs,
      repoPath,
      workspaceId: "WS-RF-C1",
      releaseId: "RUN-RF-C",
      relPath: first["relPath"] as string,
      cacheRelPath: first["cacheRelPath"] as string,
      port: first["port"] as number,
      credentialRef: first["credentialRef"] as { id: string; sha256: string },
      baseRef: baseSha,
    });
    await closeServer(c1); // tiến trình chết → OS nhả port

    const aborted = await abortWorkspace(db, "KC05-B7-ABORT-C1", {
      workspaceId: "WS-RF-C1",
      reason: "materialize-crash",
      actor: "dopaios-runner",
    });
    expect(aborted).toMatchObject({ state: "PURGED", aborted: true });

    // Cấp lại được cho cùng Release, tái dùng đúng tài nguyên đã trả.
    const second = await provisionWorkspace(db, "KC05-B7-PROV-C2", {
      workspaceId: "WS-RF-C2",
      releaseId: "RUN-RF-C",
      portPool: [15932],
      baseRef: baseSha,
    });
    expect(second["port"]).toBe(15932);
    // Vật chất hóa lần 2 phải SỐNG qua rác lần 1 (branch đã tồn tại từng làm
    // `git worktree add -b` nổ — finding lens 1).
    const c2 = await materializeWorkspace({
      rootAbs,
      repoPath,
      workspaceId: "WS-RF-C2",
      releaseId: "RUN-RF-C",
      relPath: second["relPath"] as string,
      cacheRelPath: second["cacheRelPath"] as string,
      port: second["port"] as number,
      credentialRef: second["credentialRef"] as { id: string; sha256: string },
      baseRef: baseSha,
    });
    openServers.push(c2);
    expect(c2.worktreeHead).toBe(baseSha);

    // baseRef dạng sha: head bịa bị chặn, head thật đi qua.
    expect(
      await rejectionCode(
        activateWorkspace(db, "KC05-B7-ACT-C2-FAKE", {
          workspaceId: "WS-RF-C2",
          materialized: { worktreeHead: "f".repeat(40), boundPort: 15932 },
        }),
      ),
    ).toBe("ERR-WS-HEAD-MISMATCH");
    const activated = await activateWorkspace(db, "KC05-B7-ACT-C2", {
      workspaceId: "WS-RF-C2",
      materialized: { worktreeHead: c2.worktreeHead, boundPort: 15932 },
    });
    expect(activated["state"]).toBe("ACTIVE");
  }, 120_000);

  it("run terminal: không cấp credential mới; tick tự bắt đầu chuỗi đóng ADR-012 (idempotent)", async () => {
    await seedRelease("RUN-RF-D");
    await provisionWorkspace(db, "KC05-B7-PROV-D", {
      workspaceId: "WS-RF-D",
      releaseId: "RUN-RF-D",
      portPool: [15933],
      baseRef: "kc05-base",
    });
    await activateWorkspace(db, "KC05-B7-ACT-D", {
      workspaceId: "WS-RF-D",
      materialized: { worktreeHead: "d".repeat(40), boundPort: 15933 },
    });
    await requestActivation(db, "KC05-B7-REQ-D", {
      activationId: "ACT-RF-D",
      workItemId: "WI-RUN-RF-D",
      agentId: "AI-RF-D",
      engine: "fake",
    });
    await claimActivation(db, "KC05-B7-CLAIM-D", { activationId: "ACT-RF-D", claimedBy: "AI-RF-D" });

    await executeCommand(db, {
      commandId: "KC05-B7-DONE-RUN-D",
      payload: { runId: "RUN-RF-D" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosSopRun-RUN-RF-D",
          type: "SopRunStateChanged",
          data: { runId: "RUN-RF-D", state: "COMPLETED" },
        });
        return { runId: "RUN-RF-D" };
      },
    });

    // Release kết thúc: kể cả claimer thật cũng không được cấp credential mới.
    expect(
      await rejectionCode(
        accessWorkspaceCredential(db, "KC05-B7-CRED-D", {
          workspaceId: "WS-RF-D",
          forReleaseId: "RUN-RF-D",
          actor: "AI-RF-D",
        }),
      ),
    ).toBe("ERR-WS-RELEASE-TERMINAL");

    // Rule tick: run terminal + workspace ACTIVE → tự beginWorkspaceClose.
    const closed = await closeWorkspacesForTerminalReleases(db);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ workspaceId: "WS-RF-D", state: "CLOSING" });
    const again = await closeWorkspacesForTerminalReleases(db);
    expect(again).toEqual([]);
  });

  it("credential actor khai gian bị chặn kèm vệt audit; purge đĩa fail-closed khi Release còn ACTIVE; port còn bận thành residue; corrective action đóng khi retry đạt", async () => {
    // RUN-RF-C đang ACTIVE với workspace WS-RF-C2 (ca abort ở trên) — dùng
    // luôn làm nạn nhân. Actor không giữ claim RUNNING nào trên RUN-RF-C.
    expect(
      await rejectionCode(
        accessWorkspaceCredential(db, "KC05-B7-CRED-GIAN", {
          workspaceId: "WS-RF-C2",
          forReleaseId: "RUN-RF-C",
          actor: "AI-KE-GIAN",
        }),
      ),
    ).toBe("ERR-WS-CRED-ACTOR");
    const audit = (await db.execute(
      sql`SELECT data ->> 'code' AS code FROM message_store.messages
          WHERE stream_name = 'dopaiosAudit-KC05-B7-CRED-GIAN'`,
    )) as unknown as Array<{ code: string }>;
    expect(audit).toEqual([{ code: "ERR-WS-CRED-ACTOR" }]);

    // Fail-closed tại tầng đĩa: Release ACTIVE thì purge đĩa TỪ CHỐI trước
    // khi đụng bất kỳ byte nào (finding lens 2 — gọi nhầm releaseId).
    const wsPath = join(rootAbs, "releases", "RUN-RF-C", "ws");
    expect(existsSync(wsPath)).toBe(true);
    expect(
      await rejectionCode(
        purgeReleaseScopeOnDisk({
          db,
          rootAbs,
          repoPath,
          releaseId: "RUN-RF-C",
          actor: "dopaios-runner",
        }),
      ),
    ).toBe("ERR-WS-STATE");
    expect(existsSync(wsPath)).toBe(true);

    // Đóng nhưng KHÔNG nhả port: probe biến "port còn bận" thành residue —
    // sổ không released một port mà OS còn phục vụ (finding lens 2).
    await beginWorkspaceClose(db, "KC05-B7-CLOSE-C", { workspaceId: "WS-RF-C2", reason: "test-port" });
    const stillBound = await purgeReleaseScopeOnDisk({
      db,
      rootAbs,
      repoPath,
      releaseId: "RUN-RF-C",
      actor: "dopaios-runner",
    });
    expect(stillBound.report.residue).toContain("releases/RUN-RF-C/#port-still-bound");
    const blocked = await recordWorkspacePurge(db, "KC05-B7-PURGE-C-FAIL", {
      workspaceId: "WS-RF-C2",
      outcome: "failed",
      failure: {
        reason: "port-still-bound",
        leftoverScope: ["releases/RUN-RF-C/#port-still-bound"],
        correctiveAction: {
          owner: "dopaios-operator",
          dueMs: 60_000,
          scope: ["releases/RUN-RF-C/#port-still-bound"],
          state: "open",
        },
      },
    });
    expect(blocked["state"]).toBe("PURGE_BLOCKED");

    // Nhả port rồi retry: sạch → PURGED, corrective action ĐÓNG trên projection.
    const c2 = openServers.find((ws) => ws.workspaceId === "WS-RF-C2")!;
    await closeServer(c2);
    const retry = await purgeReleaseScopeOnDisk({
      db,
      rootAbs,
      repoPath,
      releaseId: "RUN-RF-C",
      actor: "dopaios-runner",
    });
    expect(retry.error).toBeUndefined();
    expect(retry.report.residue).toEqual([]);
    const purged = await recordWorkspacePurge(db, "KC05-B7-PURGE-C-RETRY", {
      workspaceId: "WS-RF-C2",
      outcome: "purged",
      report: retry.report,
    });
    expect(purged["state"]).toBe("PURGED");
    const row = (await db.execute(
      sql`SELECT state, purge_failure ->> 'correctiveActionState' AS ca_state
          FROM dopaios_workspaces WHERE id = 'WS-RF-C2'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(row).toEqual([{ state: "PURGED", ca_state: "closed" }]);
  }, 120_000);

  it("hồ sơ thất bại purge: từng trường FR-17 bị guard riêng", async () => {
    await seedRelease("RUN-RF-F", false);
    await provisionWorkspace(db, "KC05-B7-PROV-F", {
      workspaceId: "WS-RF-F",
      releaseId: "RUN-RF-F",
      portPool: [15935],
      baseRef: "kc05-base",
    });
    await activateWorkspace(db, "KC05-B7-ACT-F", {
      workspaceId: "WS-RF-F",
      materialized: { worktreeHead: "e".repeat(40), boundPort: 15935 },
    });
    await beginWorkspaceClose(db, "KC05-B7-CLOSE-F", { workspaceId: "WS-RF-F", reason: "test" });

    const base = {
      reason: "efs-error",
      leftoverScope: ["releases/RUN-RF-F/cache"],
      correctiveAction: {
        owner: "dopaios-operator",
        dueMs: 60_000,
        scope: ["releases/RUN-RF-F/cache"],
        state: "open" as const,
      },
    };
    const variants: Array<[string, Record<string, unknown>]> = [
      ["thiếu owner", { ...base, correctiveAction: { ...base.correctiveAction, owner: "" } }],
      ["hạn không dương", { ...base, correctiveAction: { ...base.correctiveAction, dueMs: 0 } }],
      ["scope khắc phục rỗng", { ...base, correctiveAction: { ...base.correctiveAction, scope: [] } }],
      [
        "scope khắc phục ngoài prefix",
        { ...base, correctiveAction: { ...base.correctiveAction, scope: ["releases/RUN-KHAC/x"] } },
      ],
      ["state khác open", { ...base, correctiveAction: { ...base.correctiveAction, state: "closed" } }],
      ["leftoverScope rỗng", { ...base, leftoverScope: [] }],
      ["leftoverScope ngoài prefix", { ...base, leftoverScope: ["releases/RUN-KHAC/ws"] }],
    ];
    for (const [label, failure] of variants) {
      expect(
        await rejectionCode(
          recordWorkspacePurge(db, `KC05-B7-FAIL-F-${label}`, {
            workspaceId: "WS-RF-F",
            outcome: "failed",
            failure: failure as never,
          }),
        ),
        label,
      ).toBe("ERR-WS-PURGE-FAILURE");
    }
    const ok = await recordWorkspacePurge(db, "KC05-B7-FAIL-F-OK", {
      workspaceId: "WS-RF-F",
      outcome: "failed",
      failure: base,
    });
    expect(ok["state"]).toBe("PURGE_BLOCKED");
  });

  it("symlink: ghi qua symlink thoát scope bị chặn ở tầng fs; inventory thấy symlink", async () => {
    const scopeAbs = join(rootAbs, "symlink-case", "releases", "RUN-RF-S", "ws");
    const victimAbs = join(rootAbs, "symlink-victim");
    await mkdir(scopeAbs, { recursive: true });
    await mkdir(victimAbs, { recursive: true });
    await symlink(victimAbs, join(scopeAbs, "link"), "dir");

    expect(
      await rejectionCode(
        (async () => writeScoped(scopeAbs, "link/x.txt", "byte lọt ra ngoài"))(),
      ),
    ).toBe("ERR-WS-PATH-ESCAPE");
    expect(existsSync(join(victimAbs, "x.txt"))).toBe(false);

    const tree = await hashTree(scopeAbs);
    expect(Object.keys(tree)).toContain("link");
    expect(String(tree["link"]).startsWith("symlink:")).toBe(true);
  });

  it("replay dựng lại đúng trạng thái sau trọn chuỗi B7 (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
