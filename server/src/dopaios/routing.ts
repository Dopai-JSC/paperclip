import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-13 B2: pool khởi động + vòng đời Team Manifest bootstrap + khóa cửa
// PREPARING. Nguồn chuẩn tắc là PRD (FR-8/FR-69/UJ-10) — FS-001/FS-003 chủ
// đích không định nghĩa Team Manifest/pool/Staff AI (đã xác nhận bằng vòng
// đọc nguồn; ghi tại hồ sơ Mục 5):
//  - pool tự nó KHÔNG có quyền chạy (FR-69) — quyền chỉ sinh khi Orchestrator
//    pin pool vào Manifest bootstrap và duyệt;
//  - bootstrap: Orchestrator CHỌN và DUYỆT (FR-8 câu 2) — người đề xuất chính
//    là người duyệt, đây là hành động trực tiếp theo khuôn P0-01/AC-FR-24.2,
//    KHÔNG đi qua Gói quyết định (khác separation rule SFR-013 của artifact
//    thường — nới lỏng có chủ đích theo đúng lời PRD, ghi hồ sơ Mục 6);
//  - AI không bao giờ là người duyệt (FS-003 SFR-023 — ranh cứng);
//  - trước approval không được tạo/kích hoạt work-item AI của Project
//    (FS-001 SFR-003 + AC-FR-69.2 — fixture FX-01-C13).

type Json = Record<string, unknown>;

// Năm vai AI của Team Manifest theo PRD FR-8/FR-69 (UJ-1).
export const AI_ROLES = ["AI-Lead", "AI-Spec", "AI-Build", "AI-Test", "AI-Reviewer"] as const;

type RoleMap = Record<string, { primary: string; fallback: string }>;

async function rows<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return (await rows<T>(ctx, query))[0];
}

// Orchestrator là Staff NGƯỜI active giữ capability orchestrator (FS-001
// SFR-011 làm khuôn eligibility; SFR-023 chặn AI giữ quyền phê duyệt).
async function requireHumanOrchestrator(ctx: CommandContext, actorId: string): Promise<void> {
  const actor = await one<{ kind: string; active: boolean; capabilities: string[] }>(
    ctx,
    sql`SELECT kind, active, capabilities FROM dopaios_actors WHERE id = ${actorId}`,
  );
  if (!actor) {
    throw new CommandRejectedError("ERR-ACTOR-UNKNOWN", `Actor ${actorId} is not registered`);
  }
  if (actor.kind !== "human") {
    throw new CommandRejectedError(
      "SFR-023",
      `Actor ${actorId} is not a human Staff — AI holds no approval authority`,
    );
  }
  if (!actor.active) {
    throw new CommandRejectedError("ERR-001", `Actor ${actorId} is not active`);
  }
  if (!actor.capabilities.includes("orchestrator")) {
    throw new CommandRejectedError("SFR-004", `Actor ${actorId} lacks capability orchestrator`);
  }
}

// Quản trị sổ Staff/pool là quyền của NGƯỜI giữ staff-admin — AI không tự
// thêm thành viên hay mở rộng đội (AC-FR-69.3; SOP Mục 2.3 qua SFR-023).
async function requireHumanStaffAdmin(ctx: CommandContext, actorId: string): Promise<void> {
  const admin = await one<{ kind: string; active: boolean; capabilities: string[] }>(
    ctx,
    sql`SELECT kind, active, capabilities FROM dopaios_actors WHERE id = ${actorId}`,
  );
  if (!admin || !admin.active || !admin.capabilities.includes("staff-admin")) {
    throw new CommandRejectedError("SFR-004", `Actor ${actorId} lacks capability staff-admin`);
  }
  if (admin.kind !== "human") {
    throw new CommandRejectedError(
      "SFR-023",
      `Actor ${actorId} is not a human Staff — AI must not expand the team (AC-FR-69.3)`,
    );
  }
}

function requireCompleteRoleMap(roles: RoleMap, context: string): void {
  for (const role of AI_ROLES) {
    const entry = roles[role];
    if (!entry || !entry.primary || !entry.fallback) {
      throw new CommandRejectedError(
        "ERR-ROLE-MISSING",
        `${context}: role ${role} must map a primary and a fallback AI staff (AC-FR-69.3)`,
      );
    }
  }
}

