import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
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
import { executeCommand, CommandRejectedError } from "../dopaios/event-store.ts";
import {
  provisionWorkspace,
  activateWorkspace,
  requireActiveWorkspace,
  accessWorkspaceCredential,
} from "../dopaios/workspace.ts";
import {
  initFixtureRepo,
  materializeWorkspace,
  workspaceBoundEngine,
  bindPort,
  hashTree,
  listTree,
  readCredentialFile,
  sha256Hex,
  type MaterializedWorkspace,
} from "../dopaios/workspace-fs.ts";
import { requestActivation, claimActivation, completeActivation } from "../dopaios/activation.ts";
import { FakeEngine, runWorkItemSession } from "../dopaios/engine.ts";

// KC-05 B3: hai Release giả lập chạy ĐỒNG THỜI trên hai git worktree thật cắt
// từ một repo nền, mỗi bên FakeEngine ghi checkpoint thành artifact tạm +
// cache trong đúng scope của mình, giữ port thật của mình — tiêu chí "không
// giẫm workspace, cache, port, credential hoặc artifact tạm". Claim đi đường
// claim CAS + lease của KC-02/KC-13 (tái dùng, không dựng cơ chế thứ hai).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-05 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const RELEASES = ["RUN-REL-P1", "RUN-REL-P2"] as const;
const PORT_POOL = [15801, 15802];
const STEPS = ["plan", "build", "test"];

async function seedRunWithWorkItem(
  db: ReturnType<typeof createDb>,
  runId: string,
): Promise<void> {
  await executeCommand(db, {
    commandId: `KC05-SEED-${runId}`,
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
      await ctx.emit({
        streamName: `dopaiosWorkItem-WI-${runId}`,
        type: "WorkItemCreated",
        data: { workItemId: `WI-${runId}`, runId, state: "ACCEPTED" },
        expectedVersion: -1,
      });
      return { runId };
    },
  });
}

