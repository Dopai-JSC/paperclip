import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandContext,
  type CommandResult,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-15 B1: đồ thị phụ thuộc dùng chung ở mức work-item (QD-1/QD-2 kế hoạch
// KC-15 — CTO duyệt 01/08/2026; ADR-019 phương án C).
//
//  - Cạnh là EVENT (WorkItemDependencyDeclared) trên event store KC-01; bảng
//    dopaios_work_item_dependencies là projection thuần, tái dựng 100% khi
//    replay (SQR-003).
//  - Module này là CỬA DUY NHẤT cho mọi truy vấn traversal của Dopaios —
//    recursive CTE trên chính Postgres của event store, chạy trong transaction
//    của lệnh gọi nên đọc cùng snapshot với guard (SFR-048/049); gói một chỗ
//    để giữ đường nâng cấp Apache AGE theo ADR-019.
//  - Ba cơ chế (chặn một phần, impact set, cascade hủy) là ba cách ĐỌC trên
//    cùng một quan hệ; bảng cạnh không mang trạng thái — chặn/impact/hủy đọc
//    từ trạng thái sẵn có của KC-03/KC-14 (impact record artifact,
//    invalidated_at trên approval, dopaios_run_steps).
//  - Cạnh giới hạn trong MỘT run test (QD-4); đồ thị liên-run/liên-Release
//    ngoài phạm vi KC-15. Slice không có lệnh gỡ cạnh — đồ thị của run là
//    khai báo một lần khi dựng; ghi giới hạn tại hồ sơ.

type Json = Record<string, unknown>;

async function rows<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

// Truyền danh sách ID vào SQL qua jsonb — tránh phụ thuộc cách driver bind
// mảng; danh sách rỗng trả về tập rỗng ngay, không chạm DB.
function idList(ids: string[]): ReturnType<typeof sql> {
  return sql`SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)`;
}

// Khai một cạnh phụ thuộc: work-item hạ nguồn (workItemId) phụ thuộc
// work-item thượng nguồn (dependsOnWorkItemId). Guard hình dạng production
// (ASM-001 quyết định 1): actor đăng ký + active, hai item cùng run test đang
// RUNNING (SFR-057), không tự phụ thuộc, không trùng cạnh, không chu trình —
// fail-closed, từ chối để vệt audit, không ghi cạnh dở dang.
export async function declareWorkItemDependency(
  db: Db,
  commandId: string,
  payload: {
    workItemId: string;
    dependsOnWorkItemId: string;
    declaredBy: string;
    basis?: Json;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workItemId = p["workItemId"] as string;
      const dependsOn = p["dependsOnWorkItemId"] as string;
      if (!workItemId || !dependsOn || !p["declaredBy"]) {
        throw new CommandRejectedError("ERR-002", "Dependency declaration is missing required fields");
      }
      if (workItemId === dependsOn) {
        throw new CommandRejectedError("ERR-SELF-DEP", "A work item cannot depend on itself");
      }
      const declarer = await rows<{ active: boolean }>(
        ctx,
        sql`SELECT active FROM dopaios_actors WHERE id = ${p["declaredBy"]} AND active = true`,
      );
      if (declarer.length === 0) {
        throw new CommandRejectedError("ERR-ACTOR", "Declarer is not a registered active actor");
      }
      const items = await rows<{ id: string; state: string; run_id: string | null }>(
        ctx,
        sql`SELECT id, state, run_id FROM dopaios_work_items
            WHERE id IN (${idList([workItemId, dependsOn])})
            ORDER BY id`,
      );
      const byId = new Map(items.map((item) => [item.id, item]));
      const dependent = byId.get(workItemId);
      const upstream = byId.get(dependsOn);
      if (!dependent || !upstream) {
        throw new CommandRejectedError("ERR-TARGET", "Both work items of the edge must exist");
      }
      // QD-4: cạnh trong MỘT run test.
      if (!dependent.run_id || dependent.run_id !== upstream.run_id) {
        throw new CommandRejectedError(
          "ERR-EDGE-RUN",
          "Dependency edges stay inside a single test run (QD-4)",
        );
      }
      const run = await rows<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_sop_runs WHERE id = ${dependent.run_id}`,
      );
      if (run.length === 0 || run[0].state !== "RUNNING") {
        throw new CommandRejectedError("SFR-057", `Run ${dependent.run_id} is not RUNNING — command refused`);
      }
      // Bên phụ thuộc đã terminal thì cạnh mới vô nghĩa; thượng nguồn terminal
      // là hợp lệ (phụ thuộc đã thỏa hoặc sẽ bị chặn theo cách đọc).
      if (dependent.state === "COMPLETED" || dependent.state === "CANCELLED") {
        throw new CommandRejectedError("ERR-STATE", `Dependent work item is terminal (${dependent.state})`);
      }
      const existing = await rows<{ work_item_id: string }>(
        ctx,
        sql`SELECT work_item_id FROM dopaios_work_item_dependencies
            WHERE work_item_id = ${workItemId} AND depends_on_work_item_id = ${dependsOn}`,
      );
      if (existing.length > 0) {
        throw new CommandRejectedError("ERR-DUP-EDGE", "Dependency edge already declared");
      }
      // Chu trình: cạnh mới tạo vòng nếu thượng nguồn đã (bắc cầu) phụ thuộc
      // chính bên hạ nguồn — kiểm trên cùng snapshot, fail-closed.
      if (await wouldCreateCycle(ctx, workItemId, dependsOn)) {
        throw new CommandRejectedError(
          "ERR-CYCLE",
          `Edge ${workItemId} -> ${dependsOn} would create a dependency cycle`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosWorkItemDependency-${workItemId}-${dependsOn}`,
        type: "WorkItemDependencyDeclared",
        data: {
          workItemId,
          dependsOnWorkItemId: dependsOn,
          runId: dependent.run_id,
          declaredBy: p["declaredBy"],
          basis: p["basis"] ?? null,
        },
        expectedVersion: -1,
      });
      return { workItemId, dependsOnWorkItemId: dependsOn, runId: dependent.run_id };
    },
  });
}