// Tính độc lập của reviewer (FR-46/FR-69 "độc lập"): một Staff được giữ
// nhiều vai NẾU chứng minh đủ độc lập — tối thiểu, người kiểm độc lập không
// được trùng người dựng (khớp SFR-019 reviewer ≠ executor ở tầng run).
function requireReviewerIndependence(roles: RoleMap, context: string): void {
  const reviewer = new Set([roles["AI-Reviewer"].primary, roles["AI-Reviewer"].fallback]);
  for (const builder of [roles["AI-Build"].primary, roles["AI-Build"].fallback]) {
    if (reviewer.has(builder)) {
      throw new CommandRejectedError(
        "ERR-INDEPENDENCE",
        `${context}: AI-Reviewer must be independent from AI-Build (${builder} holds both)`,
      );
    }
  }
}

function staffIdsOf(roles: RoleMap): string[] {
  return [...new Set(Object.values(roles).flatMap((r) => [r.primary, r.fallback]))];
}

async function requireActiveAiStaff(ctx: CommandContext, staffIds: string[], code: string): Promise<void> {
  for (const staffId of staffIds) {
    const staff = await one<{ work_status: string }>(
      ctx,
      sql`SELECT work_status FROM dopaios_staff_ai WHERE id = ${staffId}`,
    );
    if (!staff) {
      throw new CommandRejectedError(code, `AI staff ${staffId} is not registered`);
    }
    if (staff.work_status !== "active") {
      throw new CommandRejectedError(code, `AI staff ${staffId} is not active (${staff.work_status})`);
    }
  }
}

// ---- Staff AI registry (nguồn PRD FR-69; quản trị qua staff-admin như SFR-008) ----

export async function registerStaffAi(
  db: Db,
  commandId: string,
  payload: {
    staffId: string;
    actor: string;
    workStatus: string;
    capabilities: string[];
    skills: string[];
    permissions: string[];
    resources: string[];
    autonomyLimits?: Json;
    modelVersion?: string;
    capacityLimit: number;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await requireHumanStaffAdmin(ctx, p["actor"] as string);
      const existing = await one<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_staff_ai WHERE id = ${p["staffId"]}`,
      );
      if (existing) {
        throw new CommandRejectedError("ERR-STAFF-DUP", `AI staff ${p["staffId"]} already registered`);
      }
      await ctx.emit({
        streamName: `dopaiosStaffAi-${p["staffId"]}`,
        type: "StaffAiRegistered",
        data: {
          staffId: p["staffId"],
          workStatus: p["workStatus"],
          capabilities: p["capabilities"],
          skills: p["skills"],
          permissions: p["permissions"],
          resources: p["resources"],
          autonomyLimits: p["autonomyLimits"] ?? null,
          modelVersion: p["modelVersion"] ?? null,
          capacityLimit: p["capacityLimit"],
          profileRevision: 1,
        },
        metadata: { commandId, audit: true },
        expectedVersion: -1,
      });
      return { staffId: p["staffId"] as string };
    },
  });
}

export async function setStaffAiStatus(
  db: Db,
  commandId: string,
  payload: { staffId: string; actor: string; workStatus: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await requireHumanStaffAdmin(ctx, p["actor"] as string);
      const staff = await one<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_staff_ai WHERE id = ${p["staffId"]}`,
      );
      if (!staff) {
        throw new CommandRejectedError("ERR-STAFF", `AI staff ${p["staffId"]} is not registered`);
      }
      await ctx.emit({
        streamName: `dopaiosStaffAi-${p["staffId"]}`,
        type: "StaffAiStatusChanged",
        data: { staffId: p["staffId"], workStatus: p["workStatus"] },
        metadata: { commandId, audit: true },
      });
      return { staffId: p["staffId"] as string, workStatus: p["workStatus"] as string };
    },
  });
}

// ---- Pool khởi động (FR-69/AC-FR-69.1) ----

