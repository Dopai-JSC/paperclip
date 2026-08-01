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
      const declarer = await rows<{ active: boolean; capabilities: string[] }>(
        ctx,
        sql`SELECT active, capabilities FROM dopaios_actors WHERE id = ${p["declaredBy"]} AND active = true`,
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
      const run = await rows<{ state: string; decider: string }>(
        ctx,
        sql`SELECT state, decider FROM dopaios_sop_runs WHERE id = ${dependent.run_id}`,
      );
      if (run.length === 0 || run[0].state !== "RUNNING") {
        throw new CommandRejectedError("SFR-057", `Run ${dependent.run_id} is not RUNNING — command refused`);
      }
      // B5 (major review lens 1): khai cạnh là quyền cấu trúc của run —
      // không phải mọi actor active; chỉ người quyết định được pin của run
      // hoặc người giữ capability orchestrator (đường sinh cạnh production
      // từ định nghĩa SOP thuộc KC-06/FS-004).
      if (
        (p["declaredBy"] as string) !== run[0].decider &&
        !declarer[0].capabilities.includes("orchestrator")
      ) {
        throw new CommandRejectedError(
          "ERR-AUTH",
          "Declaring a dependency requires the pinned run decider or an orchestrator capability",
        );
      }
      // Bên phụ thuộc đã terminal thì cạnh mới vô nghĩa.
      if (dependent.state === "COMPLETED" || dependent.state === "CANCELLED") {
        throw new CommandRejectedError("ERR-STATE", `Dependent work item is terminal (${dependent.state})`);
      }
      // B5 (major review lens 1): cạnh bảo đảm deadlock bị chặn TẠI CỬA —
      // thượng nguồn CANCELLED không bao giờ thỏa; thượng nguồn COMPLETED mà
      // không có dòng đầu ra nào cũng không bao giờ thỏa (item terminal không
      // tạo thêm đầu ra, slice không có lệnh gỡ cạnh).
      if (upstream.state === "CANCELLED") {
        throw new CommandRejectedError("ERR-STATE", "Upstream work item is CANCELLED — the edge can never be satisfied");
      }
      if (upstream.state === "COMPLETED") {
        const upstreamOutputs = await rows<{ n: number }>(
          ctx,
          sql`SELECT count(*)::int AS n FROM dopaios_output_versions WHERE work_item_id = ${dependsOn}`,
        );
        if ((upstreamOutputs[0]?.n ?? 0) === 0) {
          throw new CommandRejectedError(
            "ERR-STATE",
            "Upstream work item is COMPLETED with no output line — the edge can never be satisfied",
          );
        }
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
      // B5 (minor cả hai lens): delimiter "=>" giữ tên stream đơn ánh với ID
      // chứa dấu gạch ngang — hai cạnh khác nhau không thể trùng stream.
      await ctx.emit({
        streamName: `dopaiosWorkItemDependency-${workItemId}=>${dependsOn}`,
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

// KC-15 B3 — cách đọc "impact set" (QD-2): phần bị ảnh hưởng TRỰC TIẾP ở trục
// run khi một artifact nguồn đổi nghĩa là các phiên bản đầu ra HIỆN HÀNH
// (revision cao nhất của dòng) pin artifact đó trong source_refs (pin FS-002,
// QD-4); hạ nguồn bắc cầu đọc bằng transitiveDependents trên bảng cạnh.
export async function currentOutputsPinningSource(
  ctx: CommandContext,
  artifactId: string,
): Promise<
  Array<{ outputId: string; revision: number; state: string; workItemId: string; runId: string | null }>
> {
  // B5 (blocker review lens 1): impact set trục run KHÔNG chứa run terminal —
  // SFR-057 cấm mọi sự kiện nội bộ trên record thuộc run đã COMPLETED/
  // CANCELLED; nghĩa vụ của run terminal đã chốt bằng disposition record hủy.
  // jsonb_typeof (lens 2): source_refs không phải mảng thì bỏ qua — phòng
  // event dị dạng làm hỏng traversal vĩnh viễn.
  const result = await rows<{
    output_id: string;
    revision: number;
    state: string;
    work_item_id: string;
    run_id: string | null;
  }>(
    ctx,
    sql`WITH current_rev AS (
          SELECT id, max(revision) AS revision
          FROM dopaios_output_versions
          GROUP BY id
        )
        SELECT o.id AS output_id, o.revision, o.state, o.work_item_id, w.run_id
        FROM dopaios_output_versions o
        JOIN current_rev c ON c.id = o.id AND c.revision = o.revision
        JOIN dopaios_work_items w ON w.id = o.work_item_id
        JOIN dopaios_sop_runs r ON r.id = w.run_id
        WHERE r.state NOT IN ('COMPLETED', 'CANCELLED')
          AND o.source_refs IS NOT NULL
          AND jsonb_typeof(o.source_refs) = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.source_refs) AS ref
            WHERE ref->>'artifactId' = ${artifactId}
          )
        ORDER BY o.id`,
  );
  return result.map((row) => ({
    outputId: row.output_id,
    revision: row.revision,
    state: row.state,
    workItemId: row.work_item_id,
    runId: row.run_id,
  }));
}

// Side effect dùng chung của KC-14 (SFR-031/050) — MỘT cơ chế cho cả hai
// đường kích hoạt (bản mới vào trục thay bản đã pin; artifact nguồn đổi
// nghĩa): approval hiệu lực trên đúng (output, revision) nhận invalidated_at,
// bước đã mở theo record đó bị tái chặn. Lifecycle của phiên bản KHÔNG đổi —
// lịch sử không viết lại.
export async function invalidateEffectiveApprovalsAndReblockSteps(
  ctx: CommandContext,
  outputId: string,
  revision: number,
  reason: string,
): Promise<number> {
  const records = await rows<{ id: string }>(
    ctx,
    sql`SELECT id FROM dopaios_approval_records
        WHERE target_id = ${outputId} AND target_revision = ${revision}
          AND outcome IN ('approve', 'approve-with-conditions')
          AND invalidated_at IS NULL
        ORDER BY id`,
  );
  for (const record of records) {
    await ctx.emit({
      streamName: `dopaiosApprovalRecord-${record.id}`,
      type: "ApprovalInvalidated",
      data: { recordId: record.id, reason },
    });
    const steps = await rows<{ run_id: string; step_id: string }>(
      ctx,
      sql`SELECT run_id, step_id FROM dopaios_run_steps
          WHERE opened_by_record_id = ${record.id} AND state = 'open'
          ORDER BY run_id, step_id`,
    );
    for (const step of steps) {
      await ctx.emit({
        streamName: `dopaiosRunStep-${step.run_id}-${step.step_id}`,
        type: "RunStepReblocked",
        data: { runId: step.run_id, stepId: step.step_id },
      });
    }
  }
  return records.length;
}

// Gói đang chờ và Yêu cầu liên kết trên đúng (output, revision) kết thúc
// trong CÙNG transaction (SFR-031, DEV-009) — dùng chung cho cả hai đường
// kích hoạt như trên.
export async function invalidateOpenPackagesAndRequestsForOutput(
  ctx: CommandContext,
  outputId: string,
  revision: number,
  invalidation: { reason: string; sourceEvent: string },
): Promise<void> {
  const packages = await rows<{ id: string; revision: number }>(
    ctx,
    sql`SELECT id, revision FROM dopaios_decision_packages
        WHERE state IN ('OPEN', 'AWAITING_INFO')
          AND target->>'outputId' = ${outputId}
          AND (target->>'revision')::int = ${revision}
        ORDER BY id, revision`,
  );
  for (const pkg of packages) {
    await ctx.emit({
      streamName: `dopaiosDecisionPackage-${pkg.id}`,
      type: "DecisionPackageRevisionStateChanged",
      data: { packageId: pkg.id, revision: pkg.revision, state: "INVALIDATED-TARGET-CHANGED" },
    });
    const requests = await rows<{ id: string }>(
      ctx,
      sql`SELECT id FROM dopaios_action_requests
          WHERE package_id = ${pkg.id} AND package_revision = ${pkg.revision}
            AND state IN ('OPEN', 'ROUTED', 'ACKNOWLEDGED', 'EXPIRED')
          ORDER BY id`,
    );
    for (const request of requests) {
      await ctx.emit({
        streamName: `dopaiosActionRequest-${request.id}`,
        type: "ActionRequestInvalidated",
        data: { requestId: request.id, invalidation },
      });
    }
  }
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

// ===== KC-04 B2: truy vết spec–code–test–artifact–kết quả kiểm =====
// (QD-1 KC-04): trace_links KHÔNG phải bảng mới — chuỗi truy vết là cách ĐỌC
// hợp nhất trên các liên kết pin sẵn có: source_refs của phiên bản đầu ra
// (KC-15/FS-002), sổ cái artifact + source_refs/storage_ref (KC-03/KC-04 B1),
// dopaios_session_artifacts (KC-02), approval record hiệu lực invalidated_at
// IS NULL (KC-14). Đặt tại graph-repo vì đây là module traversal duy nhất.
// Câu bất biến kế hoạch KC-04 (r4, từ research graph 07/2026): mọi đầu ra
// trọng yếu truy vết được về work-item → kế hoạch/spec → artifact → nguồn →
// quyết định kiểm → Phiên chạy AI tương ứng — đọc là SÁU MỐI phải giải được
// từ mỗi đầu ra (QD-6, khớp AC-FR-47.2 source→spec→task→run→output→check→
// decision), không phải một chuỗi tuyến tính duy nhất.

// Loại artifact được tính là mối "kế hoạch/spec" của câu bất biến. Giới hạn
// slice: danh mục loại đầy đủ thuộc FS-002/DS-2 — fixture KC-04 dùng
// feature-spec; ghi hồ sơ.
const SPEC_ARTIFACT_TYPES = ["feature-spec", "plan"];

export type ResolvedSourcePin = {
  pin: Json;
  // Hàng sổ cái khớp pin ID@revision; null khi pin không giải được trong sổ.
  resolved: {
    artifactId: string;
    revision: number;
    sha256: string;
    artifactType: string | null;
    artifactState: string;
  } | null;
  // Pin hash-đứng-một-mình (FS-002 d.629): nguồn ngoài sổ tự định danh bằng
  // nội dung — hợp lệ mà không cần hàng sổ cái.
  byContent: boolean;
};

export type OutputTrace = {
  output: {
    outputId: string;
    revision: number;
    state: string;
    workItemId: string;
    contentSha256: string;
    checkEvidence: Json | null;
  } | null;
  workItem: { id: string; runId: string | null; projectId: string | null; state: string } | null;
  sources: ResolvedSourcePin[];
  registeredArtifacts: Array<{
    artifactId: string;
    revision: number;
    sha256: string;
    artifactType: string | null;
    artifactState: string;
    storageRef: string | null;
    sourceRefs: Json[] | null;
  }>;
  effectiveApprovals: Array<{ recordId: string; outcome: string }>;
  aiSessions: Array<{ sessionId: string; agentId: string; engine: string }>;
  missing: string[];
};

// Sáu mối của câu bất biến + hai trường tiêu chí 2, dưới dạng khóa thiếu:
//   work-item / project    — đầu ra → work-item (→ Project);
//   spec                   — ≥1 nguồn giải được thuộc loại kế hoạch/spec;
//   nguon                  — mọi pin ID@revision giải được trong sổ và
//                            artifact đăng ký khai nguồn (không null);
//   artifact / noi-luu     — nội dung đầu ra được đăng ký sổ cái, có nơi lưu;
//   quyet-dinh-kiem        — approval hiệu lực trên đúng (output, revision);
//   phien-chay-ai          — Phiên chạy AI đã ghi nhận đúng nội dung này.
export async function traceCriticalOutput(
  ctx: CommandContext,
  outputId: string,
  revision: number,
): Promise<OutputTrace> {
  const outputRows = await rows<{
    id: string;
    revision: number;
    state: string;
    work_item_id: string;
    content_sha256: string;
    check_evidence: Json | null;
    source_refs: unknown;
  }>(
    ctx,
    sql`SELECT id, revision, state, work_item_id, content_sha256, check_evidence, source_refs
        FROM dopaios_output_versions
        WHERE id = ${outputId} AND revision = ${revision}`,
  );
  if (outputRows.length === 0) {
    return {
      output: null,
      workItem: null,
      sources: [],
      registeredArtifacts: [],
      effectiveApprovals: [],
      aiSessions: [],
      missing: ["output"],
    };
  }
  const o = outputRows[0];
  const missing: string[] = [];

  const workItemRows = await rows<{
    id: string;
    run_id: string | null;
    project_id: string | null;
    state: string;
  }>(
    ctx,
    sql`SELECT id, run_id, project_id, state FROM dopaios_work_items WHERE id = ${o.work_item_id}`,
  );
  const workItem = workItemRows[0]
    ? {
        id: workItemRows[0].id,
        runId: workItemRows[0].run_id,
        projectId: workItemRows[0].project_id,
        state: workItemRows[0].state,
      }
    : null;
  if (!workItem) missing.push("work-item");
  if (workItem && workItem.projectId === null) missing.push("project");

  const pins: Json[] = Array.isArray(o.source_refs) ? (o.source_refs as Json[]) : [];
  const sources: ResolvedSourcePin[] = [];
  for (const pin of pins) {
    const pinArtifactId = pin["artifactId"];
    const pinRevision = pin["revision"];
    if (typeof pinArtifactId === "string" && typeof pinRevision === "number") {
      const ledger = await rows<{
        id: string;
        revision: number;
        sha256: string;
        artifact_type: string | null;
        artifact_state: string;
      }>(
        ctx,
        sql`SELECT id, revision, sha256, artifact_type, artifact_state
            FROM dopaios_artifacts WHERE id = ${pinArtifactId} AND revision = ${pinRevision}`,
      );
      sources.push({
        pin,
        resolved: ledger[0]
          ? {
              artifactId: ledger[0].id,
              revision: ledger[0].revision,
              sha256: ledger[0].sha256,
              artifactType: ledger[0].artifact_type,
              artifactState: ledger[0].artifact_state,
            }
          : null,
        byContent: false,
      });
    } else {
      sources.push({ pin, resolved: null, byContent: typeof pin["sha256"] === "string" });
    }
  }
  const hasSpecSource = sources.some(
    (s) => s.resolved !== null && SPEC_ARTIFACT_TYPES.includes(s.resolved.artifactType ?? ""),
  );
  if (!hasSpecSource) missing.push("spec");
  const unresolvedPin = sources.some((s) => s.resolved === null && !s.byContent);

  const artifactRows = await rows<{
    id: string;
    revision: number;
    sha256: string;
    artifact_type: string | null;
    artifact_state: string;
    storage_ref: string | null;
    source_refs: unknown;
  }>(
    ctx,
    sql`SELECT id, revision, sha256, artifact_type, artifact_state, storage_ref, source_refs
        FROM dopaios_artifacts WHERE sha256 = ${o.content_sha256} ORDER BY id, revision`,
  );
  const registeredArtifacts = artifactRows.map((row) => ({
    artifactId: row.id,
    revision: row.revision,
    sha256: row.sha256,
    artifactType: row.artifact_type,
    artifactState: row.artifact_state,
    storageRef: row.storage_ref,
    sourceRefs: Array.isArray(row.source_refs) ? (row.source_refs as Json[]) : null,
  }));
  if (registeredArtifacts.length === 0) missing.push("artifact");
  if (registeredArtifacts.length > 0 && !registeredArtifacts.some((a) => a.storageRef !== null)) {
    missing.push("noi-luu");
  }
  // Mối "nguồn" đứt khi pin của đầu ra không giải được HOẶC artifact đăng ký
  // từ nội dung này chưa khai nguồn qua đường provenance (B1).
  if (unresolvedPin || registeredArtifacts.some((a) => a.sourceRefs === null)) {
    missing.push("nguon");
  }

  const approvalRows = await rows<{ id: string; outcome: string }>(
    ctx,
    sql`SELECT id, outcome FROM dopaios_approval_records
        WHERE target_id = ${outputId} AND target_revision = ${revision}
          AND outcome IN ('approve', 'approve-with-conditions')
          AND invalidated_at IS NULL
        ORDER BY id`,
  );
  const effectiveApprovals = approvalRows.map((row) => ({ recordId: row.id, outcome: row.outcome }));
  if (effectiveApprovals.length === 0) missing.push("quyet-dinh-kiem");

  const sessionRows = await rows<{ id: string; agent_id: string; engine: string }>(
    ctx,
    sql`SELECT DISTINCT s.id, s.agent_id, s.engine
        FROM dopaios_session_artifacts sa
        JOIN dopaios_ai_sessions s ON s.id = sa.session_id
        WHERE sa.sha256 = ${o.content_sha256} AND s.work_item_id = ${o.work_item_id}
        ORDER BY s.id`,
  );
  const aiSessions = sessionRows.map((row) => ({
    sessionId: row.id,
    agentId: row.agent_id,
    engine: row.engine,
  }));
  if (aiSessions.length === 0) missing.push("phien-chay-ai");

  return {
    output: {
      outputId: o.id,
      revision: o.revision,
      state: o.state,
      workItemId: o.work_item_id,
      contentSha256: o.content_sha256,
      checkEvidence: o.check_evidence,
    },
    workItem,
    sources,
    registeredArtifacts,
    effectiveApprovals,
    aiSessions,
    missing,
  };
}

// Truy vấn XUÔI của FR-21 ("chức năng X xong chưa?"): mọi phiên bản đầu ra
// từng pin ĐÚNG phiên bản spec này. Khác currentOutputsPinningSource (impact
// set — chỉ bản hiện hành, loại run terminal): đây là cách đọc lịch sử đầy
// đủ theo revision, phục vụ truy vết, không phục vụ vô hiệu.
export async function outputsPinningSourceRevision(
  ctx: CommandContext,
  artifactId: string,
  revision: number,
): Promise<Array<{ outputId: string; revision: number; state: string; workItemId: string }>> {
  const result = await rows<{
    output_id: string;
    revision: number;
    state: string;
    work_item_id: string;
  }>(
    ctx,
    sql`SELECT o.id AS output_id, o.revision, o.state, o.work_item_id
        FROM dopaios_output_versions o
        WHERE o.source_refs IS NOT NULL
          AND jsonb_typeof(o.source_refs) = 'array'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.source_refs) AS ref
            WHERE ref->>'artifactId' = ${artifactId}
              AND (ref->>'revision')::int = ${revision}
          )
        ORDER BY o.id, o.revision`,
  );
  return result.map((row) => ({
    outputId: row.output_id,
    revision: row.revision,
    state: row.state,
    workItemId: row.work_item_id,
  }));
}

// "Đầu ra trọng yếu" của một run (QD-6): phiên bản HIỆN HÀNH (revision cao
// nhất) của mọi dòng đầu ra thuộc work-item trong run — tập đầu vào cho phép
// kiểm câu bất biến.
export async function listCurrentRunOutputs(
  ctx: CommandContext,
  runId: string,
): Promise<Array<{ outputId: string; revision: number }>> {
  const result = await rows<{ output_id: string; revision: number }>(
    ctx,
    sql`SELECT o.id AS output_id, max(o.revision) AS revision
        FROM dopaios_output_versions o
        JOIN dopaios_work_items w ON w.id = o.work_item_id
        WHERE w.run_id = ${runId}
        GROUP BY o.id
        ORDER BY o.id`,
  );
  return result.map((row) => ({ outputId: row.output_id, revision: Number(row.revision) }));
}

// Tiêu chí 2 KC-04: "Mỗi artifact chỉ ra Project, work-item, Phiên chạy AI,
// phiên bản, hash và nơi lưu" — provenance của một hàng sổ cái, đọc qua
// liên kết sẵn có: Phiên chạy AI ghi nhận đúng nội dung (session_artifacts
// khớp sha256) → work-item của phiên → Project.
export async function artifactProvenance(
  ctx: CommandContext,
  artifactId: string,
  revision: number,
): Promise<{
  artifact: {
    artifactId: string;
    revision: number;
    sha256: string;
    artifactType: string | null;
    artifactState: string;
    storageRef: string | null;
    sourceRefs: Json[] | null;
    createdBy: string | null;
  } | null;
  producers: Array<{
    sessionId: string;
    agentId: string;
    engine: string;
    workItemId: string | null;
    runId: string | null;
    projectId: string | null;
  }>;
}> {
  const artifactRows = await rows<{
    id: string;
    revision: number;
    sha256: string;
    artifact_type: string | null;
    artifact_state: string;
    storage_ref: string | null;
    source_refs: unknown;
    created_by: string | null;
  }>(
    ctx,
    sql`SELECT id, revision, sha256, artifact_type, artifact_state, storage_ref, source_refs, created_by
        FROM dopaios_artifacts WHERE id = ${artifactId} AND revision = ${revision}`,
  );
  if (artifactRows.length === 0) {
    return { artifact: null, producers: [] };
  }
  const a = artifactRows[0];
  const producerRows = await rows<{
    id: string;
    agent_id: string;
    engine: string;
    work_item_id: string | null;
    run_id: string | null;
    project_id: string | null;
  }>(
    ctx,
    sql`SELECT DISTINCT s.id, s.agent_id, s.engine, s.work_item_id, w.run_id, w.project_id
        FROM dopaios_session_artifacts sa
        JOIN dopaios_ai_sessions s ON s.id = sa.session_id
        LEFT JOIN dopaios_work_items w ON w.id = s.work_item_id
        WHERE sa.sha256 = ${a.sha256}
        ORDER BY s.id`,
  );
  return {
    artifact: {
      artifactId: a.id,
      revision: a.revision,
      sha256: a.sha256,
      artifactType: a.artifact_type,
      artifactState: a.artifact_state,
      storageRef: a.storage_ref,
      sourceRefs: Array.isArray(a.source_refs) ? (a.source_refs as Json[]) : null,
      createdBy: a.created_by,
    },
    producers: producerRows.map((row) => ({
      sessionId: row.id,
      agentId: row.agent_id,
      engine: row.engine,
      workItemId: row.work_item_id,
      runId: row.run_id,
      projectId: row.project_id,
    })),
  };
}