// Tập hạ nguồn bắc cầu: mọi work-item phụ thuộc — trực tiếp hoặc gián tiếp —
// vào BẤT KỲ item nào trong roots (không gồm chính roots). UNION (không phải
// UNION ALL) khử trùng lặp qua điểm hợp lưu kim cương và tự kết thúc.
export async function transitiveDependents(
  ctx: CommandContext,
  roots: string[],
): Promise<string[]> {
  if (roots.length === 0) return [];
  const result = await rows<{ work_item_id: string }>(
    ctx,
    sql`WITH RECURSIVE downstream AS (
          SELECT d.work_item_id
          FROM dopaios_work_item_dependencies d
          WHERE d.depends_on_work_item_id IN (${idList(roots)})
          UNION
          SELECT d.work_item_id
          FROM dopaios_work_item_dependencies d
          JOIN downstream s ON d.depends_on_work_item_id = s.work_item_id
        )
        SELECT work_item_id FROM downstream ORDER BY work_item_id`,
  );
  return result.map((row) => row.work_item_id);
}

// Tập thượng nguồn bắc cầu: mọi work-item mà workItemId phụ thuộc — trực tiếp
// hoặc gián tiếp (không gồm chính nó).
export async function transitiveDependencies(
  ctx: CommandContext,
  workItemId: string,
): Promise<string[]> {
  const result = await rows<{ depends_on: string }>(
    ctx,
    sql`WITH RECURSIVE upstream AS (
          SELECT d.depends_on_work_item_id AS depends_on
          FROM dopaios_work_item_dependencies d
          WHERE d.work_item_id = ${workItemId}
          UNION
          SELECT d.depends_on_work_item_id
          FROM dopaios_work_item_dependencies d
          JOIN upstream s ON d.work_item_id = s.depends_on
        )
        SELECT depends_on FROM upstream ORDER BY depends_on`,
  );
  return result.map((row) => row.depends_on);
}

