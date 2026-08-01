import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
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
import { routeWorkItem } from "../dopaios/router.ts";
import { requestActivation, claimActivation } from "../dopaios/activation.ts";

// KC-13 B4: router bốn điều kiện FR-15 tại HAI thời điểm (route và claim),
// chọn trong danh sách Manifest đã pin, primary → fallback với lý do ghi
// tường minh (FR-42/AC-FR-15.4); cả hai hỏng → chặn + không giao người làm
// thay (AC-FR-69.3); Orchestrator override chỉ trong danh sách pin kèm lý do.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "b".repeat(64);
const TEMPLATE = { template_id: "BOOTSTRAP-PROJECT-TEMPLATE-001", revision: 1, sha256: SHA };

// Hồ sơ primary theo vai được "làm hỏng" đúng MỘT điều kiện FR-15 mỗi vai —
// AI-Lead đủ cả bốn; bốn vai còn lại mỗi vai hỏng một điều kiện khác nhau.
const PRIMARY_PROFILE: Record<
  string,
  { capabilities: string[]; permissions: string[]; resources: string[]; capacityLimit: number }
> = {
  "AI-Lead": { capabilities: ["ai-lead"], permissions: ["repo-read"], resources: ["workspace"], capacityLimit: 2 },
  "AI-Spec": { capabilities: ["khac-vai"], permissions: ["repo-read"], resources: ["workspace"], capacityLimit: 2 },
  "AI-Build": { capabilities: ["ai-build"], permissions: [], resources: ["workspace"], capacityLimit: 2 },
  "AI-Test": { capabilities: ["ai-test"], permissions: ["repo-read"], resources: [], capacityLimit: 2 },
  "AI-Reviewer": { capabilities: ["ai-reviewer"], permissions: ["repo-read"], resources: ["workspace"], capacityLimit: 0 },
};

function roleMap(): Record<string, { primary: string; fallback: string }> {
  return Object.fromEntries(
    AI_ROLES.map((role) => [role, { primary: `AI-${role}`, fallback: `AI-${role}-FB` }]),
  );
}

