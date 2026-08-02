import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  executeCommand,
  replayProjections,
  snapshotProjections,
  countAllEvents,
} from "./event-store.js";
import {
  provisionWorkspace,
  activateWorkspace,
  beginWorkspaceClose,
  recordWorkspacePurge,
} from "./workspace.js";
import {
  initFixtureRepo,
  materializeWorkspace,
  workspaceBoundEngine,
  purgeReleaseScopeOnDisk,
  hashTree,
  listTree,
  readCredentialFile,
  type MaterializedWorkspace,
} from "./workspace-fs.js";
import { requestActivation, claimActivation, completeActivation } from "./activation.js";
import { FakeEngine, runWorkItemSession } from "./engine.js";

// KC-05 B6: diễn tập trên Postgres NGOÀI (container dopaios-spike-pg, DB
// dopaios_kc05) — chạy trọn kịch bản hai Release song song trên đĩa thật của
// môi trường spike, rồi đóng + purge một Release và đối chiếu Release còn
// lại từng byte. Số liệu in ra là bằng chứng đính hồ sơ (log kc05-drill.log).
//
//   DATABASE_URL=postgres://…/dopaios_kc05 pnpm exec tsx src/dopaios/seed-kc05-drill.ts

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("Cần DATABASE_URL trỏ vào dopaios_kc05 trên container spike");
}