export async function pinStartupPool(
  db: Db,
  commandId: string,
  payload: { poolId: string; actor: string; roles: RoleMap; readiness: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await requireHumanStaffAdmin(ctx, p["actor"] as string);
      const roles = p["roles"] as RoleMap;
      requireCompleteRoleMap(roles, `Startup pool ${p["poolId"]}`);
      await requireActiveAiStaff(ctx, staffIdsOf(roles), "ERR-POOL-STAFF");

      const prior = await rows<{ revision: number; state: string }>(
        ctx,
        sql`SELECT revision, state FROM dopaios_startup_pools WHERE id = ${p["poolId"]} ORDER BY revision`,
      );
      const revision = prior.length === 0 ? 1 : Math.max(...prior.map((r) => r.revision)) + 1;

      await ctx.emit({
        streamName: `dopaiosStartupPool-${p["poolId"]}`,
        type: "StartupPoolPinned",
        data: {
          poolId: p["poolId"],
          revision,
          roles,
          readiness: p["readiness"],
          pinnedBy: p["actor"],
        },
        metadata: { commandId, audit: true },
      });
      // Supersede nguyên tử các revision cũ còn active — cùng transaction.
      for (const r of prior.filter((r) => r.state === "active")) {
        await ctx.emit({
          streamName: `dopaiosStartupPool-${p["poolId"]}`,
          type: "StartupPoolRevisionStateChanged",
          data: { poolId: p["poolId"], revision: r.revision, state: "superseded" },
          metadata: { commandId, audit: true },
        });
      }
      return { poolId: p["poolId"] as string, revision };
    },
  });
}

// ---- Vòng đời Team Manifest bootstrap (FR-8/UJ-10) ----

export async function proposeTeamManifest(
  db: Db,
  commandId: string,
  payload: {
    manifestId: string;
    stage: string;
    projectId: string;
    actor: string;
    poolRef: { poolId: string; revision: number };
    roleAssignments: RoleMap;
    pod: string;
    capacity: Record<string, number>;
    permissions: string[];
    resources: string[];
    routingRules: Json;
    timeouts?: Json;
    escalation?: Json;
    fallbackPaths?: Json;
    costLimits?: Json;
    autonomy?: string;
    sha256: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      if (p["stage"] !== "bootstrap" && p["stage"] !== "delivery") {
        throw new CommandRejectedError("ERR-STAGE", `Unknown manifest stage ${p["stage"]}`);
      }
      const project = await one<{ state: string; orchestrator: string }>(
        ctx,
        sql`SELECT state, orchestrator FROM dopaios_projects WHERE id = ${p["projectId"]}`,
      );
      if (!project) {
        throw new CommandRejectedError("ERR-PROJECT", `Project ${p["projectId"]} not found`);
      }
      // Orchestrator ĐÃ ĐƯỢC GÁN của Project (UJ-10); actor khác bị chặn kể
      // cả khi giữ capability orchestrator. Với delivery, người đề xuất chuẩn
      // là AI-Lead (FR-8) — spike dùng Orchestrator làm stand-in đề xuất và
      // ghi giới hạn tại hồ sơ; người DUYỆT mọi stage vẫn là Orchestrator.
      await requireHumanOrchestrator(ctx, p["actor"] as string);
      if (p["actor"] !== project.orchestrator) {
        throw new CommandRejectedError(
          "ERR-ORCH-MISMATCH",
          `Actor ${p["actor"]} is not the assigned Orchestrator of ${p["projectId"]}`,
        );
      }

      const poolRef = p["poolRef"] as { poolId: string; revision: number };
      const pool = await one<{ roles: RoleMap; state: string; readiness: string }>(
        ctx,
        sql`SELECT roles, state, readiness FROM dopaios_startup_pools
            WHERE id = ${poolRef.poolId} AND revision = ${poolRef.revision}`,
      );
      if (!pool) {
        throw new CommandRejectedError(
          "ERR-POOL",
          `Startup pool ${poolRef.poolId}@${poolRef.revision} not found`,
        );
      }
      if (pool.state !== "active" || pool.readiness !== "ready") {
        throw new CommandRejectedError(
          "ERR-POOL-STATE",
          `Startup pool ${poolRef.poolId}@${poolRef.revision} is not active/ready`,
        );
      }

      const roles = p["roleAssignments"] as RoleMap;
      requireCompleteRoleMap(roles, `Team Manifest ${p["manifestId"]}`);
      requireReviewerIndependence(roles, `Team Manifest ${p["manifestId"]}`);
      // Chọn "từ danh sách đủ điều kiện": mọi Staff được gán phải nằm trong
      // pool đã pin (AC-FR-8.3 — inventory ngoài pool không đủ quyền chạy).
      const poolStaff = new Set(staffIdsOf(pool.roles));
      for (const staffId of staffIdsOf(roles)) {
        if (!poolStaff.has(staffId)) {
          throw new CommandRejectedError(
            "ERR-OUTSIDE-POOL",
            `AI staff ${staffId} is not in pinned pool ${poolRef.poolId}@${poolRef.revision} (AC-FR-8.3)`,
          );
        }
      }
      await requireActiveAiStaff(ctx, staffIdsOf(roles), "ERR-STAFF-INELIGIBLE");

      const prior = await rows<{ revision: number }>(
        ctx,
        sql`SELECT revision FROM dopaios_team_manifests WHERE id = ${p["manifestId"]} ORDER BY revision`,
      );
      const revision = prior.length === 0 ? 1 : Math.max(...prior.map((r) => r.revision)) + 1;

      await ctx.emit({
        streamName: `dopaiosTeamManifest-${p["manifestId"]}`,
        type: "TeamManifestProposed",
        data: {
          manifestId: p["manifestId"],
          revision,
          stage: p["stage"],
          projectId: p["projectId"],
          poolRef,
          roleAssignments: roles,
          orchestrator: project.orchestrator,
          pod: p["pod"],
          capacity: p["capacity"],
          permissions: p["permissions"],
          resources: p["resources"],
          routingRules: p["routingRules"],
          timeouts: p["timeouts"] ?? null,
          escalation: p["escalation"] ?? null,
          fallbackPaths: p["fallbackPaths"] ?? null,
          costLimits: p["costLimits"] ?? null,
          autonomy: p["autonomy"] ?? null,
          createdBy: p["actor"],
          sha256: p["sha256"],
        },
        metadata: { commandId, audit: true },
      });
      return { manifestId: p["manifestId"] as string, revision, state: "proposed" };
    },
  });
}

