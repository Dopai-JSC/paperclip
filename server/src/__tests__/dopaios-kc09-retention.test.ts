import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { registerActor, registerApprovedArtifact } from "../dopaios/commands.js";
import { bindArtifactProjectScope } from "../dopaios/context-package.js";
import { executeCommand, replayProjections, snapshotProjections } from "../dopaios/event-store.js";
import { completeSession, startAiSession } from "../dopaios/sessions.js";
import {
  recordWorkspacePurge,
  recordWorkspaceRetentionControl,
} from "../dopaios/workspace.js";
import {
  initFixtureRepo,
  purgeReleaseScopeOnDisk,
} from "../dopaios/workspace-fs.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("dopaios KC-09 retention, hold, and purge", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let rootAbs!: string;
  let repoPath!: string;
  const policyRef = { id: "RETENTION-POLICY-KC09", revision: 1, sha256: "9".repeat(64) };

  async function materializePurgeFixture(releaseId: string): Promise<string> {
    const scopeAbs = join(rootAbs, "releases", releaseId);
    await rm(scopeAbs, { recursive: true, force: true });
    const wsAbs = join(scopeAbs, "ws");
    await mkdir(wsAbs, { recursive: true });
    const protectedFile = join(wsAbs, "business-content.txt");
    await writeFile(protectedFile, `protected:${releaseId}\n`, "utf8");
    return protectedFile;
  }

  async function expectPhysicalPurgeRejectionAudit(
    releaseId: string,
    actor: string,
    code: string,
  ): Promise<void> {
    const commandId = `KC09-PURGE-FS-${releaseId}-${actor}`;
    const rows = (await db.execute(sql`
      SELECT data ->> 'code' AS code
      FROM message_store.messages
      WHERE type = 'CommandRejected' AND data ->> 'commandId' = ${commandId}
      ORDER BY global_position
    `)) as unknown as Array<{ code: string }>;
    expect(rows).toEqual([{ code }]);
  }

  const purgeReport = (releaseId: string) => ({
    actor: "CTO-KC09",
    purgedScope: [`releases/${releaseId}/ws`, `releases/${releaseId}/cache`],
    checksums: {
      [`releases/${releaseId}/ws`]: "a".repeat(64),
      [`releases/${releaseId}/cache`]: "b".repeat(64),
    },
    residue: [],
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc09-retention-");
    db = createDb(tempDb.connectionString);
    rootAbs = await mkdtemp(join(tmpdir(), "dopaios-kc09-retention-fs-"));
    repoPath = (await initFixtureRepo(rootAbs)).repoPath;
    await registerActor(db, "KC09-RETENTION-ACTOR", {
      actorId: "CTO-KC09",
      kind: "human",
      active: true,
      capabilities: ["retention-admin"],
    });
    await executeCommand(db, {
      commandId: "KC09-RETENTION-WORKSPACES",
      payload: {},
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosProject-PROJECT-KC09",
          type: "ProjectShellCreated",
          data: {
            projectId: "PROJECT-KC09",
            templateRef: { id: "PROJECT-TEMPLATE", revision: 1, sha256: "a".repeat(64) },
            orchestrator: "CTO-KC09",
            createdBy: "CTO-KC09",
          },
        });
        for (const [workspaceId, releaseId, port] of [
          ["WS-KC09-HOLD", "REL-KC09-HOLD", 17901],
          ["WS-KC09-RETENTION", "REL-KC09-RETENTION", 17902],
          ["WS-KC09-EXPIRED", "REL-KC09-EXPIRED", 17903],
          ["WS-KC09-FAIL", "REL-KC09-FAIL", 17904],
          ["WS-KC09-DRILL", "REL-KC09-DRILL", 17905],
          ["WS-KC09-WRITER", "REL-KC09-WRITER", 17906],
        ] as const) {
          const credentialRef = { id: `CRED-${releaseId}`, sha256: "c".repeat(64) };
          await ctx.emit({
            streamName: `dopaiosWorkspace-${workspaceId}`,
            type: "WorkspaceProvisioned",
            data: {
              workspaceId,
              releaseId,
              projectId: "PROJECT-KC09",
              relPath: `releases/${releaseId}/ws`,
              cacheRelPath: `releases/${releaseId}/cache`,
              port,
              credentialRef,
              baseRef: "5961236b707080fd709a6a5f294bd431cec8b927",
            },
          });
          for (const [resourceType, value] of [
            ["port", String(port)],
            ["path", `releases/${releaseId}/ws`],
            ["credential", credentialRef.id],
          ] as const) {
            await ctx.emit({
              streamName: `dopaiosWorkspace-${workspaceId}`,
              type: "WorkspaceResourceReserved",
              data: { workspaceId, releaseId, resourceType, value },
            });
          }
          await ctx.emit({
            streamName: `dopaiosWorkspace-${workspaceId}`,
            type: "WorkspaceActivated",
            data: { workspaceId, materialized: { worktreeHead: "5961236", boundPort: port } },
          });
          await ctx.emit({
            streamName: `dopaiosWorkspace-${workspaceId}`,
            type: "WorkspaceCloseStarted",
            data: { workspaceId, reason: "retention-fixture" },
          });
        }
        return {};
      },
    });
    await registerApprovedArtifact(db, "KC09-RETENTION-POLICY", {
      artifactId: policyRef.id,
      revision: policyRef.revision,
      sha256: policyRef.sha256,
      artifactType: "retention-policy",
      storageRef: "fixture://RETENTION-POLICY-KC09",
    });
    await bindArtifactProjectScope(db, "KC09-RETENTION-POLICY-SCOPE", {
      artifactId: policyRef.id,
      revision: policyRef.revision,
      projectId: "PROJECT-KC09",
      boundBy: "CTO-KC09",
    });
    await recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-HOLD", {
      workspaceId: "WS-KC09-HOLD",
      policyRef,
      retentionUntil: "2000-01-01T00:00:00.000Z",
      legalHold: {
        holdId: "HOLD-KC09-1",
        active: true,
        reason: "security investigation",
        authorizedBy: "CTO-KC09",
      },
      actorId: "CTO-KC09",
    });
    await recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-FUTURE", {
      workspaceId: "WS-KC09-RETENTION",
      policyRef,
      retentionUntil: "2100-01-01T00:00:00.000Z",
      legalHold: null,
      actorId: "CTO-KC09",
    });
    await recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-EXPIRED", {
      workspaceId: "WS-KC09-EXPIRED",
      policyRef,
      retentionUntil: "2000-01-01T00:00:00.000Z",
      legalHold: null,
      actorId: "CTO-KC09",
    });
    await recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-FAIL", {
      workspaceId: "WS-KC09-FAIL",
      policyRef,
      retentionUntil: "2000-01-01T00:00:00.000Z",
      legalHold: null,
      actorId: "CTO-KC09",
    });
    await recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-DRILL", {
      workspaceId: "WS-KC09-DRILL",
      policyRef,
      retentionUntil: "2000-01-01T00:00:00.000Z",
      legalHold: null,
      actorId: "CTO-KC09",
    });
    await recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-WRITER", {
      workspaceId: "WS-KC09-WRITER",
      policyRef,
      retentionUntil: "2000-01-01T00:00:00.000Z",
      legalHold: null,
      actorId: "CTO-KC09",
    });
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
    if (rootAbs) await rm(rootAbs, { recursive: true, force: true });
  });

  it("rejects an unregistered actor that claims authority to purge a governed workspace", async () => {
    await expect(recordWorkspacePurge(db, "KC09-PURGE-IMPERSONATED", {
      workspaceId: "WS-KC09-EXPIRED",
      actorId: "FAKE-RETENTION-ADMIN",
      outcome: "purged",
      report: { ...purgeReport("REL-KC09-EXPIRED"), actor: "FAKE-RETENTION-ADMIN" },
    })).rejects.toMatchObject({ code: "ERR-WS-PURGE-AUTH" });
  });

  it("rejects a retention policy pin that is not approved and active in the workspace Project", async () => {
    await expect(recordWorkspaceRetentionControl(db, "KC09-RETENTION-CONTROL-UNSCOPED", {
      workspaceId: "WS-KC09-EXPIRED",
      policyRef: { id: "RETENTION-POLICY-UNSCOPED", revision: 1, sha256: "8".repeat(64) },
      retentionUntil: "2000-01-01T00:00:00.000Z",
      legalHold: null,
      actorId: "CTO-KC09",
    })).rejects.toMatchObject({ code: "ERR-WS-RETENTION-POLICY" });
  });

  it("blocks purge under an active legal hold and writes an immutable rejection audit", async () => {
    await expect(recordWorkspacePurge(db, "KC09-PURGE-HELD", {
      workspaceId: "WS-KC09-HOLD",
      actorId: "CTO-KC09",
      outcome: "purged",
      report: purgeReport("REL-KC09-HOLD"),
    })).rejects.toMatchObject({ code: "ERR-WS-LEGAL-HOLD" });
    const rows = (await db.execute(sql`
      SELECT type, data ->> 'code' AS code FROM message_store.messages
      WHERE type = 'CommandRejected' AND data ->> 'commandId' = 'KC09-PURGE-HELD'
    `)) as unknown as Array<{ type: string; code: string }>;
    expect(rows).toEqual([{ type: "CommandRejected", code: "ERR-WS-LEGAL-HOLD" }]);
  });

  it("blocks purge until the retention deadline", async () => {
    await expect(recordWorkspacePurge(db, "KC09-PURGE-RETENTION", {
      workspaceId: "WS-KC09-RETENTION",
      actorId: "CTO-KC09",
      outcome: "purged",
      report: purgeReport("REL-KC09-RETENTION"),
    })).rejects.toMatchObject({ code: "ERR-WS-RETENTION" });
  });

  it("does not delete physical bytes when an unregistered actor requests a governed purge", async () => {
    const protectedFile = await materializePurgeFixture("REL-KC09-DRILL");
    await expect(purgeReleaseScopeOnDisk({
      db,
      rootAbs,
      repoPath,
      releaseId: "REL-KC09-DRILL",
      actor: "FAKE-RETENTION-ADMIN",
    })).rejects.toMatchObject({ code: "ERR-WS-PURGE-AUTH" });
    expect(existsSync(protectedFile)).toBe(true);
    await expectPhysicalPurgeRejectionAudit(
      "REL-KC09-DRILL",
      "FAKE-RETENTION-ADMIN",
      "ERR-WS-PURGE-AUTH",
    );
  });

  it("does not delete physical bytes protected by an active legal hold", async () => {
    const protectedFile = await materializePurgeFixture("REL-KC09-HOLD");
    await expect(purgeReleaseScopeOnDisk({
      db,
      rootAbs,
      repoPath,
      releaseId: "REL-KC09-HOLD",
      actor: "CTO-KC09",
    })).rejects.toMatchObject({ code: "ERR-WS-LEGAL-HOLD" });
    expect(existsSync(protectedFile)).toBe(true);
    await expectPhysicalPurgeRejectionAudit("REL-KC09-HOLD", "CTO-KC09", "ERR-WS-LEGAL-HOLD");
  });

  it("does not delete physical bytes before the retention deadline", async () => {
    const protectedFile = await materializePurgeFixture("REL-KC09-RETENTION");
    await expect(purgeReleaseScopeOnDisk({
      db,
      rootAbs,
      repoPath,
      releaseId: "REL-KC09-RETENTION",
      actor: "CTO-KC09",
    })).rejects.toMatchObject({ code: "ERR-WS-RETENTION" });
    expect(existsSync(protectedFile)).toBe(true);
    await expectPhysicalPurgeRejectionAudit("REL-KC09-RETENTION", "CTO-KC09", "ERR-WS-RETENTION");
  });

  it("does not delete physical bytes while a session can still write into the Release", async () => {
    await registerActor(db, "KC09-WRITER-ACTOR", {
      actorId: "AGENT-KC09-WRITER",
      kind: "ai",
      active: true,
      capabilities: ["work-item-executor"],
    });
    await executeCommand(db, {
      commandId: "KC09-WRITER-WORK-ITEM",
      payload: { workItemId: "WI-KC09-WRITER" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosWorkItem-WI-KC09-WRITER",
          type: "WorkItemCreated",
          data: {
            workItemId: "WI-KC09-WRITER",
            runId: "REL-KC09-WRITER",
            state: "ACCEPTED",
            executor: "AGENT-KC09-WRITER",
            projectId: "PROJECT-KC09",
          },
        });
        return { workItemId: "WI-KC09-WRITER" };
      },
    });
    await startAiSession(db, "KC09-WRITER-SESSION-START", {
      sessionId: "SESSION-KC09-WRITER",
      workItemId: "WI-KC09-WRITER",
      agentId: "AGENT-KC09-WRITER",
      engine: "fake",
    });
    const protectedFile = await materializePurgeFixture("REL-KC09-WRITER");
    try {
      await expect(purgeReleaseScopeOnDisk({
        db,
        rootAbs,
        repoPath,
        releaseId: "REL-KC09-WRITER",
        actor: "CTO-KC09",
      })).rejects.toMatchObject({ code: "ERR-WS-SESSIONS-OPEN" });
      expect(existsSync(protectedFile)).toBe(true);
      await expectPhysicalPurgeRejectionAudit("REL-KC09-WRITER", "CTO-KC09", "ERR-WS-SESSIONS-OPEN");
    } finally {
      await completeSession(db, "KC09-WRITER-SESSION-DONE", {
        sessionId: "SESSION-KC09-WRITER",
        outcome: "succeeded",
      });
    }
  });

  it("purges an expired governed scope on disk and records an empty-residue report", async () => {
    const protectedFile = await materializePurgeFixture("REL-KC09-DRILL");
    const { report, error } = await purgeReleaseScopeOnDisk({
      db,
      rootAbs,
      repoPath,
      releaseId: "REL-KC09-DRILL",
      actor: "CTO-KC09",
    });
    expect(error).toBeUndefined();
    expect(existsSync(protectedFile)).toBe(false);
    expect(report.residue).toEqual([]);
    expect(report.purgedScope).toEqual(["releases/REL-KC09-DRILL/ws/business-content.txt"]);
    const result = await recordWorkspacePurge(db, "KC09-PURGE-DRILL", {
      workspaceId: "WS-KC09-DRILL",
      actorId: "CTO-KC09",
      outcome: "purged",
      report,
    });
    expect(result["state"]).toBe("PURGED");
  });

  it("permits purge after retention expiry when no hold is active", async () => {
    const result = await recordWorkspacePurge(db, "KC09-PURGE-EXPIRED", {
      workspaceId: "WS-KC09-EXPIRED",
      actorId: "CTO-KC09",
      outcome: "purged",
      report: purgeReport("REL-KC09-EXPIRED"),
    });
    expect(result["state"]).toBe("PURGED");
  });

  it("records purge failure as blocked-security and keeps every resource reserved", async () => {
    const result = await recordWorkspacePurge(db, "KC09-PURGE-FAIL", {
      workspaceId: "WS-KC09-FAIL",
      actorId: "CTO-KC09",
      outcome: "failed",
      failure: {
        reason: "simulated post-delete residue",
        leftoverScope: ["releases/REL-KC09-FAIL/ws/residue.bin"],
        correctiveAction: {
          owner: "security-operator",
          dueMs: 3_600_000,
          scope: ["releases/REL-KC09-FAIL/ws/residue.bin"],
          state: "open",
        },
      },
    });
    expect(result).toMatchObject({ state: "PURGE_BLOCKED", securityStatus: "blocked-security" });
    const rows = (await db.execute(sql`
      SELECT w.state, w.purge_failure ->> 'securityStatus' AS security_status,
             array_agg(r.state ORDER BY r.resource_type) AS resource_states
      FROM dopaios_workspaces w
      JOIN dopaios_workspace_resources r ON r.workspace_id = w.id
      WHERE w.id = 'WS-KC09-FAIL'
      GROUP BY w.state, w.purge_failure
    `)) as unknown as Array<{ state: string; security_status: string; resource_states: string[] }>;
    expect(rows).toEqual([{
      state: "PURGE_BLOCKED",
      security_status: "blocked-security",
      resource_states: ["reserved", "reserved", "reserved"],
    }]);
  });

  it("replays retention, hold, purge, and blocked-security projections byte-identically", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