describeEmbeddedPostgres("dopaios KC-13 B4 — router bốn điều kiện FR-15", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;
  const cmd = (label: string) => `KC13-B4-${label}-${++seq}`;

  async function expectAudited(commandId: string): Promise<void> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE stream_name = ${"dopaiosAudit-" + commandId} AND type = 'CommandRejected'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n, `audit for ${commandId}`).toBe(1);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b4-");
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

    for (const role of AI_ROLES) {
      const profile = PRIMARY_PROFILE[role];
      await registerStaffAi(db, cmd("staff"), {
        staffId: `AI-${role}`,
        actor: "ADMIN-1",
        workStatus: "active",
        capabilities: profile.capabilities,
        skills: ["spike"],
        permissions: profile.permissions,
        resources: profile.resources,
        capacityLimit: profile.capacityLimit,
      });
      await registerStaffAi(db, cmd("staff"), {
        staffId: `AI-${role}-FB`,
        actor: "ADMIN-1",
        workStatus: "active",
        capabilities: [role.toLowerCase()],
        skills: ["spike"],
        permissions: ["repo-read"],
        resources: ["workspace"],
        capacityLimit: 2,
      });
    }

    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-B4",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await pinStartupPool(db, cmd("pool"), {
      poolId: "POOL-B4",
      actor: "ADMIN-1",
      roles: roleMap(),
      readiness: "ready",
    });
    await proposeTeamManifest(db, cmd("manifest"), {
      manifestId: "TM-B4",
      stage: "bootstrap",
      projectId: "PRJ-B4",
      actor: "ORCH-1",
      poolRef: { poolId: "POOL-B4", revision: 1 },
      roleAssignments: roleMap(),
      pod: "POD-1",
      capacity: { "AI-Lead": 2, "AI-Spec": 2, "AI-Build": 2, "AI-Test": 2, "AI-Reviewer": 2 },
      permissions: ["repo-read"],
      resources: ["workspace"],
      routingRules: { mode: "manifest-pinned" },
      sha256: SHA,
    });
    await approveTeamManifest(db, cmd("approve"), { manifestId: "TM-B4", revision: 1, actor: "ORCH-1" });
    await approveProjectInitiation(db, cmd("p0"), {
      projectId: "PRJ-B4",
      actor: "ORCH-1",
      initiationRequest: { id: "PIR-B4", sha256: SHA },
      manifestId: "TM-B4",
      manifestRevision: 1,
    });

    for (const role of AI_ROLES) {
      await createProjectWorkItem(db, cmd("wi"), {
        workItemId: `WI-${role}`,
        projectId: "PRJ-B4",
        role,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("routes to the primary with an explicit basis when all four conditions hold (FR-42)", async () => {
    const result = await routeWorkItem(db, cmd("route-lead"), { workItemId: "WI-AI-Lead" });
    expect(result).toMatchObject({ staffId: "AI-AI-Lead" });
    const row = (await db.execute(sql`
      SELECT routed_to, routing_basis FROM dopaios_work_items WHERE id = 'WI-AI-Lead'
    `)) as unknown as Array<{ routed_to: string; routing_basis: Record<string, unknown> }>;
    expect(row[0].routed_to).toBe("AI-AI-Lead");
    expect(row[0].routing_basis).toMatchObject({
      selection: "primary",
      role: "AI-Lead",
      manifest: { id: "TM-B4", revision: 1 },
    });
  });

  it("falls back with the disqualification reason logged — one test per FR-15 condition", async () => {
    const expectations: Array<{ role: string; reasonPart: string }> = [
      { role: "AI-Spec", reasonPart: "thiếu năng lực vai" },
      { role: "AI-Build", reasonPart: "thiếu quyền repo-read" },
      { role: "AI-Test", reasonPart: "thiếu tài nguyên workspace" },
      { role: "AI-Reviewer", reasonPart: "hết năng lực tải" },
    ];
    for (const { role, reasonPart } of expectations) {
      const result = await routeWorkItem(db, cmd(`route-${role}`), { workItemId: `WI-${role}` });
      expect(result, role).toMatchObject({ staffId: `AI-${role}-FB` });
      const row = (await db.execute(sql`
        SELECT routing_basis FROM dopaios_work_items WHERE id = ${"WI-" + role}
      `)) as unknown as Array<{ routing_basis: { selection: string; primaryRejected: string } }>;
      expect(row[0].routing_basis.selection, role).toBe("fallback");
      expect(row[0].routing_basis.primaryRejected, role).toContain(reasonPart);
    }
  });

  it("blocks when both primary and fallback fail — no human substitute, no team expansion (AC-FR-69.3)", async () => {
    await setStaffAiStatus(db, cmd("deact-fb"), {
      staffId: "AI-AI-Spec-FB",
      actor: "ADMIN-1",
      workStatus: "inactive",
    });
    await createProjectWorkItem(db, cmd("wi-extra"), {
      workItemId: "WI-Spec-2",
      projectId: "PRJ-B4",
      role: "AI-Spec",
    });
    const id = cmd("route-exhausted");
    await expect(routeWorkItem(db, id, { workItemId: "WI-Spec-2" })).rejects.toMatchObject({
      code: "ERR-ROUTE-EXHAUSTED",
    });
    await expectAudited(id);
    await setStaffAiStatus(db, cmd("react-fb"), {
      staffId: "AI-AI-Spec-FB",
      actor: "ADMIN-1",
      workStatus: "active",
    });
  });

  it("lets the Orchestrator override only inside the pinned list, with a reason, safety intact", async () => {
    const byOther = cmd("override-other");
    await expect(
      routeWorkItem(db, byOther, {
        workItemId: "WI-Spec-2",
        override: { staffId: "AI-AI-Spec-FB", reason: "ưu tiên fallback", actor: "ORCH-2" },
      }),
    ).rejects.toMatchObject({ code: "ERR-ORCH-MISMATCH" });
    await expectAudited(byOther);

    const noReason = cmd("override-no-reason");
    await expect(
      routeWorkItem(db, noReason, {
        workItemId: "WI-Spec-2",
        override: { staffId: "AI-AI-Spec-FB", reason: "", actor: "ORCH-1" },
      }),
    ).rejects.toMatchObject({ code: "ERR-002" });
    await expectAudited(noReason);

    // "Không chọn người làm assignee, không dùng pool ngoài Manifest": đích
    // là con người hoặc AI ngoài danh sách pin đều rơi cùng nhánh chặn.
    const toHuman = cmd("override-human");
    await expect(
      routeWorkItem(db, toHuman, {
        workItemId: "WI-Spec-2",
        override: { staffId: "ORCH-1", reason: "làm thay", actor: "ORCH-1" },
      }),
    ).rejects.toMatchObject({ code: "ERR-OUTSIDE-MANIFEST" });
    await expectAudited(toHuman);

    // Override không được bỏ qua điều kiện an toàn: primary AI-Spec thiếu
    // năng lực vai — Orchestrator trỏ vào nó vẫn bị chặn.
    const unsafe = cmd("override-unsafe");
    await expect(
      routeWorkItem(db, unsafe, {
        workItemId: "WI-Spec-2",
        override: { staffId: "AI-AI-Spec", reason: "cứ dùng primary", actor: "ORCH-1" },
      }),
    ).rejects.toMatchObject({ code: "ERR-ROUTE-INELIGIBLE" });
    await expectAudited(unsafe);

    const valid = await routeWorkItem(db, cmd("override-ok"), {
      workItemId: "WI-Spec-2",
      override: { staffId: "AI-AI-Spec-FB", reason: "ưu tiên fallback đã kiểm", actor: "ORCH-1" },
    });
    expect(valid).toMatchObject({ staffId: "AI-AI-Spec-FB" });
    const row = (await db.execute(sql`
      SELECT routing_basis FROM dopaios_work_items WHERE id = 'WI-Spec-2'
    `)) as unknown as Array<{ routing_basis: { override: { by: string; reason: string } } }>;
    expect(row[0].routing_basis.override).toEqual({ by: "ORCH-1", reason: "ưu tiên fallback đã kiểm" });
  });

  it("re-checks the four conditions at claim time (FR-15 two checkpoints)", async () => {
    await requestActivation(db, cmd("act"), {
      activationId: "ACT-LEAD",
      workItemId: "WI-AI-Lead",
      agentId: "AI-AI-Lead",
      engine: "fake",
    });

    // Claimer khác Staff đã định tuyến → chặn.
    const wrongClaimer = cmd("claim-wrong");
    await expect(
      claimActivation(db, wrongClaimer, { activationId: "ACT-LEAD", claimedBy: "AI-AI-Lead-FB" }),
    ).rejects.toMatchObject({ code: "ERR-NOT-ROUTED" });
    await expectAudited(wrongClaimer);

    // Trạng thái đổi giữa route và claim: Staff bị ngừng hoạt động → claim chặn.
    await setStaffAiStatus(db, cmd("deact-lead"), {
      staffId: "AI-AI-Lead",
      actor: "ADMIN-1",
      workStatus: "inactive",
    });
    const stale = cmd("claim-stale");
    await expect(
      claimActivation(db, stale, { activationId: "ACT-LEAD", claimedBy: "AI-AI-Lead" }),
    ).rejects.toMatchObject({ code: "ERR-CLAIM-INELIGIBLE" });
    await expectAudited(stale);

    await setStaffAiStatus(db, cmd("react-lead"), {
      staffId: "AI-AI-Lead",
      actor: "ADMIN-1",
      workStatus: "active",
    });
    const claimed = await claimActivation(db, cmd("claim-ok"), {
      activationId: "ACT-LEAD",
      claimedBy: "AI-AI-Lead",
    });
    expect(claimed).toMatchObject({ activationId: "ACT-LEAD", state: "RUNNING" });
  });

  it("replay stays byte-identical after routing decisions (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
