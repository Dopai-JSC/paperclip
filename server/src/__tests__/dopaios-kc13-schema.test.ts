import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand, replayProjections, snapshotProjections } from "../dopaios/event-store.ts";

// KC-13 B1: schema 0509 + projector — bốn bảng định tuyến/kích hoạt mới
// (staff AI, startup pool, Team Manifest, Hợp đồng thực hiện AI) và cột lease
// trên activation dựng được thuần từ event log, replay byte-identical
// (SQR-003), TRƯỚC khi tầng lệnh với guard (B2) vào. Bài kiểm nền, chưa kiểm luật.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B1 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "e".repeat(64);

const ROLES = {
  "AI-Lead": { primary: "AI-STAFF-LEAD", fallback: "AI-STAFF-LEAD-FB" },
  "AI-Spec": { primary: "AI-STAFF-SPEC", fallback: "AI-STAFF-SPEC-FB" },
  "AI-Build": { primary: "AI-STAFF-BUILD", fallback: "AI-STAFF-BUILD-FB" },
  "AI-Test": { primary: "AI-STAFF-TEST", fallback: "AI-STAFF-TEST-FB" },
  "AI-Reviewer": { primary: "AI-STAFF-REV", fallback: "AI-STAFF-REV-FB" },
};

describeEmbeddedPostgres("dopaios KC-13 B1 — schema 0509 + projector", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b1-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("projects every new KC-13 event type from the log", async () => {
    await executeCommand(db, {
      commandId: "KC13-B1-SEED",
      payload: { batch: "B1" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosStaffAi-AI-STAFF-LEAD",
          type: "StaffAiRegistered",
          data: {
            staffId: "AI-STAFF-LEAD",
            workStatus: "active",
            capabilities: ["ai-lead"],
            skills: ["orchestration"],
            permissions: ["repo-read"],
            resources: ["workspace"],
            autonomyLimits: { maxLoops: 3 },
            modelVersion: "claude-fable-5",
            capacityLimit: 2,
            profileRevision: 1,
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosStaffAi-AI-STAFF-LEAD",
          type: "StaffAiStatusChanged",
          data: { staffId: "AI-STAFF-LEAD", workStatus: "inactive" },
        });
        await ctx.emit({
          streamName: "dopaiosStartupPool-POOL-KC13",
          type: "StartupPoolPinned",
          data: { poolId: "POOL-KC13", revision: 1, roles: ROLES, readiness: "ready", pinnedBy: "ORCH-1" },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosStartupPool-POOL-KC13",
          type: "StartupPoolPinned",
          data: { poolId: "POOL-KC13", revision: 2, roles: ROLES, readiness: "ready", pinnedBy: "ORCH-1" },
        });
        await ctx.emit({
          streamName: "dopaiosStartupPool-POOL-KC13",
          type: "StartupPoolRevisionStateChanged",
          data: { poolId: "POOL-KC13", revision: 1, state: "superseded" },
        });
        await ctx.emit({
          streamName: "dopaiosTeamManifest-TM-KC13",
          type: "TeamManifestProposed",
          data: {
            manifestId: "TM-KC13",
            revision: 1,
            stage: "bootstrap",
            projectId: "PRJ-KC13",
            poolRef: { poolId: "POOL-KC13", revision: 2 },
            roleAssignments: ROLES,
            orchestrator: "ORCH-1",
            pod: "POD-1",
            capacity: { "AI-Lead": 1 },
            permissions: ["repo-read"],
            resources: ["workspace"],
            routingRules: { mode: "manifest-pinned" },
            timeouts: { stepMs: 60000 },
            escalation: { onMissingInput: "action-request" },
            fallbackPaths: { "AI-Lead": "AI-STAFF-LEAD-FB" },
            costLimits: { totalUsd: 10 },
            autonomy: "bounded",
            createdBy: "ORCH-1",
            sha256: SHA,
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosTeamManifest-TM-KC13",
          type: "TeamManifestApproved",
          data: { manifestId: "TM-KC13", revision: 1, approvedBy: "ORCH-1" },
        });
        await ctx.emit({
          streamName: "dopaiosTeamManifest-TM-KC13",
          type: "TeamManifestRevisionStateChanged",
          data: { manifestId: "TM-KC13", revision: 1, state: "superseded" },
        });
        await ctx.emit({
          streamName: "dopaiosExecutionContract-XC-1",
          type: "ExecutionContractCompiled",
          data: {
            contractId: "XC-1",
            revision: 1,
            workItemId: "WI-KC13-1",
            sources: {
              sop: { id: "SOPDEF-1", revision: 1, sha256: SHA },
              manifest: { id: "TM-KC13", revision: 1, sha256: SHA },
              project: { id: "PRJ-KC13" },
              workItem: { id: "WI-KC13-1" },
            },
            fields: {
              objective: "chạy bước T1",
              scope: "fixture",
              inputs: [],
              outputs: [{ id: "OUT-1", quality: "self-check" }],
              context: [],
              permissions: ["repo-read"],
              tools: ["engine"],
              limits: { timeMs: 60000, costUsd: 1, loops: 1 },
              requiredChecks: ["self-check"],
              requiredEvidence: ["output-hash"],
              stopConditions: ["step-done"],
              escalationEvents: ["missing-input"],
              fallbackPath: "AI-STAFF-LEAD-FB",
            },
            sha256: SHA,
            compiledBy: "system-router",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosExecutionContract-XC-1",
          type: "ExecutionContractRevisionStateChanged",
          data: { contractId: "XC-1", revision: 1, state: "superseded" },
        });
        return { seeded: true };
      },
    });

    const staff = (await db.execute(
      sql`SELECT id, work_status, capacity_limit, model_version FROM dopaios_staff_ai ORDER BY id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(staff).toEqual([
      { id: "AI-STAFF-LEAD", work_status: "inactive", capacity_limit: 2, model_version: "claude-fable-5" },
    ]);

    const pools = (await db.execute(
      sql`SELECT id, revision, state FROM dopaios_startup_pools ORDER BY revision`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(pools).toEqual([
      { id: "POOL-KC13", revision: 1, state: "superseded" },
      { id: "POOL-KC13", revision: 2, state: "active" },
    ]);

    const manifests = (await db.execute(
      sql`SELECT id, revision, stage, state, approved_by,
             (approved_at IS NOT NULL) AS has_approved_at,
             (effective_at IS NOT NULL) AS has_effective_at
           FROM dopaios_team_manifests ORDER BY revision`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(manifests).toEqual([
      {
        id: "TM-KC13",
        revision: 1,
        stage: "bootstrap",
        state: "superseded",
        approved_by: "ORCH-1",
        has_approved_at: true,
        has_effective_at: true,
      },
    ]);

    const contracts = (await db.execute(
      sql`SELECT id, revision, work_item_id, state, compiled_by FROM dopaios_execution_contracts ORDER BY revision`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(contracts).toEqual([
      { id: "XC-1", revision: 1, work_item_id: "WI-KC13-1", state: "superseded", compiled_by: "system-router" },
    ]);
  });

  it("keeps lease defaults on activation rows projected from KC-02 events", async () => {
    await executeCommand(db, {
      commandId: "KC13-B1-ACT",
      payload: { batch: "B1" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosActivation-ACT-KC13-B1",
          type: "ActivationRequested",
          data: { activationId: "ACT-KC13-B1", workItemId: "WI-KC13-1", agentId: "AI-STAFF-LEAD", engine: "fake" },
          expectedVersion: -1,
        });
        return { requested: true };
      },
    });

    const rows = (await db.execute(
      sql`SELECT id, state, lease_epoch, claim_lease_until, contract_id FROM dopaios_activations WHERE id = 'ACT-KC13-B1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { id: "ACT-KC13-B1", state: "QUEUED", lease_epoch: 0, claim_lease_until: null, contract_id: null },
    ]);
  });

  it("replay rebuilds KC-13 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
    expect(Object.keys(after)).toContain("dopaios_team_manifests");
    expect(Object.keys(after)).toContain("dopaios_execution_contracts");
  });
});
