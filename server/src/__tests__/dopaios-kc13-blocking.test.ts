import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  replayProjections,
  snapshotProjections,
  CommandPayloadMismatchError,
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
  activateRelease,
  AI_ROLES,
} from "../dopaios/routing.ts";
import { routeWorkItem } from "../dopaios/router.ts";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
} from "../dopaios/approval.ts";

// KC-13 B6: bộ ca chặn tổng hợp KC13-B01…B12, mỗi ca một test mang đúng case
// id, kèm vệt audit bất biến (SQR-001). Nguồn từng ca ghi ngay tại test:
// AC-FR-8.3, AC-FR-15.3, AC-FR-69.1…69.4, FR-46 (độc lập), SFR-023 (AI không
// phê duyệt — cả đường Manifest, đường quản trị Staff lẫn approval engine
// KC-03), SFR-038/039 (idempotency), FS-001 SFR-003 (khóa cửa — FX-01-C13 đã
// kiểm ở B2, không lặp).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-13 B6 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "d".repeat(64);
const TEMPLATE = { template_id: "BOOTSTRAP-PROJECT-TEMPLATE-001", revision: 1, sha256: SHA };

function roleMap(): Record<string, { primary: string; fallback: string }> {
  return Object.fromEntries(
    AI_ROLES.map((role) => [role, { primary: `AI-${role}`, fallback: `AI-${role}-FB` }]),
  );
}

function manifestPayload(overrides: Record<string, unknown> = {}): {
  manifestId: string;
  stage: string;
  projectId: string;
  actor: string;
  poolRef: { poolId: string; revision: number };
  roleAssignments: Record<string, { primary: string; fallback: string }>;
  pod: string;
  capacity: Record<string, number>;
  permissions: string[];
  resources: string[];
  routingRules: Record<string, unknown>;
  sha256: string;
} {
  return {
    manifestId: "TM-B6",
    stage: "bootstrap",
    projectId: "PRJ-B6",
    actor: "ORCH-1",
    poolRef: { poolId: "POOL-B6", revision: 1 },
    roleAssignments: roleMap(),
    pod: "POD-1",
    capacity: Object.fromEntries(AI_ROLES.map((r) => [r, 2])),
    permissions: ["repo-read"],
    resources: ["workspace"],
    routingRules: { mode: "manifest-pinned" },
    sha256: SHA,
    ...(overrides as object),
  };
}