// Duyệt Manifest bootstrap: hành động trực tiếp của Orchestrator đã gán —
// người chọn đội chính là người duyệt theo lời PRD FR-8 ("Orchestrator chọn
// và duyệt revision bootstrap"). Guard đánh giá LẠI readiness tại thời điểm
// duyệt (AC-FR-8.4): pool còn active, mọi Staff được gán còn active.
export async function approveTeamManifest(
  db: Db,
  commandId: string,
  payload: { manifestId: string; revision: number; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const manifest = await one<{
        revision: number;
        stage: string;
        state: string;
        project_id: string;
        orchestrator: string;
        pool_ref: { poolId: string; revision: number };
        role_assignments: RoleMap;
      }>(
        ctx,
        sql`SELECT revision, stage, state, project_id, orchestrator, pool_ref, role_assignments
            FROM dopaios_team_manifests
            WHERE id = ${p["manifestId"]} AND revision = ${p["revision"]}`,
      );
      if (!manifest) {
        throw new CommandRejectedError(
          "ERR-MANIFEST",
          `Team Manifest ${p["manifestId"]}@${p["revision"]} not found`,
        );
      }
      if (manifest.state !== "proposed") {
        throw new CommandRejectedError(
          "ERR-MANIFEST-STATE",
          `Team Manifest ${p["manifestId"]}@${p["revision"]} is ${manifest.state}, not proposed`,
        );
      }
      const latest = await one<{ max: number }>(
        ctx,
        sql`SELECT max(revision) AS max FROM dopaios_team_manifests WHERE id = ${p["manifestId"]}`,
      );
      if (Number(latest?.max) !== Number(p["revision"])) {
        throw new CommandRejectedError(
          "SFR-027",
          `Only the latest revision of ${p["manifestId"]} may be approved`,
        );
      }
      await requireHumanOrchestrator(ctx, p["actor"] as string);
      if (p["actor"] !== manifest.orchestrator) {
        throw new CommandRejectedError(
          "ERR-ORCH-MISMATCH",
          `Actor ${p["actor"]} is not the assigned Orchestrator of ${manifest.project_id}`,
        );
      }
      // Đánh giá lại readiness tại thời điểm duyệt (AC-FR-8.4).
      const pool = await one<{ state: string; readiness: string }>(
        ctx,
        sql`SELECT state, readiness FROM dopaios_startup_pools
            WHERE id = ${manifest.pool_ref.poolId} AND revision = ${manifest.pool_ref.revision}`,
      );
      if (!pool || pool.state !== "active" || pool.readiness !== "ready") {
        throw new CommandRejectedError(
          "ERR-POOL-STATE",
          `Pinned pool ${manifest.pool_ref.poolId}@${manifest.pool_ref.revision} is no longer active/ready`,
        );
      }
      await requireActiveAiStaff(ctx, staffIdsOf(manifest.role_assignments), "ERR-STAFF-INELIGIBLE");

      await ctx.emit({
        streamName: `dopaiosTeamManifest-${p["manifestId"]}`,
        type: "TeamManifestApproved",
        data: { manifestId: p["manifestId"], revision: p["revision"], approvedBy: p["actor"] },
        metadata: { commandId, audit: true },
      });
      // Supersede nguyên tử revision approved cũ hơn (FR-8: quyết định cũ vẫn
      // gắn revision hiệu lực lúc tạo — record giữ nguyên, chỉ đổi state).
      const olderApproved = await rows<{ revision: number }>(
        ctx,
        sql`SELECT revision FROM dopaios_team_manifests
            WHERE id = ${p["manifestId"]} AND state = 'approved' AND revision <> ${p["revision"]}`,
      );
      for (const r of olderApproved) {
        await ctx.emit({
          streamName: `dopaiosTeamManifest-${p["manifestId"]}`,
          type: "TeamManifestRevisionStateChanged",
          data: { manifestId: p["manifestId"], revision: r.revision, state: "superseded" },
          metadata: { commandId, audit: true },
        });
      }
      return { manifestId: p["manifestId"] as string, revision: p["revision"], state: "approved" };
    },
  });
}

