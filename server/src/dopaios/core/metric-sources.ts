import { sql } from "drizzle-orm";
import { type Db } from "./event-store.js";

// KC-11 B3: xác định NGUỒN EVENT cho ba nhóm metric của FR-34 — tỷ lệ tự
// động, sản lượng nghiệm thu/giờ người và tải tại cổng — kèm mẫu số chống
// gaming theo SM-C4. Đây là hợp đồng nguồn đo + phép kiểm recount, KHÔNG
// phải projection production (việc của FS sau).
//
// SM-C4 ánh xạ vào luật cứng:
//  1. KHÔNG gộp phiên thử lại: mỗi phiên một dòng; retry/reassign hiện rõ
//     trong sessionCount/retrySessionCount của từng work-item.
//  2. KHÔNG coi lời nhắc thủ công là bước chuẩn: phiên engine 'manual' (hoặc
//     danh sách MANUAL_ENGINES) làm work-item rớt khỏi tử số tự động.
//  3. KHÔNG bỏ ghi nhận chuyển cấp: Yêu cầu hành động/quyết định
//     (dopaios_action_requests) là nguồn bắt buộc của tải tại cổng.
//  4. KHÔNG tính đầu ra chưa đạt là hoàn thành: chỉ chain kết thúc
//     outcome='succeeded' vào tử số; budget_stopped/failed/abandoned thì
//     chi phí vẫn tính (cost-summary) nhưng sản lượng bằng 0.

export const METRIC_DICTIONARY = {
  id: "METRIC-DICT-KC11",
  revision: 1,
  priceNote: "chi phí lấy từ dopaios_session_usage (KC-11 B1) — reported và computed song song",
  metrics: {
    automationRate: {
      formula:
        "số work-item AI hoàn thành tự động ÷ số work-item AI có ít nhất một Phiên chạy AI",
      numeratorSources: [
        "event AiSessionTerminal(outcome=succeeded)",
        "chuỗi phiên không có engine thủ công",
      ],
      denominatorSources: ["event AiSessionStarted theo work-item"],
      exclusions: [
        "work-item chưa succeeded không vào tử số (SM-C4)",
        "phiên retry không gộp — đếm riêng trong retrySessionCount",
      ],
    },
    acceptedPerPersonHour: {
      formula: "số đầu ra được nghiệm thu ÷ giờ người thực ghi",
      numeratorSources: [
        "trục chất lượng KC-14: dopaios_output_versions đạt trạng thái nghiệm thu",
        "fixture spike: chain succeeded làm proxy có khai báo",
      ],
      denominatorSources: [
        "giờ người là ĐẦU VÀO NGOÀI bắt buộc (FR-34: Staff ghi giờ thực tế; Orchestrator xác nhận)",
      ],
      exclusions: ["đầu ra chưa đạt Hợp đồng chất lượng không vào tử số"],
    },
    gateLoad: {
      formula: "số quyết định người phải xử lý theo loại điểm phê duyệt trong kỳ",
      numeratorSources: [
        "dopaios_approval_records (mọi điểm phê duyệt)",
        "dopaios_gate_records (chỉ Cổng A/B/C)",
        "dopaios_action_requests (Yêu cầu hành động/quyết định — hàng chờ người)",
      ],
      denominatorSources: ["cửa sổ thời gian báo cáo"],
      exclusions: ["không bỏ ghi chuyển cấp (SM-C4)"],
    },
    costPerAcceptedFunction: {
      formula:
        "tổng chi phí usage (NFR-2 tử số) ÷ số chức năng nghiệm thu ĐÓNG BĂNG tại Cổng A",
      numeratorSources: ["dopaios_session_usage qua workItemCostSummary"],
      denominatorSources: ["danh sách chức năng + Acceptance ID chốt tại Gate Record Cổng A"],
      exclusions: [
        "mẫu số không đổi sau khi thấy chi phí (NFR-2)",
        "shared foundation/defect/rework không tăng mẫu số",
      ],
    },
  },
} as const;

export const MANUAL_ENGINES = ["manual"] as const;

export type WorkItemAutomation = {
  workItemId: string;
  sessionCount: number;
  retrySessionCount: number;
  manualSessionCount: number;
  completed: boolean;
  automated: boolean;
};

export type AutomationStats = {
  workItems: WorkItemAutomation[];
  denominator: number;
  numerator: number;
  automationRate: number | null;
};

function toStats(rows: Array<{
  work_item_id: string;
  session_count: number;
  retry_count: number;
  manual_count: number;
  succeeded_count: number;
}>): AutomationStats {
  const workItems = rows.map((row) => {
    const completed = Number(row.succeeded_count) > 0;
    const manual = Number(row.manual_count) > 0;
    return {
      workItemId: row.work_item_id,
      sessionCount: Number(row.session_count),
      retrySessionCount: Number(row.retry_count),
      manualSessionCount: Number(row.manual_count),
      completed,
      automated: completed && !manual,
    };
  });
  const denominator = workItems.length;
  const numerator = workItems.filter((w) => w.automated).length;
  return {
    workItems,
    denominator,
    numerator,
    automationRate: denominator === 0 ? null : numerator / denominator,
  };
}

