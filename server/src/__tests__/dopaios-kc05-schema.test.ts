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
  CommandPayloadMismatchError,
} from "../dopaios/event-store.ts";
import {
  provisionWorkspace,
  activateWorkspace,
  beginWorkspaceClose,
  recordWorkspacePurge,
} from "../dopaios/workspace.ts";

// KC-05 B1: schema 0517 + projector + vòng đời workspace theo Release trên
// event store KC-01 (QD-1). Bài kiểm nền: cấp phát → vật chất hóa → đóng →
// purge dựng thuần từ event log, idempotency theo command_id hai chiều,
// replay byte-identical (SQR-003). Tương tranh thật và ca âm guard thuộc B2.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-05 B1 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function seedRun(db: ReturnType<typeof createDb>, runId: string): Promise<void> {
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
      return { runId };
    },
  });
}

describeEmbeddedPostgres("dopaios KC-05 B1 — schema 0517 + vòng đời workspace", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc05-b1-");
    db = createDb(tempDb.connectionString);
    await seedRun(db, "RUN-REL-A");
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("provision cấp phát port/path/credential nguyên tử và projection đúng", async () => {
    const result = await provisionWorkspace(db, "KC05-B1-PROV-A", {
      workspaceId: "WS-REL-A",
      releaseId: "RUN-REL-A",
      projectId: "PROJ-KC05",
      portPool: [15501, 15502],
      baseRef: "kc05-base",
    });
    expect(result).toMatchObject({
      workspaceId: "WS-REL-A",
      state: "PROVISIONED",
      port: 15501,
      relPath: "releases/RUN-REL-A/ws",
      cacheRelPath: "releases/RUN-REL-A/cache",
    });
    const credentialRef = result["credentialRef"] as { id: string; sha256: string };
    expect(credentialRef.id).toBe("CRED-RUN-REL-A");
    expect(credentialRef.sha256).toMatch(/^[0-9a-f]{64}$/);

    const workspaces = (await db.execute(
      sql`SELECT id, release_id, project_id, state, rel_path, cache_rel_path, port, base_ref, materialized
          FROM dopaios_workspaces`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(workspaces).toEqual([
      {
        id: "WS-REL-A",
        release_id: "RUN-REL-A",
        project_id: "PROJ-KC05",
        state: "PROVISIONED",
        rel_path: "releases/RUN-REL-A/ws",
        cache_rel_path: "releases/RUN-REL-A/cache",
        port: 15501,
        base_ref: "kc05-base",
        materialized: null,
      },
    ]);

    const resources = (await db.execute(
      sql`SELECT resource_type, value, workspace_id, release_id, state
          FROM dopaios_workspace_resources ORDER BY resource_type`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(resources).toEqual([
      {
        resource_type: "credential",
        value: "CRED-RUN-REL-A",
        workspace_id: "WS-REL-A",
        release_id: "RUN-REL-A",
        state: "reserved",
      },
      {
        resource_type: "path",
        value: "releases/RUN-REL-A/ws",
        workspace_id: "WS-REL-A",
        release_id: "RUN-REL-A",
        state: "reserved",
      },
      {
        resource_type: "port",
        value: "15501",
        workspace_id: "WS-REL-A",
        release_id: "RUN-REL-A",
        state: "reserved",
      },
    ]);
  });

  it("idempotency theo command_id hai chiều (SFR-038/039)", async () => {
    const replay = await provisionWorkspace(db, "KC05-B1-PROV-A", {
      workspaceId: "WS-REL-A",
      releaseId: "RUN-REL-A",
      projectId: "PROJ-KC05",
      portPool: [15501, 15502],
      baseRef: "kc05-base",
    });
    expect(replay["idempotentReplay"]).toBe(true);
    expect(replay["port"]).toBe(15501);

    await expect(
      provisionWorkspace(db, "KC05-B1-PROV-A", {
        workspaceId: "WS-REL-A",
        releaseId: "RUN-REL-A",
        projectId: "PROJ-KC05",
        portPool: [15501],
        baseRef: "kc05-base",
      }),
    ).rejects.toBeInstanceOf(CommandPayloadMismatchError);
  });

  it("vòng đời trọn PROVISIONED → ACTIVE → CLOSING → PURGED, tài nguyên release", async () => {
    const activated = await activateWorkspace(db, "KC05-B1-ACT-A", {
      workspaceId: "WS-REL-A",
      materialized: { worktreeHead: "a".repeat(40), boundPort: 15501 },
    });
    expect(activated["state"]).toBe("ACTIVE");

    const closing = await beginWorkspaceClose(db, "KC05-B1-CLOSE-A", {
      workspaceId: "WS-REL-A",
      reason: "release-done",
    });
    expect(closing["state"]).toBe("CLOSING");

    const purged = await recordWorkspacePurge(db, "KC05-B1-PURGE-A", {
      workspaceId: "WS-REL-A",
      outcome: "purged",
      report: {
        actor: "dopaios-runner",
        purgedScope: ["releases/RUN-REL-A/ws", "releases/RUN-REL-A/cache"],
        checksums: { "releases/RUN-REL-A/ws": "b".repeat(64) },
        residue: [],
      },
    });
    expect(purged["state"]).toBe("PURGED");

    const workspace = (await db.execute(
      sql`SELECT state, close_reason, purge_report -> 'residue' AS residue, materialized ->> 'worktreeHead' AS head
          FROM dopaios_workspaces WHERE id = 'WS-REL-A'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(workspace).toEqual([
      { state: "PURGED", close_reason: "release-done", residue: [], head: "a".repeat(40) },
    ]);

    const resources = (await db.execute(
      sql`SELECT resource_type, state FROM dopaios_workspace_resources ORDER BY resource_type`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(resources).toEqual([
      { resource_type: "credential", state: "released" },
      { resource_type: "path", state: "released" },
      { resource_type: "port", state: "released" },
    ]);
  });

  it("replay dựng lại projection workspace byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
    expect(Object.keys(after)).toContain("dopaios_workspaces");
    expect(Object.keys(after)).toContain("dopaios_workspace_resources");
  });
});
