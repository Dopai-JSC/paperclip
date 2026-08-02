import { mkdtemp, rm } from "node:fs/promises";
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
  requireActiveWorkspace,
  accessWorkspaceCredential,
} from "../dopaios/workspace.ts";
import {
  initFixtureRepo,
  materializeWorkspace,
  workspaceBoundEngine,
  purgeReleaseScopeOnDisk,
  hashTree,
  listTree,
  bindPort,
  type MaterializedWorkspace,
} from "../dopaios/workspace-fs.ts";
import { FakeEngine, runWorkItemSession } from "../dopaios/engine.ts";

// KC-05 B5: "sau khi đóng, dữ liệu tạm được purge đúng phạm vi" theo thứ tự
// ADR-012 — chặn task mới → đóng → xóa đúng prefix Release → post-check
// residue rỗng → event kết quả kèm phạm vi + checksum. Nhánh lỗi: purge fail
// → PURGE_BLOCKED, tài nguyên giữ nguyên, việc đóng KHÔNG hoàn tất (FR-17);
// retry có giới hạn đưa về PURGED. Dữ liệu ĐÃ XÁC NHẬN (event log, phiên,
// checkpoint trong DB) không bị đụng — purge chỉ chạm dữ liệu tạm trên đĩa.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-05 B5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RELEASES = ["RUN-REL-Q1", "RUN-REL-Q2"] as const;
const PORT_POOL = [15911, 15912];
const STEPS = ["plan", "build"];

