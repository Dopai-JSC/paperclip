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
import { registerActor, createProjectShell } from "../dopaios/commands.ts";
import {
  registerStaffAi,
  setStaffAiStatus,
  pinStartupPool,
  proposeTeamManifest,
  approveTeamManifest,
  approveProjectInitiation,
  createProjectWorkItem,
  AI_ROLES,
} from "../dopaios/routing.ts";
import { requestActivation } from "../dopaios/activation.ts";

// KC-13 B2: pool khởi động + vòng đời Team Manifest bootstrap + khóa cửa
// PREPARING. Bootstrap theo lời PRD FR-8: Orchestrator CHỌN và DUYỆT — hành
// động trực tiếp, không qua Gói quyết định; AI không bao giờ là người duyệt
// (SFR-023); pool tự nó không có quyền chạy (FR-69); trước approval P0-01
// không tồn tại work-item AI hay Phiên chạy AI gắn Project (FS-001 SFR-003,
// fixture FX-01-C13).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "f".repeat(64);
const TEMPLATE = { template_id: "BOOTSTRAP-PROJECT-TEMPLATE-001", revision: 1, sha256: SHA };

function roleMap(suffix = ""): Record<string, { primary: string; fallback: string }> {
  return Object.fromEntries(
    AI_ROLES.map((role) => [
      role,
      { primary: `AI-${role}${suffix}`, fallback: `AI-${role}-FB${suffix}` },
    ]),
  );
}