describeEmbeddedPostgres("dopaios KC-05 B3 — hai Release song song trên worktree thật", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let rootAbs!: string;
  let repoPath!: string;
  let baseSha!: string;
  const materialized: Record<string, MaterializedWorkspace> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc05-b3-");
    db = createDb(tempDb.connectionString);
    rootAbs = await mkdtemp(join(tmpdir(), "kc05-b3-"));
    const repo = await initFixtureRepo(rootAbs);
    repoPath = repo.repoPath;
    baseSha = repo.headSha;

    for (const releaseId of RELEASES) {
      await seedRunWithWorkItem(db, releaseId);
      const provisioned = await provisionWorkspace(db, `KC05-B3-PROV-${releaseId}`, {
        workspaceId: `WS-${releaseId}`,
        releaseId,
        portPool: PORT_POOL,
        baseRef: baseSha,
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
        baseRef: baseSha,
      });
      materialized[releaseId] = ws;
      await activateWorkspace(db, `KC05-B3-ACT-${releaseId}`, {
        workspaceId: `WS-${releaseId}`,
        materialized: { worktreeHead: ws.worktreeHead, boundPort: ws.port },
      });
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

  it("hai worktree thật cắt từ một repo nền: branch riêng, HEAD đúng baseRef, ghi bên này không lộ bên kia", async () => {
    const [p1, p2] = RELEASES.map((r) => materialized[r]);
    expect(p1.worktreeHead).toBe(baseSha);
    expect(p2.worktreeHead).toBe(baseSha);
    expect(existsSync(join(p1.wsAbs, "src", "app.txt"))).toBe(true);
    expect(existsSync(join(p2.wsAbs, "src", "app.txt"))).toBe(true);

    await writeFile(join(p1.wsAbs, "src", "only-p1.txt"), "p1 local change\n", "utf8");
    expect(existsSync(join(p2.wsAbs, "src", "only-p1.txt"))).toBe(false);

    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const statusP2 = await run("git", ["-C", p2.wsAbs, "status", "--porcelain"]);
    expect(statusP2.stdout.trim()).toBe("");
    const branchP1 = await run("git", ["-C", p1.wsAbs, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branchP2 = await run("git", ["-C", p2.wsAbs, "rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branchP1.stdout.trim()).toBe("ws/RUN-REL-P1");
    expect(branchP2.stdout.trim()).toBe("ws/RUN-REL-P2");
  });

  it("hai Release chạy FakeEngine ĐỒNG THỜI qua claim CAS + lease: artifact tạm và cache mỗi bên nằm trọn scope mình", async () => {
    const baselineAppSha: Record<string, string> = {};
    for (const releaseId of RELEASES) {
      baselineAppSha[releaseId] = sha256Hex(await readFile(join(materialized[releaseId].wsAbs, "src", "app.txt")));
    }

    const outcomes = await Promise.all(
      RELEASES.map(async (releaseId) => {
        const workspace = await requireActiveWorkspace(db, releaseId);
        expect(workspace.id).toBe(`WS-${releaseId}`);
        const activationId = `ACT-${releaseId}`;
        await requestActivation(db, `KC05-B3-REQ-${releaseId}`, {
          activationId,
          workItemId: `WI-${releaseId}`,
          agentId: `AI-STAFF-${releaseId}`,
          engine: "fake-acp-shape+workspace",
        });
        await claimActivation(db, `KC05-B3-CLAIM-${releaseId}`, {
          activationId,
          claimedBy: `AI-STAFF-${releaseId}`,
          lease: { untilMs: Date.now() + 60_000 },
        });
        const ws = materialized[releaseId];
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
        await completeActivation(db, `KC05-B3-DONE-${releaseId}`, {
          activationId,
          outcome: "succeeded",
          leaseEpoch: 0,
        });
        return outcome;
      }),
    );
    expect(outcomes.map((o) => o.kind)).toEqual(["succeeded", "succeeded"]);

    for (const releaseId of RELEASES) {
      const other = RELEASES.find((r) => r !== releaseId)!;
      const ws = materialized[releaseId];

      // Artifact tạm: đúng MỘT phiên của chính Release này, đủ các bước.
      const artifacts = (await listTree(ws.wsAbs)).filter((p) => p.startsWith("artifacts/"));
      expect(artifacts.sort()).toEqual(
        STEPS.map((step) => `artifacts/SES-${releaseId}/${step}.ckpt.json`).sort(),
      );
      for (const rel of artifacts) {
        const body = JSON.parse(await readFile(join(ws.wsAbs, rel), "utf8")) as Record<string, unknown>;
        expect(body["sessionId"]).toBe(`SES-${releaseId}`);
        expect(String(body["ref"])).toContain(`SES-${releaseId}`);
      }
      // Cache: đủ entry của mình, không entry nào của bên kia.
      const cache = await listTree(ws.cacheAbs);
      expect(cache.sort()).toEqual(STEPS.map((s) => `steps/${s}.cache`).sort());
      // Nội dung nền không bị bên kia giẫm.
      expect(sha256Hex(await readFile(join(ws.wsAbs, "src", "app.txt")))).toBe(baselineAppSha[releaseId]);
      // Không dấu vết chéo Release trong toàn cây workspace.
      const tree = await hashTree(ws.wsAbs);
      for (const rel of Object.keys(tree)) {
        expect(rel.includes(other), `file ${rel} trong ${releaseId} nhắc tới ${other}`).toBe(false);
      }
    }

    // DB: hai phiên tách stream, checkpoint không trộn (3 ckpt + 1 output mỗi phiên).
    const sessions = (await db.execute(
      sql`SELECT id, state, work_item_id FROM dopaios_ai_sessions ORDER BY id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(sessions).toEqual([
      { id: "SES-RUN-REL-P1", state: "TERMINAL", work_item_id: "WI-RUN-REL-P1" },
      { id: "SES-RUN-REL-P2", state: "TERMINAL", work_item_id: "WI-RUN-REL-P2" },
    ]);
    const artifactRows = (await db.execute(
      sql`SELECT session_id, count(*)::int AS n FROM dopaios_session_artifacts GROUP BY session_id ORDER BY session_id`,
    )) as unknown as Array<{ session_id: string; n: number }>;
    expect(artifactRows).toEqual([
      { session_id: "SES-RUN-REL-P1", n: STEPS.length + 1 },
      { session_id: "SES-RUN-REL-P2", n: STEPS.length + 1 },
    ]);
  });

  it("port mỗi Release độc quyền thật ở mức OS khi cả hai đang sống", async () => {
    const [p1, p2] = RELEASES.map((r) => materialized[r]);
    expect(p1.port).not.toBe(p2.port);
    for (const ws of [p1, p2]) {
      await expect(bindPort(ws.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    }
  });

  it("credential mỗi bên đọc đúng của mình qua sổ + file; nội dung bị tráo là bị phát hiện", async () => {
    for (const releaseId of RELEASES) {
      const ws = materialized[releaseId];
      const granted = await accessWorkspaceCredential(db, `KC05-B3-CRED-${releaseId}`, {
        workspaceId: `WS-${releaseId}`,
        forReleaseId: releaseId,
        actor: `AI-STAFF-${releaseId}`,
      });
      const ref = granted["credentialRef"] as { id: string; sha256: string };
      const body = await readCredentialFile(ws.credentialAbs, ref);
      expect(body["fixtureCredential"]).toBe(releaseId);
    }

    const p2 = materialized["RUN-REL-P2"];
    const original = await readFile(p2.credentialAbs, "utf8");
    await writeFile(p2.credentialAbs, `{"fixtureCredential":"RUN-REL-P1-GIẢ"}`, "utf8");
    const grantedAgain = await accessWorkspaceCredential(db, `KC05-B3-CRED-TAMPER`, {
      workspaceId: "WS-RUN-REL-P2",
      forReleaseId: "RUN-REL-P2",
      actor: "AI-STAFF-RUN-REL-P2",
    });
    await expect(
      readCredentialFile(p2.credentialAbs, grantedAgain["credentialRef"] as { id: string; sha256: string }),
    ).rejects.toThrow(/bị tráo/);
    await writeFile(p2.credentialAbs, original, "utf8");
  });

  it("không có workspace ACTIVE thì đường worker fail-closed (ERR-WS-NO-ACTIVE)", async () => {
    let code = "NO-REJECTION";
    try {
      await requireActiveWorkspace(db, "RUN-REL-KHONG-CO");
    } catch (error) {
      if (error instanceof CommandRejectedError) code = error.code;
      else throw error;
    }
    expect(code).toBe("ERR-WS-NO-ACTIVE");
  });
});