// Cạnh workItemId -> dependsOn tạo chu trình khi dependsOn đã (bắc cầu) phụ
// thuộc workItemId — tức workItemId nằm trong tập thượng nguồn của dependsOn.
export async function wouldCreateCycle(
  ctx: CommandContext,
  workItemId: string,
  dependsOnWorkItemId: string,
): Promise<boolean> {
  const upstreamOfTarget = await transitiveDependencies(ctx, dependsOnWorkItemId);
  return upstreamOfTarget.includes(workItemId);
}

export type UnsatisfiedDependency = {
  dependsOnWorkItemId: string;
  reason:
    | "upstream-cancelled"
    | "upstream-not-completed"
    | "no-output"
    | "output-not-effectively-approved";
};

// KC-15 B2 — cách đọc "chặn một phần" (QD-2): phụ thuộc TRỰC TIẾP chưa thỏa
// của một work-item. Một phụ thuộc thỏa khi thượng nguồn đã COMPLETED và MỌI
// dòng đầu ra nó khởi tạo/đóng góp có phiên bản HIỆN HÀNH (revision cao nhất
// của dòng — sau rework có thể thuộc work-item khác) đang APPROVED/ACCEPTED
// với Approval Record approve/AWC CHƯA VÔ HIỆU — đúng ngữ nghĩa hiệu lực
// invalidated_at của KC-14 (SFR-031/034/050), KHÔNG dựng trạng thái mới.
// Ready-check của work-item hạ nguồn gọi hàm này trong transaction lệnh; nhờ
// vậy "đúng impact set" ở mức work-item là hệ quả đọc đồ thị + hiệu lực record.
export async function unsatisfiedDependencies(
  ctx: CommandContext,
  workItemId: string,
): Promise<UnsatisfiedDependency[]> {
  const result = await rows<{
    dep: string;
    upstream_state: string;
    line_id: string | null;
    current_state: string | null;
    effective: boolean | null;
  }>(
    ctx,
    sql`WITH deps AS (
          SELECT d.depends_on_work_item_id AS dep
          FROM dopaios_work_item_dependencies d
          WHERE d.work_item_id = ${workItemId}
        ),
        lines AS (
          SELECT DISTINCT deps.dep, o.id AS line_id
          FROM deps
          JOIN dopaios_output_versions o ON o.work_item_id = deps.dep
        ),
        current_rev AS (
          SELECT l.dep, l.line_id, max(o.revision) AS revision
          FROM lines l
          JOIN dopaios_output_versions o ON o.id = l.line_id
          GROUP BY l.dep, l.line_id
        )
        SELECT deps.dep,
               u.state AS upstream_state,
               cr.line_id,
               o.state AS current_state,
               EXISTS (
                 SELECT 1 FROM dopaios_approval_records r
                 WHERE r.target_id = cr.line_id
                   AND r.target_revision = cr.revision
                   AND r.outcome IN ('approve', 'approve-with-conditions')
                   AND r.invalidated_at IS NULL
               ) AS effective
        FROM deps
        JOIN dopaios_work_items u ON u.id = deps.dep
        LEFT JOIN current_rev cr ON cr.dep = deps.dep
        LEFT JOIN dopaios_output_versions o ON o.id = cr.line_id AND o.revision = cr.revision
        ORDER BY deps.dep, cr.line_id`,
  );
  const unsatisfied = new Map<string, UnsatisfiedDependency["reason"]>();
  for (const row of result) {
    if (unsatisfied.has(row.dep)) continue;
    if (row.upstream_state === "CANCELLED") {
      unsatisfied.set(row.dep, "upstream-cancelled");
    } else if (row.upstream_state !== "COMPLETED") {
      unsatisfied.set(row.dep, "upstream-not-completed");
    } else if (row.line_id === null) {
      unsatisfied.set(row.dep, "no-output");
    } else if (
      (row.current_state !== "APPROVED" && row.current_state !== "ACCEPTED") ||
      row.effective !== true
    ) {
      unsatisfied.set(row.dep, "output-not-effectively-approved");
    }
  }
  return [...unsatisfied.entries()]
    .map(([dependsOnWorkItemId, reason]) => ({ dependsOnWorkItemId, reason }))
    .sort((a, b) => (a.dependsOnWorkItemId < b.dependsOnWorkItemId ? -1 : 1));
}