// ---- P0-01: cặp hồ sơ Initiation Request + Manifest bootstrap (AC-FR-69.2) ----

// Stub theo nguồn PRD (UJ-10, FR-1, bảng transition PRD Mục 3 d.98): FS-001
// chủ đích không có command dương ra khỏi PREPARING (thuộc DS-2). Spike cần
// bối cảnh P0 để chứng minh định tuyến; giới hạn claim ghi tại hồ sơ Mục 6.
export async function approveProjectInitiation(
  db: Db,
  commandId: string,
  payload: {
    projectId: string;
    actor: string;
    initiationRequest: { id: string; sha256: string };
    manifestId: string;
    manifestRevision: number;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const project = await one<{ state: string; orchestrator: string }>(
        ctx,
        sql`SELECT state, orchestrator FROM dopaios_projects WHERE id = ${p["projectId"]}`,
      );
      if (!project) {
        throw new CommandRejectedError("ERR-PROJECT", `Project ${p["projectId"]} not found`);
      }
      if (project.state !== "PREPARING") {
        throw new CommandRejectedError(
          "ERR-PROJECT-STATE",
          `Project ${p["projectId"]} is ${project.state}, P0-01 applies to PREPARING only`,
        );
      }
      await requireHumanOrchestrator(ctx, p["actor"] as string);
      if (p["actor"] !== project.orchestrator) {
        throw new CommandRejectedError(
          "ERR-ORCH-MISMATCH",
          `Only the assigned Orchestrator may perform P0-01 (AC-FR-1.2)`,
        );
      }
      const pir = p["initiationRequest"] as { id: string; sha256: string };
      if (!pir?.id || !pir?.sha256) {
        throw new CommandRejectedError(
          "ERR-002",
          "Project Initiation Request pin (id + sha256) is required (AC-FR-69.2)",
        );
      }
      const manifest = await one<{ stage: string; state: string; project_id: string }>(
        ctx,
        sql`SELECT stage, state, project_id FROM dopaios_team_manifests
            WHERE id = ${p["manifestId"]} AND revision = ${p["manifestRevision"]}`,
      );
      if (!manifest || manifest.state !== "approved" || manifest.stage !== "bootstrap") {
        throw new CommandRejectedError(
          "ERR-MANIFEST-STATE",
          `Team Manifest ${p["manifestId"]}@${p["manifestRevision"]} must be an approved bootstrap manifest (AC-FR-69.2)`,
        );
      }
      if (manifest.project_id !== p["projectId"]) {
        throw new CommandRejectedError(
          "ERR-MANIFEST-PROJECT",
          `Team Manifest ${p["manifestId"]} belongs to ${manifest.project_id}, not ${p["projectId"]}`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosProject-${p["projectId"]}`,
        type: "ProjectEnteredP0",
        data: {
          projectId: p["projectId"],
          initiationRequest: pir,
          manifestId: p["manifestId"],
          manifestRevision: p["manifestRevision"],
          approvedBy: p["actor"],
        },
        metadata: { commandId, audit: true },
      });
      return { projectId: p["projectId"] as string, state: "P0_ACTIVE" };
    },
  });
}

// ---- Khóa cửa PREPARING (FS-001 SFR-003, fixture FX-01-C13) ----

// Tạo work-item AI gắn Project: chỉ hệ thống tạo sau P0-01 (UJ-10 — Dopaios
// mới tạo work-item P0). Fail-closed: mọi trạng thái ngoài P0_ACTIVE chặn.
export async function createProjectWorkItem(
  db: Db,
  commandId: string,
  payload: { workItemId: string; projectId: string; role: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const project = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_projects WHERE id = ${p["projectId"]}`,
      );
      if (!project) {
        throw new CommandRejectedError("ERR-PROJECT", `Project ${p["projectId"]} not found`);
      }
      if (project.state !== "P0_ACTIVE") {
        throw new CommandRejectedError(
          "SFR-003",
          `Project ${p["projectId"]} is ${project.state} — no AI work item may exist before approval (FS-001 SFR-003)`,
        );
      }
      if (!AI_ROLES.includes(p["role"] as (typeof AI_ROLES)[number])) {
        throw new CommandRejectedError("ERR-ROLE", `Unknown AI role ${p["role"]}`);
      }
      await ctx.emit({
        streamName: `dopaiosWorkItem-${p["workItemId"]}`,
        type: "WorkItemCreated",
        data: {
          workItemId: p["workItemId"],
          runId: null,
          projectId: p["projectId"],
          state: "READY",
          executor: null,
          role: p["role"],
        },
        metadata: { commandId, audit: true },
        expectedVersion: -1,
      });
      return { workItemId: p["workItemId"] as string, state: "READY" };
    },
  });
}

