import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-13 B4: router chọn Staff AI (PRD FR-15/FR-42/AC-FR-12.1). Bốn điều kiện
// kiểm tại HAI thời điểm — lúc định tuyến VÀ lúc claim (trạng thái có thể đổi
// giữa hai lúc): (1) năng lực phù hợp vai, (2) quyền còn hiệu lực, (3) năng
// lực tải còn đủ, (4) tài nguyên bắt buộc sẵn sàng. Dopaios CHỈ được chọn
// trong Staff/pool đã pin vào Team Manifest đúng giai đoạn; Orchestrator ghi
// đè được trong chính danh sách đó kèm lý do nhưng không chọn người làm
// assignee, không dùng pool ngoài Manifest, không bỏ qua điều kiện an toàn.
// Căn cứ chọn ghi tường minh vào routing_basis (FR-42 "giải thích căn cứ").

type Json = Record<string, unknown>;

type RoleEntry = { primary: string; fallback: string };

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return ((await ctx.tx.execute(query)) as unknown as T[])[0];
}

type StaffRow = {
  id: string;
  work_status: string;
  capabilities: string[];
  permissions: string[];
  resources: string[];
  capacity_limit: number;
};

type ManifestRow = {
  id: string;
  revision: number;
  role_assignments: Record<string, RoleEntry>;
  capacity: Record<string, number>;
  permissions: string[];
  resources: string[];
};

// Bốn điều kiện FR-15 cho một ứng viên. Trả về null nếu đủ; ngược lại trả lý
// do bị loại (ghi vào basis — AC-FR-15.4 "mỗi failure ghi lý do").
async function disqualify(
  ctx: CommandContext,
  staffId: string,
  role: string,
  manifest: ManifestRow,
): Promise<string | null> {
  const staff = await one<StaffRow>(
    ctx,
    sql`SELECT id, work_status, capabilities, permissions, resources, capacity_limit
        FROM dopaios_staff_ai WHERE id = ${staffId}`,
  );
  if (!staff) return `staff ${staffId} không tồn tại trong sổ Staff AI`;
  if (staff.work_status !== "active") return `staff ${staffId} không active (${staff.work_status})`;
  // (1) năng lực phù hợp vai/loại việc.
  if (!staff.capabilities.includes(role.toLowerCase())) {
    return `staff ${staffId} thiếu năng lực vai ${role}`;
  }
  // (2) quyền còn hiệu lực: đủ mọi quyền Manifest cấp cho việc.
  for (const permission of manifest.permissions) {
    if (!staff.permissions.includes(permission)) {
      return `staff ${staffId} thiếu quyền ${permission}`;
    }
  }
  // (4) tài nguyên bắt buộc sẵn sàng.
  for (const resource of manifest.resources) {
    if (!staff.resources.includes(resource)) {
      return `staff ${staffId} thiếu tài nguyên ${resource}`;
    }
  }
  // (3) năng lực tải: số lượt đang giữ (claim chưa xong) dưới trần của Staff
  // và dưới trần của vai trong Manifest.
  const load = await one<{ n: number }>(
    ctx,
    sql`SELECT count(*)::int AS n FROM dopaios_activations
        WHERE claimed_by = ${staffId} AND state = 'RUNNING'`,
  );
  const roleCap = manifest.capacity[role];
  const cap = Math.min(
    staff.capacity_limit,
    typeof roleCap === "number" ? roleCap : Number.POSITIVE_INFINITY,
  );
  if ((load?.n ?? 0) >= cap) {
    return `staff ${staffId} hết năng lực tải (${load?.n}/${cap})`;
  }
  return null;
}

export async function loadEffectiveManifest(
  ctx: CommandContext,
  projectId: string,
): Promise<ManifestRow> {
  const manifest = await one<ManifestRow>(
    ctx,
    sql`SELECT id, revision, role_assignments, capacity, permissions, resources
        FROM dopaios_team_manifests
        WHERE project_id = ${projectId} AND stage = 'bootstrap' AND state = 'approved'
        ORDER BY revision DESC LIMIT 1`,
  );
  if (!manifest) {
    throw new CommandRejectedError(
      "ERR-MANIFEST-STATE",
      `Project ${projectId} has no approved bootstrap Team Manifest`,
    );
  }
  return manifest;
}