describeEmbeddedPostgres("dopaios KC-05 B5 — đóng và purge đúng phạm vi", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let rootAbs!: string;
  let repoPath!: string;
  const materialized: Record<string, MaterializedWorkspace> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc05-b5-");
    db = createDb(tempDb.connectionString);
    rootAbs = await mkdtemp(join(tmpdir(), "kc05-b5-"));
    const repo = await initFixtureRepo(rootAbs);
    repoPath = repo.repoPath;

    for (const releaseId of RELEASES) {
      await executeCommand(db, {
        commandId: `KC05-SEED-${releaseId}`,
        payload: { runId: releaseId },
        handler: async (ctx) => {
          await ctx.emit({
            streamName: `dopaiosSopRun-${releaseId}`,
            type: "TestRunRequested",
            data: {
              runId: releaseId,
              definitionRef: { id: "SOPDEF-KC05", revision: 1 },
              decider: "ORCH-KC05",
              pod: "POD-KC05",
            },
            expectedVersion: -1,
          });
          await ctx.emit({
            streamName: `dopaiosWorkItem-WI-${releaseId}`,
            type: "WorkItemCreated",
            data: { workItemId: `WI-${releaseId}`, runId: releaseId, state: "ACCEPTED" },
            expectedVersion: -1,
          });
          return { runId: releaseId };
        },
      });
      const provisioned = await provisionWorkspace(db, `KC05-B5-PROV-${releaseId}`, {
        workspaceId: `WS-${releaseId}`,
        releaseId,
        portPool: PORT_POOL,
        baseRef: repo.headSha,
      });
      const ws = await materializeWorkspace({
        rootAbs,
        repoPath,
        workspaceId: `WS-${releaseId}`,
        releaseId,
        relPath: provisioned["relPath"] as string,
        cacheRelPath: provisioned["cacheRelPath"] as string,
        port: provisioned["port"] as number,
        credentialRef: provisioned["credentialRef"] as { id: string; sha256: string },
        baseRef: repo.headSha,
      });
      materialized[releaseId] = ws;
      await activateWorkspace(db, `KC05-B5-ACT-${releaseId}`, {
        workspaceId: `WS-${releaseId}`,
        materialized: { worktreeHead: ws.worktreeHead, boundPort: ws.port },
      });
      // Sinh dữ liệu tạm thật: một phiên FakeEngine ghi checkpoint + cache.
      const outcome = await runWorkItemSession(db, {
        sessionId: `SES-${releaseId}`,
        agentId: `AI-STAFF-${releaseId}`,
        adapter: workspaceBoundEngine(new FakeEngine(), { wsAbs: ws.wsAbs, cacheAbs: ws.cacheAbs }),
        contract: {
          workItemId: `WI-${releaseId}`,
          contractRevision: 1,
          sopRef: { id: "SOPDEF-KC05", revision: 1 },
          steps: STEPS,
        },
      });
      expect(outcome.kind).toBe("succeeded");
    }
  }, 120_000);

  afterAll(async () => {
    for (const ws of Object.values(materialized)) {
      ws.server.close();
    }
    await tempDb?.cleanup();
    if (rootAbs) {
      await rm(rootAbs, { recursive: true, force: true });
    }
  });

  it("đóng + purge Q1 đúng phạm vi: scope Q1 sạch cả đĩa lẫn sổ worktree, Q2 nguyên vẹn từng byte, DB xác nhận không đụng", async () => {
    const q1 = materialized["RUN-REL-Q1"];
    const q2 = materialized["RUN-REL-Q2"];
    const q2ScopeAbs = join(rootAbs, "releases", "RUN-REL-Q2");
    const q2TreeBefore = await hashTree(q2ScopeAbs);
    const dbArtifactsBefore = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_session_artifacts`,
    )) as unknown as Array<{ n: number }>;
    const eventsBefore = (await db.execute(
      sql`SELECT count(*)::int AS n FROM message_store.messages`,
    )) as unknown as Array<{ n: number }>;

    // Thứ tự ADR-012 — bước 1: chặn task mới.
    await beginWorkspaceClose(db, "KC05-B5-CLOSE-Q1", { workspaceId: "WS-RUN-REL-Q1", reason: "release-done" });
    let taskCode = "NO-REJECTION";
    try {
      await requireActiveWorkspace(db, "RUN-REL-Q1");
    } catch (error) {
      if (error instanceof CommandRejectedError) taskCode = error.code;
      else throw error;
    }
    expect(taskCode).toBe("ERR-WS-NO-ACTIVE");

    // Bước 2: đóng phiên/tài nguyên đang giữ (worker dừng, port nhả).
    q1.server.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    // Bước 3+4: xóa đúng scope + post-check; bước 5: event kết quả qua lệnh.
    const { report, error } = await purgeReleaseScopeOnDisk({
      rootAbs,
      repoPath,
      releaseId: "RUN-REL-Q1",
      actor: "dopaios-runner",
    });
    expect(error).toBeUndefined();
    expect(report.residue).toEqual([]);
    expect(report.purgedScope.length).toBeGreaterThan(0);
    expect(report.purgedScope.every((p) => p.startsWith("releases/RUN-REL-Q1/"))).toBe(true);
    const purged = await recordWorkspacePurge(db, "KC05-B5-PURGE-Q1", {
      workspaceId: "WS-RUN-REL-Q1",
      outcome: "purged",
      report,
    });
    expect(purged["state"]).toBe("PURGED");

    // Đĩa: scope Q1 biến mất; sổ worktree của repo nền không còn entry Q1.
    expect(existsSync(join(rootAbs, "releases", "RUN-REL-Q1"))).toBe(false);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const runGit = promisify(execFile);
    const worktrees = await runGit("git", ["-C", repoPath, "worktree", "list", "--porcelain"]);
    expect(worktrees.stdout.includes("RUN-REL-Q1")).toBe(false);

    // Q2 nguyên vẹn từng byte; port Q2 vẫn độc quyền; credential Q2 vẫn đọc được.
    expect(await hashTree(q2ScopeAbs)).toEqual(q2TreeBefore);
    await expect(bindPort(q2.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    const cred = await accessWorkspaceCredential(db, "KC05-B5-CRED-Q2", {
      workspaceId: "WS-RUN-REL-Q2",
      forReleaseId: "RUN-REL-Q2",
      actor: "AI-STAFF-RUN-REL-Q2",
    });
    expect((cred["credentialRef"] as { id: string }).id).toBe("CRED-RUN-REL-Q2");

    // Dữ liệu ĐÃ XÁC NHẬN không bị đụng: số artifact phiên giữ nguyên; event
    // log chỉ THÊM (purge events), không mất.
    const dbArtifactsAfter = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_session_artifacts`,
    )) as unknown as Array<{ n: number }>;
    expect(dbArtifactsAfter[0].n).toBe(dbArtifactsBefore[0].n);
    const eventsAfter = (await db.execute(
      sql`SELECT count(*)::int AS n FROM message_store.messages`,
    )) as unknown as Array<{ n: number }>;
    expect(eventsAfter[0].n).toBeGreaterThan(eventsBefore[0].n);

    // Tài nguyên Q1 đã trả; port Q1 bind lại được (tái dùng sau purge).
    const resources = (await db.execute(
      sql`SELECT resource_type, state FROM dopaios_workspace_resources
          WHERE release_id = 'RUN-REL-Q1' ORDER BY resource_type`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(resources).toEqual([
      { resource_type: "credential", state: "released" },
      { resource_type: "path", state: "released" },
      { resource_type: "port", state: "released" },
    ]);
    const rebound = await bindPort(q1.port);
    rebound.close();
  });

  it("purge fail → PURGE_BLOCKED giữ tài nguyên, đóng không hoàn tất; retry đưa về PURGED", async () => {
    const q2 = materialized["RUN-REL-Q2"];
    await beginWorkspaceClose(db, "KC05-B5-CLOSE-Q2", { workspaceId: "WS-RUN-REL-Q2", reason: "release-done" });
    q2.server.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    // Giả lập lỗi hạ tầng xóa: adapter fs ném lỗi — cơ chế GHI NHẬN thất bại
    // là production-shaped (guard + hồ sơ FR-17), điểm tiêm lỗi là test-only.
    const { report: failedReport, error } = await purgeReleaseScopeOnDisk({
      rootAbs,
      repoPath,
      releaseId: "RUN-REL-Q2",
      actor: "dopaios-runner",
      fs: {
        removeDir: async () => {
          throw new Error("EIO: simulated storage failure");
        },
      },
    });
    expect(error).toContain("EIO");
    expect(failedReport.residue.length).toBeGreaterThan(0);

    const blocked = await recordWorkspacePurge(db, "KC05-B5-PURGE-Q2-FAIL", {
      workspaceId: "WS-RUN-REL-Q2",
      outcome: "failed",
      failure: {
        reason: `purge lỗi hạ tầng: ${error}`,
        leftoverScope: failedReport.residue,
        correctiveAction: {
          owner: "dopaios-operator",
          dueMs: 3_600_000,
          scope: failedReport.residue,
        },
      },
    });
    expect(blocked["state"]).toBe("PURGE_BLOCKED");

    // Đóng KHÔNG hoàn tất: workspace vẫn chiếm Release (không cấp mới được),
    // tài nguyên vẫn reserved — không tái gán khi chưa sạch (FR-17/ADR-012).
    let dupCode = "NO-REJECTION";
    try {
      await provisionWorkspace(db, "KC05-B5-PROV-Q2-AGAIN", {
        workspaceId: "WS-RUN-REL-Q2-B",
        releaseId: "RUN-REL-Q2",
        portPool: PORT_POOL,
        baseRef: "irrelevant",
      });
    } catch (err) {
      if (err instanceof CommandRejectedError) dupCode = err.code;
      else throw err;
    }
    expect(dupCode).toBe("ERR-WS-DUP-RELEASE");
    const resources = (await db.execute(
      sql`SELECT resource_type, state FROM dopaios_workspace_resources
          WHERE release_id = 'RUN-REL-Q2' ORDER BY resource_type`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(resources).toEqual([
      { resource_type: "credential", state: "reserved" },
      { resource_type: "path", state: "reserved" },
      { resource_type: "port", state: "reserved" },
    ]);

    // Retry có giới hạn (FR-17): purge thật thành công → PURGED, scope sạch.
    const { report, error: retryError } = await purgeReleaseScopeOnDisk({
      rootAbs,
      repoPath,
      releaseId: "RUN-REL-Q2",
      actor: "dopaios-runner",
    });
    expect(retryError).toBeUndefined();
    expect(report.residue).toEqual([]);
    const purged = await recordWorkspacePurge(db, "KC05-B5-PURGE-Q2-RETRY", {
      workspaceId: "WS-RUN-REL-Q2",
      outcome: "purged",
      report,
    });
    expect(purged["state"]).toBe("PURGED");
    expect(existsSync(join(rootAbs, "releases", "RUN-REL-Q2"))).toBe(false);
    expect(await listTree(join(rootAbs, "releases", "RUN-REL-Q2"))).toEqual([]);

    const workspace = (await db.execute(
      sql`SELECT state, purge_failure ->> 'reason' AS fail_reason, purge_report -> 'residue' AS residue
          FROM dopaios_workspaces WHERE id = 'WS-RUN-REL-Q2'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(workspace[0]["state"]).toBe("PURGED");
    expect(String(workspace[0]["fail_reason"])).toContain("EIO");
    expect(workspace[0]["residue"]).toEqual([]);
  });

  it("replay dựng lại đúng trạng thái sau trọn chuỗi đóng–purge–fail–retry (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