// ---- Cổng Release theo stage (AC-FR-69.4) ----

// Stub kích hoạt Release: KC-13 chỉ kiểm ĐIỀU KIỆN GÁC — thiếu Team Manifest
// `delivery` được Orchestrator duyệt thì Release bị chặn. Toàn bộ nội dung
// Release còn lại (baseline, cổng B/C…) ngoài phạm vi KC này; event chỉ để
// audit, không có projection.
export async function activateRelease(
  db: Db,
  commandId: string,
  payload: { projectId: string; releaseId: string; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const project = await one<{ state: string; orchestrator: string }>(
        ctx,
        sql`SELECT state, orchestrator FROM dopaios_projects WHERE id = ${p["projectId"]}`,
      );
      if (!project) {
        throw new CommandRejectedError("ERR-PROJECT", `Project ${p["projectId"]} not found`);
      }
      await requireHumanOrchestrator(ctx, p["actor"] as string);
      if (p["actor"] !== project.orchestrator) {
        throw new CommandRejectedError(
          "ERR-ORCH-MISMATCH",
          `Actor ${p["actor"]} is not the assigned Orchestrator of ${p["projectId"]}`,
        );
      }
      const delivery = await one<{ id: string; revision: number }>(
        ctx,
        sql`SELECT id, revision FROM dopaios_team_manifests
            WHERE project_id = ${p["projectId"]} AND stage = 'delivery' AND state = 'approved'
            ORDER BY revision DESC LIMIT 1`,
      );
      if (!delivery) {
        throw new CommandRejectedError(
          "ERR-DELIVERY-MANIFEST",
          `Project ${p["projectId"]} has no approved delivery Team Manifest — Release is blocked (AC-FR-69.4)`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosRelease-${p["releaseId"]}`,
        type: "ReleaseActivationRecorded",
        data: {
          releaseId: p["releaseId"],
          projectId: p["projectId"],
          manifestId: delivery.id,
          manifestRevision: delivery.revision,
          activatedBy: p["actor"],
        },
        metadata: { commandId, audit: true },
        expectedVersion: -1,
      });
      return {
        releaseId: p["releaseId"] as string,
        manifest: { id: delivery.id, revision: delivery.revision },
      };
    },
  });
}