// Đường chính: đọc projection dopaios_ai_sessions.
export async function automationStats(db: Db): Promise<AutomationStats> {
  const rows = (await db.execute(sql`
    SELECT work_item_id,
           count(*)::int AS session_count,
           count(*) FILTER (WHERE relation IS NOT NULL)::int AS retry_count,
           count(*) FILTER (WHERE engine = ANY(${sql.raw(
             `ARRAY['${MANUAL_ENGINES.join("','")}']`,
           )}))::int AS manual_count,
           count(*) FILTER (WHERE outcome = 'succeeded')::int AS succeeded_count
    FROM dopaios_ai_sessions
    GROUP BY work_item_id
    ORDER BY work_item_id
  `)) as unknown as Parameters<typeof toStats>[0];
  return toStats(rows);
}

// Recount độc lập: cùng con số nhưng dựng THẲNG từ event log
// message_store.messages (AiSessionStarted/AiSessionTerminal), không đụng
// projection — dùng để đối chứng chống drift/gaming.
export async function automationStatsFromEventLog(db: Db): Promise<AutomationStats> {
  const rows = (await db.execute(sql`
    WITH starts AS (
      SELECT data->>'sessionId' AS session_id,
             data->>'workItemId' AS work_item_id,
             data->>'engine' AS engine,
             data->>'relation' AS relation
      FROM message_store.messages
      WHERE type = 'AiSessionStarted'
    ), terminals AS (
      SELECT data->>'sessionId' AS session_id,
             data->>'outcome' AS outcome
      FROM message_store.messages
      WHERE type = 'AiSessionTerminal'
    )
    SELECT s.work_item_id,
           count(*)::int AS session_count,
           count(*) FILTER (WHERE s.relation IS NOT NULL)::int AS retry_count,
           count(*) FILTER (WHERE s.engine = ANY(${sql.raw(
             `ARRAY['${MANUAL_ENGINES.join("','")}']`,
           )}))::int AS manual_count,
           count(*) FILTER (WHERE t.outcome = 'succeeded')::int AS succeeded_count
    FROM starts s
    LEFT JOIN terminals t ON t.session_id = s.session_id
    GROUP BY s.work_item_id
    ORDER BY s.work_item_id
  `)) as unknown as Parameters<typeof toStats>[0];
  return toStats(rows);
}

export type GateLoad = {
  approvalsByOutcome: Record<string, number>;
  gateRecordsByGate: Record<string, number>;
  actionRequestsByKindState: Record<string, number>;
};

export async function gateLoad(db: Db): Promise<GateLoad> {
  const approvals = (await db.execute(sql`
    SELECT outcome, count(*)::int AS n FROM dopaios_approval_records GROUP BY outcome
  `)) as unknown as Array<{ outcome: string; n: number }>;
  const gates = (await db.execute(sql`
    SELECT gate_name, count(*)::int AS n FROM dopaios_gate_records GROUP BY gate_name
  `)) as unknown as Array<{ gate_name: string; n: number }>;
  const actions = (await db.execute(sql`
    SELECT kind || '/' || state AS key, count(*)::int AS n
    FROM dopaios_action_requests GROUP BY kind, state
  `)) as unknown as Array<{ key: string; n: number }>;
  return {
    approvalsByOutcome: Object.fromEntries(approvals.map((r) => [r.outcome, Number(r.n)])),
    gateRecordsByGate: Object.fromEntries(gates.map((r) => [r.gate_name, Number(r.n)])),
    actionRequestsByKindState: Object.fromEntries(actions.map((r) => [r.key, Number(r.n)])),
  };
}

// NFR-2: chi phí trên mỗi chức năng nghiệm thu với mẫu số ĐÓNG BĂNG. Mẫu số
// là danh sách bất biến chốt tại Cổng A — hàm nhận danh sách đã chốt và từ
// chối mẫu số rỗng; không có đường sửa mẫu số sau khi thấy chi phí.
export function costPerAcceptedFunction(
  totalCostUsd: string,
  frozenFunctionIds: readonly string[],
): { costPerFunctionUsd: string; frozenCount: number } {
  if (frozenFunctionIds.length === 0) {
    throw new Error("NFR-2 denominator must be a non-empty frozen function list");
  }
  const unique = new Set(frozenFunctionIds);
  if (unique.size !== frozenFunctionIds.length) {
    throw new Error("NFR-2 frozen function list must not contain duplicates");
  }
  const cost = Number(totalCostUsd);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(`Invalid total cost: ${totalCostUsd}`);
  }
  return {
    costPerFunctionUsd: (cost / frozenFunctionIds.length).toFixed(8),
    frozenCount: frozenFunctionIds.length,
  };
}