// B7 (minor review lens 2): nonce theo lần chạy — command id KC05-DRILL-*
// cố định làm lần chạy 2 trên DB bền thành 100% idempotent replay (không
// kiểm chứng gì sống); nonce làm mỗi lần chạy là một cặp Release mới, và
// cuối drill dọn TRỌN cả hai Release nên tài nguyên không bị chiếm vĩnh viễn.
const NONCE = process.env.KC05_DRILL_NONCE ?? Date.now().toString(36);
const RELEASES = [`RUN-DRILL-${NONCE}-1`, `RUN-DRILL-${NONCE}-2`] as const;
const PORT_POOL = [15921, 15922];
const STEPS = ["plan", "build", "test"];

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`DRILL ASSERT FAIL: ${label}`);
  }
  console.log(`OK  ${label}`);
}

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const rootAbs = await mkdtemp(join(tmpdir(), "kc05-drill-"));
  console.log(`drill root: ${rootAbs}`);
  const repo = await initFixtureRepo(rootAbs);

  const materialized: Record<string, MaterializedWorkspace> = {};
  for (const releaseId of RELEASES) {
    await executeCommand(db, {
      commandId: `KC05-DRILL-SEED-${releaseId}`,
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
    const provisioned = await provisionWorkspace(db, `KC05-DRILL-PROV-${releaseId}`, {
      workspaceId: `WS-${releaseId}`,
      releaseId,
      portPool: PORT_POOL,
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
    materialized[releaseId] = ws;
    await activateWorkspace(db, `KC05-DRILL-ACT-${releaseId}`, {
      workspaceId: `WS-${releaseId}`,
      materialized: { worktreeHead: ws.worktreeHead, boundPort: ws.port },
    });
    console.log(`workspace ${releaseId}: port=${ws.port} head=${ws.worktreeHead.slice(0, 9)}`);
  }
  assert(materialized[RELEASES[0]].port !== materialized[RELEASES[1]].port, "hai Release hai port khác nhau");

  // Hai Release chạy ĐỒNG THỜI qua claim CAS + lease.
  const outcomes = await Promise.all(
    RELEASES.map(async (releaseId) => {
      const activationId = `ACT-${releaseId}`;
      await requestActivation(db, `KC05-DRILL-REQ-${releaseId}`, {
        activationId,
        workItemId: `WI-${releaseId}`,
        agentId: `AI-STAFF-${releaseId}`,
        engine: "fake-acp-shape+workspace",
      });
      await claimActivation(db, `KC05-DRILL-CLAIM-${releaseId}`, {
        activationId,
        claimedBy: `AI-STAFF-${releaseId}`,
        lease: { untilMs: Date.now() + 60_000 },
      });
      const ws = materialized[releaseId];
      const outcome = await runWorkItemSession(db, {
        sessionId: `SES-${releaseId}`,
        agentId: `AI-STAFF-${releaseId}`,
        adapter: workspaceBoundEngine(
          new FakeEngine(),
          { wsAbs: ws.wsAbs, cacheAbs: ws.cacheAbs },
          { db, workspaceId: `WS-${releaseId}` },
        ),
        contract: {
          workItemId: `WI-${releaseId}`,
          contractRevision: 1,
          sopRef: { id: "SOPDEF-KC05", revision: 1 },
          steps: STEPS,
        },
      });
      await completeActivation(db, `KC05-DRILL-DONE-${releaseId}`, {
        activationId,
        outcome: "succeeded",
        leaseEpoch: 0,
      });
      return outcome;
    }),
  );
  assert(outcomes.every((o) => o.kind === "succeeded"), "hai phiên song song đều succeeded");

  for (const releaseId of RELEASES) {
    const other = RELEASES.find((r) => r !== releaseId)!;
    const ws = materialized[releaseId];
    const artifacts = (await listTree(ws.wsAbs)).filter((p) => p.startsWith("artifacts/"));
    assert(
      artifacts.length === STEPS.length && artifacts.every((p) => p.includes(`SES-${releaseId}`)),
      `artifact tạm của ${releaseId} đúng ${STEPS.length} bước, chỉ của phiên mình`,
    );
    const tree = await hashTree(ws.wsAbs);
    assert(
      Object.keys(tree).every((p) => !p.includes(other)),
      `không dấu vết ${other} trong workspace ${releaseId}`,
    );
    const cred = await readCredentialFile(ws.credentialAbs, {
      id: `CRED-${releaseId}`,
      sha256: ((await db.execute(
        sql`SELECT credential_ref ->> 'sha256' AS sha FROM dopaios_workspaces WHERE id = ${"WS-" + releaseId}`,
      )) as unknown as Array<{ sha: string }>)[0].sha,
    });
    assert(cred["fixtureCredential"] === releaseId, `credential ${releaseId} đúng scope, sha khớp sổ`);
  }

  // Đóng + purge Release 1; Release 2 phải nguyên vẹn từng byte.
  const keep = materialized[RELEASES[1]];
  const keepScope = join(rootAbs, "releases", RELEASES[1]);
  const keepBefore = await hashTree(keepScope);
  await beginWorkspaceClose(db, `KC05-DRILL-CLOSE-${RELEASES[0]}`, {
    workspaceId: `WS-${RELEASES[0]}`,
    reason: "drill-release-done",
  });
  await new Promise<void>((resolvePromise) => materialized[RELEASES[0]].server.close(() => resolvePromise()));
  const { report, error } = await purgeReleaseScopeOnDisk({
    db,
    rootAbs,
    repoPath: repo.repoPath,
    releaseId: RELEASES[0],
    actor: "dopaios-runner",
  });
  assert(error === undefined && report.residue.length === 0, "purge trên đĩa sạch, residue rỗng");
  await recordWorkspacePurge(db, `KC05-DRILL-PURGE-${RELEASES[0]}`, {
    workspaceId: `WS-${RELEASES[0]}`,
    outcome: "purged",
    report,
  });
  assert(!existsSync(join(rootAbs, "releases", RELEASES[0])), `scope ${RELEASES[0]} đã biến mất khỏi đĩa`);
  const keepAfter = await hashTree(keepScope);
  assert(
    JSON.stringify(keepAfter) === JSON.stringify(keepBefore),
    `${RELEASES[1]} nguyên vẹn từng byte sau khi purge ${RELEASES[0]} (${Object.keys(keepAfter).length} file)`,
  );
  const keepApp = await readFile(join(keep.wsAbs, "src", "app.txt"), "utf8");
  assert(keepApp.includes("shared base content"), "nội dung nền Release giữ lại không đổi");

  // Replay từ event log trên container — byte-identical.
  const before = await snapshotProjections(db);
  await replayProjections(db);
  const after = await snapshotProjections(db);
  assert(JSON.stringify(after) === JSON.stringify(before), "replay projection byte-identical (SQR-003)");

  // B7: dọn TRỌN Release còn lại trước khi thoát — DB bền không giữ workspace
  // ACTIVE và tài nguyên reserved vĩnh viễn sau drill.
  await beginWorkspaceClose(db, `KC05-DRILL-CLOSE-${RELEASES[1]}`, {
    workspaceId: `WS-${RELEASES[1]}`,
    reason: "drill-cleanup",
  });
  await new Promise<void>((resolvePromise) => keep.server.close(() => resolvePromise()));
  const cleanup = await purgeReleaseScopeOnDisk({
    db,
    rootAbs,
    repoPath: repo.repoPath,
    releaseId: RELEASES[1],
    actor: "dopaios-runner",
  });
  assert(cleanup.error === undefined && cleanup.report.residue.length === 0, "dọn Release còn lại sạch");
  await recordWorkspacePurge(db, `KC05-DRILL-PURGE-${RELEASES[1]}`, {
    workspaceId: `WS-${RELEASES[1]}`,
    outcome: "purged",
    report: cleanup.report,
  });

  const events = await countAllEvents(db);
  const workspaces = (await db.execute(
    sql`SELECT id, state FROM dopaios_workspaces WHERE release_id LIKE ${"RUN-DRILL-" + NONCE + "%"} ORDER BY id`,
  )) as unknown as Array<{ id: string; state: string }>;
  const resources = (await db.execute(
    sql`SELECT state, count(*)::int AS n FROM dopaios_workspace_resources
        WHERE release_id LIKE ${"RUN-DRILL-" + NONCE + "%"} GROUP BY state ORDER BY state`,
  )) as unknown as Array<{ state: string; n: number }>;
  console.log(`nonce: ${NONCE}`);
  console.log(`events: ${events}`);
  console.log(`workspaces: ${workspaces.map((w) => `${w.id}=${w.state}`).join(", ")}`);
  console.log(`resources: ${resources.map((r) => `${r.state}=${r.n}`).join(", ")}`);

  await rm(rootAbs, { recursive: true, force: true });
  console.log("KC05 DRILL PASS");
  process.exit(0);
}

main().catch((error) => {
  console.error("KC05 DRILL FAIL", error);
  process.exit(1);
});