describeEmbeddedPostgres("dopaios KC-13 B2 — pool, Team Manifest bootstrap, khóa cửa PREPARING", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;
  const cmd = (label: string) => `KC13-B2-${label}-${++seq}`;

  async function expectAudited(commandId: string): Promise<void> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE stream_name = ${"dopaiosAudit-" + commandId} AND type = 'CommandRejected'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n, `audit for ${commandId}`).toBe(1);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b2-");
    db = createDb(tempDb.connectionString);

    await registerActor(db, cmd("actor"), {
      actorId: "ORCH-1",
      kind: "human",
      active: true,
      capabilities: ["orchestrator"],
    });
    await registerActor(db, cmd("actor"), {
      actorId: "ORCH-2",
      kind: "human",
      active: true,
      capabilities: ["orchestrator"],
    });
    await registerActor(db, cmd("actor"), {
      actorId: "ADMIN-1",
      kind: "human",
      active: true,
      capabilities: ["staff-admin", "project-creator"],
    });
    await registerActor(db, cmd("actor"), {
      actorId: "AI-ACTOR",
      kind: "other",
      active: true,
      capabilities: ["orchestrator"],
    });

    for (const role of AI_ROLES) {
      for (const id of [`AI-${role}`, `AI-${role}-FB`]) {
        await registerStaffAi(db, cmd("staff"), {
          staffId: id,
          actor: "ADMIN-1",
          workStatus: "active",
          capabilities: [role.toLowerCase()],
          skills: ["spike"],
          permissions: ["repo-read"],
          resources: ["workspace"],
          capacityLimit: 2,
          modelVersion: "claude-fable-5",
        });
      }
    }

    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-A",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-LOCKED",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("pins the startup pool with all five AI roles and versions it", async () => {
    const result = await pinStartupPool(db, cmd("pool"), {
      poolId: "POOL-1",
      actor: "ADMIN-1",
      roles: roleMap(),
      readiness: "ready",
    });
    expect(result).toMatchObject({ poolId: "POOL-1", revision: 1 });
  });

  it("rejects a pool missing one of the five roles (AC-FR-69.3)", async () => {
    const incomplete = roleMap();
    delete incomplete["AI-Reviewer"];
    const id = cmd("pool-miss");
    await expect(
      pinStartupPool(db, id, {
        poolId: "POOL-BAD",
        actor: "ADMIN-1",
        roles: incomplete,
        readiness: "ready",
      }),
    ).rejects.toMatchObject({ code: "ERR-ROLE-MISSING" });
    await expectAudited(id);
  });

  it("blocks AI work items and AI sessions on a PREPARING project (FX-01-C13)", async () => {
    const wiCmd = cmd("locked-wi");
    await expect(
      createProjectWorkItem(db, wiCmd, {
        workItemId: "WI-LOCKED-1",
        projectId: "PRJ-LOCKED",
        role: "AI-Lead",
      }),
    ).rejects.toMatchObject({ code: "SFR-003" });
    await expectAudited(wiCmd);

    // Phòng thủ chiều sâu: kể cả khi một work-item gắn Project PREPARING đã
    // tồn tại (seed thẳng event, ngoài đường lệnh), mở Phiên chạy AI vẫn chặn.
    await executeCommand(db, {
      commandId: cmd("seed-wi"),
      payload: { seed: true },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosWorkItem-WI-LOCKED-SEED",
          type: "WorkItemCreated",
          data: {
            workItemId: "WI-LOCKED-SEED",
            runId: null,
            projectId: "PRJ-LOCKED",
            state: "READY",
            executor: null,
          },
          expectedVersion: -1,
        });
        return { seeded: true };
      },
    });
    const actCmd = cmd("locked-act");
    await expect(
      requestActivation(db, actCmd, {
        activationId: "ACT-LOCKED",
        workItemId: "WI-LOCKED-SEED",
        agentId: "AI-AI-Lead",
        engine: "fake",
      }),
    ).rejects.toMatchObject({ code: "SFR-003" });
    await expectAudited(actCmd);

    const count = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_activations WHERE id = 'ACT-LOCKED'
    `)) as unknown as Array<{ n: number }>;
    expect(count[0].n).toBe(0);
  });

  it("rejects a bootstrap manifest proposed by anyone but the assigned Orchestrator", async () => {
    const id = cmd("wrong-orch");
    await expect(
      proposeTeamManifest(db, id, {
        manifestId: "TM-A",
        stage: "bootstrap",
        projectId: "PRJ-A",
        actor: "ORCH-2",
        poolRef: { poolId: "POOL-1", revision: 1 },
        roleAssignments: roleMap(),
        pod: "POD-1",
        capacity: { "AI-Lead": 1 },
        permissions: ["repo-read"],
        resources: ["workspace"],
        routingRules: { mode: "manifest-pinned" },
        sha256: SHA,
      }),
    ).rejects.toMatchObject({ code: "ERR-ORCH-MISMATCH" });
    await expectAudited(id);
  });

  it("rejects role assignments outside the pinned pool (AC-FR-8.3)", async () => {
    await registerStaffAi(db, cmd("outsider"), {
      staffId: "AI-OUTSIDER",
      actor: "ADMIN-1",
      workStatus: "active",
      capabilities: ["ai-lead"],
      skills: ["spike"],
      permissions: ["repo-read"],
      resources: ["workspace"],
      capacityLimit: 1,
    });
    const roles = roleMap();
    roles["AI-Lead"] = { primary: "AI-OUTSIDER", fallback: "AI-AI-Lead-FB" };
    const id = cmd("outside-pool");
    await expect(
      proposeTeamManifest(db, id, {
        manifestId: "TM-A",
        stage: "bootstrap",
        projectId: "PRJ-A",
        actor: "ORCH-1",
        poolRef: { poolId: "POOL-1", revision: 1 },
        roleAssignments: roles,
        pod: "POD-1",
        capacity: { "AI-Lead": 1 },
        permissions: ["repo-read"],
        resources: ["workspace"],
        routingRules: { mode: "manifest-pinned" },
        sha256: SHA,
      }),
    ).rejects.toMatchObject({ code: "ERR-OUTSIDE-POOL" });
    await expectAudited(id);
  });

  it("runs the bootstrap manifest lifecycle: propose → approve by the same Orchestrator (FR-8)", async () => {
    const proposed = await proposeTeamManifest(db, cmd("propose"), {
      manifestId: "TM-A",
      stage: "bootstrap",
      projectId: "PRJ-A",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-1", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: { "AI-Lead": 1 },
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      timeouts: { stepMs: 60000 },
      escalation: { onMissingInput: "action-request" },
      fallbackPaths: Object.fromEntries(AI_ROLES.map((r) => [r, `AI-${r}-FB`])),
      costLimits: { totalUsd: 5 },
      autonomy: "bounded",
      sha256: SHA,
    });
    expect(proposed).toMatchObject({ manifestId: "TM-A", revision: 1, state: "proposed" });

    const aiCmd = cmd("ai-approve");
    await expect(
      approveTeamManifest(db, aiCmd, { manifestId: "TM-A", revision: 1, actor: "AI-ACTOR" }),
    ).rejects.toMatchObject({ code: "SFR-023" });
    await expectAudited(aiCmd);

    const approved = await approveTeamManifest(db, cmd("approve"), {
      manifestId: "TM-A",
      revision: 1,
      actor: "ORCH-1",
    });
    expect(approved).toMatchObject({ manifestId: "TM-A", revision: 1, state: "approved" });
  });

  it("re-checks readiness at approval time (AC-FR-8.4): inactive staff blocks approve", async () => {
    await proposeTeamManifest(db, cmd("propose-r2"), {
      manifestId: "TM-A",
      stage: "bootstrap",
      projectId: "PRJ-A",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-1", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: { "AI-Lead": 1 },
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await setStaffAiStatus(db, cmd("deact"), {
      staffId: "AI-AI-Test",
      actor: "ADMIN-1",
      workStatus: "inactive",
    });
    const id = cmd("approve-stale");
    await expect(
      approveTeamManifest(db, id, { manifestId: "TM-A", revision: 2, actor: "ORCH-1" }),
    ).rejects.toMatchObject({ code: "ERR-STAFF-INELIGIBLE" });
    await expectAudited(id);

    await setStaffAiStatus(db, cmd("react"), {
      staffId: "AI-AI-Test",
      actor: "ADMIN-1",
      workStatus: "active",
    });
    await approveTeamManifest(db, cmd("approve-r2"), { manifestId: "TM-A", revision: 2, actor: "ORCH-1" });

    const states = (await db.execute(sql`
      SELECT revision, state FROM dopaios_team_manifests WHERE id = 'TM-A' ORDER BY revision
    `)) as unknown as Array<{ revision: number; state: string }>;
    expect(states).toEqual([
      { revision: 1, state: "superseded" },
      { revision: 2, state: "approved" },
    ]);
  });

  it("only the latest revision may be approved (SFR-027)", async () => {
    await proposeTeamManifest(db, cmd("propose-r3"), {
      manifestId: "TM-A",
      stage: "bootstrap",
      projectId: "PRJ-A",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-1", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: { "AI-Lead": 1 },
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await proposeTeamManifest(db, cmd("propose-r4"), {
      manifestId: "TM-A",
      stage: "bootstrap",
      projectId: "PRJ-A",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-1", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: { "AI-Lead": 1 },
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    const id = cmd("approve-old");
    await expect(
      approveTeamManifest(db, id, { manifestId: "TM-A", revision: 3, actor: "ORCH-1" }),
    ).rejects.toMatchObject({ code: "SFR-027" });
    await expectAudited(id);
    await approveTeamManifest(db, cmd("approve-r4"), { manifestId: "TM-A", revision: 4, actor: "ORCH-1" });
  });

  it("P0-01 needs the approved bootstrap pair; work items open but activation still demands a contract pin (AC-FR-69.2 + FR-63)", async () => {
    const noPair = cmd("p0-no-manifest");
    await expect(
      approveProjectInitiation(db, noPair, {
        projectId: "PRJ-LOCKED",
        actor: "ORCH-1",
        initiationRequest: { id: "PIR-LOCKED", sha256: SHA },
        manifestId: "TM-NONE",
        manifestRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR-MANIFEST-STATE" });
    await expectAudited(noPair);

    const entered = await approveProjectInitiation(db, cmd("p0"), {
      projectId: "PRJ-A",
      actor: "ORCH-1",
      initiationRequest: { id: "PIR-A", sha256: SHA },
      manifestId: "TM-A",
      manifestRevision: 4,
    });
    expect(entered).toMatchObject({ projectId: "PRJ-A", state: "P0_ACTIVE" });

    const created = await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-P0-1",
      projectId: "PRJ-A",
      role: "AI-Lead",
    });
    expect(created).toMatchObject({ workItemId: "WI-P0-1", state: "READY" });

    // B7 (FR-63 fail-closed): work-item gắn Project không pin Hợp đồng thực
    // hiện AI thì KHÔNG mở được kích hoạt — đường dương có pin chứng minh ở
    // suite B3/B5.
    const noContract = cmd("act-no-contract");
    await expect(
      requestActivation(db, noContract, {
        activationId: "ACT-P0-1",
        workItemId: "WI-P0-1",
        agentId: "AI-AI-Lead",
        engine: "fake",
      }),
    ).rejects.toMatchObject({ code: "ERR-CONTRACT" });
    await expectAudited(noContract);

    // SC-003 (FS-001): không tồn tại work-item AI nào gắn Project PREPARING.
    const preparingItems = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM dopaios_work_items w JOIN dopaios_projects p ON p.id = w.project_id
      WHERE p.state = 'PREPARING' AND w.id <> 'WI-LOCKED-SEED'
    `)) as unknown as Array<{ n: number }>;
    expect(preparingItems[0].n).toBe(0);
  });

  it("replay stays byte-identical after the manifest lifecycle (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