export async function routeWorkItem(
  db: Db,
  commandId: string,
  payload: {
    workItemId: string;
    // Ghi đè của Orchestrator: chỉ trong danh sách đã pin, kèm lý do (FR-15).
    override?: { staffId: string; reason: string; actor: string };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workItem = await one<{
        state: string;
        project_id: string | null;
        role: string | null;
        routed_to: string | null;
      }>(
        ctx,
        sql`SELECT state, project_id, role, routed_to FROM dopaios_work_items
            WHERE id = ${p["workItemId"]}`,
      );
      if (!workItem) {
        throw new CommandRejectedError("ERR-WORKITEM", `Work item ${p["workItemId"]} not found`);
      }
      if (!workItem.project_id || !workItem.role) {
        throw new CommandRejectedError(
          "ERR-WORKITEM-PROJECT",
          `Work item ${p["workItemId"]} carries no Project/role — router serves Project work items`,
        );
      }
      if (workItem.state !== "READY") {
        throw new CommandRejectedError(
          "ERR-WORKITEM-STATE",
          `Work item ${p["workItemId"]} is ${workItem.state}, not READY`,
        );
      }
      const project = await one<{ state: string; orchestrator: string }>(
        ctx,
        sql`SELECT state, orchestrator FROM dopaios_projects WHERE id = ${workItem.project_id}`,
      );
      if (!project || project.state !== "P0_ACTIVE") {
        throw new CommandRejectedError(
          "SFR-003",
          `Project ${workItem.project_id} does not allow routing (state ${project?.state ?? "unknown"})`,
        );
      }
      const manifest = await loadEffectiveManifest(ctx, workItem.project_id);
      const entry = manifest.role_assignments[workItem.role];
      if (!entry) {
        throw new CommandRejectedError(
          "ERR-ROLE-MISSING",
          `Team Manifest ${manifest.id}@${manifest.revision} maps no staff for role ${workItem.role}`,
        );
      }

      const override = p["override"] as { staffId: string; reason: string; actor: string } | undefined;
      let chosen: string | null = null;
      const basis: Json = {
        manifest: { id: manifest.id, revision: manifest.revision },
        role: workItem.role,
      };

      if (override) {
        // Ghi đè: chỉ Orchestrator đã gán, chỉ trong danh sách pin của vai,
        // kèm lý do; điều kiện an toàn KHÔNG được bỏ qua.
        const actor = await one<{ kind: string; active: boolean }>(
          ctx,
          sql`SELECT kind, active FROM dopaios_actors WHERE id = ${override.actor}`,
        );
        if (!actor || actor.kind !== "human" || !actor.active || override.actor !== project.orchestrator) {
          throw new CommandRejectedError(
            "ERR-ORCH-MISMATCH",
            `Only the assigned Orchestrator may override routing`,
          );
        }
        if (!override.reason) {
          throw new CommandRejectedError("ERR-002", "Routing override requires a reason (FR-15)");
        }
        if (override.staffId !== entry.primary && override.staffId !== entry.fallback) {
          throw new CommandRejectedError(
            "ERR-OUTSIDE-MANIFEST",
            `Override target ${override.staffId} is not in the pinned list for role ${workItem.role} (AC-FR-15.3)`,
          );
        }
        const reason = await disqualify(ctx, override.staffId, workItem.role, manifest);
        if (reason) {
          throw new CommandRejectedError(
            "ERR-ROUTE-INELIGIBLE",
            `Override target fails safety conditions: ${reason}`,
          );
        }
        chosen = override.staffId;
        basis["override"] = { by: override.actor, reason: override.reason };
      } else {
        // Tự động: primary trước, fallback sau — mỗi lần loại ghi lý do.
        const primaryReason = await disqualify(ctx, entry.primary, workItem.role, manifest);
        if (primaryReason === null) {
          chosen = entry.primary;
          basis["selection"] = "primary";
        } else {
          basis["primaryRejected"] = primaryReason;
          const fallbackReason = await disqualify(ctx, entry.fallback, workItem.role, manifest);
          if (fallbackReason === null) {
            chosen = entry.fallback;
            basis["selection"] = "fallback";
          } else {
            // Cả hai đường đều hỏng: chặn + chuyển cấp, KHÔNG giao người làm
            // thay và KHÔNG mở rộng đội (AC-FR-69.3).
            throw new CommandRejectedError(
              "ERR-ROUTE-EXHAUSTED",
              `No eligible AI staff for role ${workItem.role}: primary — ${primaryReason}; fallback — ${fallbackReason}`,
            );
          }
        }
      }

      await ctx.emit({
        streamName: `dopaiosWorkItem-${p["workItemId"]}`,
        type: "WorkItemRouted",
        data: { workItemId: p["workItemId"], staffId: chosen, role: workItem.role, basis },
        metadata: { commandId, audit: true },
      });
      return { workItemId: p["workItemId"] as string, staffId: chosen, basis };
    },
  });
}

// Tái kiểm bốn điều kiện tại thời điểm claim (FR-15: "khi nhân viên đó nhận
// hoặc được tự động kích hoạt" — trạng thái có thể đã đổi từ lúc route).
export async function requireClaimEligibility(
  ctx: CommandContext,
  input: { workItemId: string; claimedBy: string },
): Promise<void> {
  const workItem = await one<{ project_id: string | null; role: string | null; routed_to: string | null }>(
    ctx,
    sql`SELECT project_id, role, routed_to FROM dopaios_work_items WHERE id = ${input.workItemId}`,
  );
  // Work-item run test (không gắn Project) giữ nguyên đường KC-01/KC-02.
  if (!workItem?.project_id || !workItem.role) return;
  if (workItem.routed_to !== input.claimedBy) {
    throw new CommandRejectedError(
      "ERR-NOT-ROUTED",
      `Work item ${input.workItemId} is routed to ${workItem.routed_to ?? "no one"}, not ${input.claimedBy}`,
    );
  }
  const manifest = await loadEffectiveManifest(ctx, workItem.project_id);
  const reason = await disqualify(ctx, input.claimedBy, workItem.role, manifest);
  if (reason) {
    throw new CommandRejectedError(
      "ERR-CLAIM-INELIGIBLE",
      `Claim re-check failed (FR-15): ${reason}`,
    );
  }
}