describeEmbeddedPostgres("dopaios KC-13 B6 — bộ ca chặn KC13-B01…B12", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let seq = 0;
  const cmd = (label: string) => `KC13-B6-${label}-${++seq}`;

  async function expectAudited(commandId: string): Promise<void> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE stream_name = ${"dopaiosAudit-" + commandId} AND type = 'CommandRejected'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n, `audit for ${commandId}`).toBe(1);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc13-b6-");
    db = createDb(tempDb.connectionString);

    await registerActor(db, cmd("actor"), {
      actorId: "ORCH-1",
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
    // AI actor cầm ĐỦ capability nhạy cảm — mọi đường quyết định vẫn phải chặn.
    await registerActor(db, cmd("actor"), {
      actorId: "AI-SUPER",
      kind: "other",
      active: true,
      capabilities: ["orchestrator", "staff-admin", "governance-approver"],
    });
    await registerActor(db, cmd("actor"), {
      actorId: "STAFF-AUTHOR",
      kind: "human",
      active: true,
      capabilities: ["product-governance"],
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
        });
      }
    }
    // Staff hợp lệ trong SỔ công ty nhưng sẽ không được pin vào Manifest.
    await registerStaffAi(db, cmd("staff"), {
      staffId: "AI-UNPINNED",
      actor: "ADMIN-1",
      workStatus: "active",
      capabilities: ["ai-spec"],
      skills: ["spike"],
      permissions: ["repo-read"],
      resources: ["workspace"],
      capacityLimit: 2,
    });

    await createProjectShell(db, cmd("shell"), {
      projectId: "PRJ-B6",
      actor: "ADMIN-1",
      templateRef: TEMPLATE,
      expectedTemplateSha256: SHA,
      orchestrator: "ORCH-1",
    });
    await pinStartupPool(db, cmd("pool"), {
      poolId: "POOL-B6",
      actor: "ADMIN-1",
      roles: roleMap(),
      readiness: "ready",
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("KC13-B01 — pool thiếu một trong năm vai bị chặn (AC-FR-69.1)", async () => {
    const roles = roleMap();
    delete roles["AI-Test"];
    const id = cmd("b01");
    await expect(
      pinStartupPool(db, id, { poolId: "POOL-BAD", actor: "ADMIN-1", roles, readiness: "ready" }),
    ).rejects.toMatchObject({ code: "ERR-ROLE-MISSING" });
    await expectAudited(id);
  });

  it("KC13-B02 — Manifest gán Staff ngoài pool đã pin bị chặn (AC-FR-8.3)", async () => {
    const roles = roleMap();
    roles["AI-Spec"] = { primary: "AI-UNPINNED", fallback: "AI-AI-Spec-FB" };
    const id = cmd("b02");
    await expect(
      proposeTeamManifest(db, id, manifestPayload({ roleAssignments: roles })),
    ).rejects.toMatchObject({ code: "ERR-OUTSIDE-POOL" });
    await expectAudited(id);
  });

  it("KC13-B03 — reviewer trùng builder vi phạm độc lập bị chặn (FR-46/FR-69)", async () => {
    const roles = roleMap();
    roles["AI-Reviewer"] = { primary: "AI-AI-Build", fallback: "AI-AI-Reviewer-FB" };
    const id = cmd("b03");
    await expect(
      proposeTeamManifest(db, id, manifestPayload({ roleAssignments: roles })),
    ).rejects.toMatchObject({ code: "ERR-INDEPENDENCE" });
    await expectAudited(id);
  });

  it("KC13-B07 — AI đề xuất Team Manifest bị chặn dù cầm capability orchestrator (SFR-023)", async () => {
    const id = cmd("b07");
    await expect(
      proposeTeamManifest(db, id, manifestPayload({ actor: "AI-SUPER" })),
    ).rejects.toMatchObject({ code: "SFR-023" });
    await expectAudited(id);
  });

  it("KC13-B08 — AI cầm staff-admin không tự thêm thành viên/pin pool được (AC-FR-69.3)", async () => {
    const regId = cmd("b08-reg");
    await expect(
      registerStaffAi(db, regId, {
        staffId: "AI-SELF-ADDED",
        actor: "AI-SUPER",
        workStatus: "active",
        capabilities: ["ai-lead"],
        skills: [],
        permissions: [],
        resources: [],
        capacityLimit: 1,
      }),
    ).rejects.toMatchObject({ code: "SFR-023" });
    await expectAudited(regId);

    const poolId = cmd("b08-pool");
    await expect(
      pinStartupPool(db, poolId, {
        poolId: "POOL-AI",
        actor: "AI-SUPER",
        roles: roleMap(),
        readiness: "ready",
      }),
    ).rejects.toMatchObject({ code: "SFR-023" });
    await expectAudited(poolId);
  });

  it("KC13-B09 — P0-01 thiếu cặp hồ sơ bị chặn (AC-FR-69.2)", async () => {
    // Chưa có Manifest nào được duyệt cho PRJ-B6.
    const noManifest = cmd("b09-manifest");
    await expect(
      approveProjectInitiation(db, noManifest, {
        projectId: "PRJ-B6",
        actor: "ORCH-1",
        initiationRequest: { id: "PIR-B6", sha256: SHA },
        manifestId: "TM-B6",
        manifestRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR-MANIFEST-STATE" });
    await expectAudited(noManifest);

    await proposeTeamManifest(db, cmd("propose"), manifestPayload());
    await approveTeamManifest(db, cmd("approve"), { manifestId: "TM-B6", revision: 1, actor: "ORCH-1" });

    // Manifest đã duyệt nhưng thiếu pin Initiation Request → vẫn chặn.
    const noPir = cmd("b09-pir");
    await expect(
      approveProjectInitiation(db, noPir, {
        projectId: "PRJ-B6",
        actor: "ORCH-1",
        initiationRequest: { id: "", sha256: "" },
        manifestId: "TM-B6",
        manifestRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "ERR-002" });
    await expectAudited(noPir);

    await approveProjectInitiation(db, cmd("p0"), {
      projectId: "PRJ-B6",
      actor: "ORCH-1",
      initiationRequest: { id: "PIR-B6", sha256: SHA },
      manifestId: "TM-B6",
      manifestRevision: 1,
    });
  });

  it("KC13-B04 — hết đường trong danh sách pin: chặn, không giao người làm thay (AC-FR-69.3)", async () => {
    await createProjectWorkItem(db, cmd("wi"), {
      workItemId: "WI-B04",
      projectId: "PRJ-B6",
      role: "AI-Test",
    });
    await setStaffAiStatus(db, cmd("deact-1"), { staffId: "AI-AI-Test", actor: "ADMIN-1", workStatus: "inactive" });
    await setStaffAiStatus(db, cmd("deact-2"), { staffId: "AI-AI-Test-FB", actor: "ADMIN-1", workStatus: "inactive" });
    const id = cmd("b04");
    await expect(routeWorkItem(db, id, { workItemId: "WI-B04" })).rejects.toMatchObject({
      code: "ERR-ROUTE-EXHAUSTED",
    });
    await expectAudited(id);
    // Work-item vẫn chưa có assignee nào — không ai (người hay AI ngoài đội)
    // được "làm thay".
    const row = (await db.execute(
      sql`SELECT routed_to, executor FROM dopaios_work_items WHERE id = 'WI-B04'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(row).toEqual([{ routed_to: null, executor: null }]);
    await setStaffAiStatus(db, cmd("react-1"), { staffId: "AI-AI-Test", actor: "ADMIN-1", workStatus: "active" });
    await setStaffAiStatus(db, cmd("react-2"), { staffId: "AI-AI-Test-FB", actor: "ADMIN-1", workStatus: "active" });
  });

  it("KC13-B05 — override trỏ người làm assignee bị chặn (AC-FR-15.3)", async () => {
    const id = cmd("b05");
    await expect(
      routeWorkItem(db, id, {
        workItemId: "WI-B04",
        override: { staffId: "ORCH-1", reason: "người làm thay", actor: "ORCH-1" },
      }),
    ).rejects.toMatchObject({ code: "ERR-OUTSIDE-MANIFEST" });
    await expectAudited(id);
  });

  it("KC13-B06 — Staff trong sổ công ty nhưng chưa pin vào Manifest không có quyền chạy (AC-FR-8.3)", async () => {
    const id = cmd("b06");
    await expect(
      routeWorkItem(db, id, {
        workItemId: "WI-B04",
        override: { staffId: "AI-UNPINNED", reason: "lấy từ inventory", actor: "ORCH-1" },
      }),
    ).rejects.toMatchObject({ code: "ERR-OUTSIDE-MANIFEST" });
    await expectAudited(id);
  });

  it("KC13-B10 — thiếu Team Manifest delivery được duyệt thì Release bị chặn (AC-FR-69.4)", async () => {
    const id = cmd("b10");
    await expect(
      activateRelease(db, id, { projectId: "PRJ-B6", releaseId: "REL-1", actor: "ORCH-1" }),
    ).rejects.toMatchObject({ code: "ERR-DELIVERY-MANIFEST" });
    await expectAudited(id);

    // Duyệt Manifest delivery (Orchestrator stand-in đề xuất — giới hạn ghi
    // hồ sơ; người duyệt đúng chuẩn là Orchestrator) rồi Release mở.
    await proposeTeamManifest(
      db,
      cmd("delivery"),
      manifestPayload({ manifestId: "TM-B6-DLV", stage: "delivery" }),
    );
    await approveTeamManifest(db, cmd("approve-dlv"), {
      manifestId: "TM-B6-DLV",
      revision: 1,
      actor: "ORCH-1",
    });
    const activated = await activateRelease(db, cmd("release-ok"), {
      projectId: "PRJ-B6",
      releaseId: "REL-1",
      actor: "ORCH-1",
    });
    expect(activated).toMatchObject({ releaseId: "REL-1", manifest: { id: "TM-B6-DLV", revision: 1 } });
  });

  it("KC13-B11 — cùng command_id với payload khác bị từ chối (SFR-038/039)", async () => {
    const id = cmd("b11");
    await createProjectWorkItem(db, id, { workItemId: "WI-B11", projectId: "PRJ-B6", role: "AI-Lead" });
    await expect(
      createProjectWorkItem(db, id, { workItemId: "WI-B11-KHAC", projectId: "PRJ-B6", role: "AI-Lead" }),
    ).rejects.toBeInstanceOf(CommandPayloadMismatchError);
    // Cùng id cùng payload → trả kết quả cũ, không tạo bản ghi thứ hai.
    const replay = await createProjectWorkItem(db, id, {
      workItemId: "WI-B11",
      projectId: "PRJ-B6",
      role: "AI-Lead",
    });
    expect(replay).toMatchObject({ idempotentReplay: true });
  });

  it("KC13-B12 — AI cầm governance-approver gọi approval engine KC-03 vẫn bị chặn (SFR-023)", async () => {
    await pinSeparationPolicy(db, cmd("policy"), {
      policyId: "SEP-DOC-B6",
      artifactType: "governance-doc",
      revision: 1,
      policy: {
        policy_id: "SEP-DOC-B6",
        scope_level: "company",
        approver_capability: "governance-approver",
        effective_at: "2026-08-01T00:00:00Z",
        invalidation_rule: "revision-superseded",
      },
      pinnedBy: "ORCH-1",
    });
    await registerDraftArtifact(db, cmd("draft"), {
      artifactId: "ART-B12",
      revision: 1,
      sha256: SHA,
      createdBy: "STAFF-AUTHOR",
      artifactType: "governance-doc",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("submit"), { artifactId: "ART-B12", revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: "PKG-B12",
      revision: 1,
      target: { artifactId: "ART-B12", revision: 1, sha256: SHA },
      refs: { evidence: "ev-B12" },
      fields: { decisionAsk: "Duyệt ART-B12?" },
    });
    const id = cmd("b12");
    await expect(
      recordApprovalDecision(db, id, {
        recordId: "REC-B12",
        packageId: "PKG-B12",
        packageRevision: 1,
        target: { artifactId: "ART-B12", revision: 1, sha256: SHA },
        outcome: "approve",
        approvedScope: { kind: "full-revision" },
        findings: [],
        nonWaivableBlockers: [],
        impactSet: [],
        downstreamChecked: [],
        pinnedRefs: { evidence: "ev-B12" },
        openedStep: "B1",
        reEntryPoint: "B0",
        actor: "AI-SUPER",
      }),
    ).rejects.toMatchObject({ code: "SFR-023" });
    await expectAudited(id);
  });

  it("replay stays byte-identical after the blocking battery (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
