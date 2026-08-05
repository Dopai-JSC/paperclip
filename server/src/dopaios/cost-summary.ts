import { sql } from "drizzle-orm";
import { type Db } from "./event-store.js";

// KC-11: chi phí từng Phiên chạy AI và tổng work-item trên chuỗi
// retry/continue/reassign. Bất biến SM-C4: không gộp phiên — mỗi phiên một
// dòng riêng; phiên fail/interrupt/budget_stopped vẫn TÍNH CHI PHÍ vào tổng
// work-item nhưng không bao giờ được tính là đầu ra hoàn thành
// (countsAsCompleted chỉ true với outcome 'succeeded').

export type SessionCostRow = {
  sessionId: string;
  predecessorId: string | null;
  relation: string | null;
  state: string;
  outcome: string | null;
  budgetState: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsdReported: string;
  costUsdComputed: string;
  countsAsCompleted: boolean;
};

export type WorkItemCostSummary = {
  workItemId: string;
  sessions: SessionCostRow[];
  totals: {
    sessionCount: number;
    completedSessionCount: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsdReported: string;
    costUsdComputed: string;
  };
};

const SCALE = 1e8;

function addCost(total: number, value: string): number {
  return total + Math.round(Number(value) * SCALE);
}

export async function workItemCostSummary(
  db: Db,
  workItemId: string,
): Promise<WorkItemCostSummary> {
  const rows = (await db.execute(sql`
    SELECT id, predecessor_id, relation, state, outcome, budget_state,
           usage_input_tokens, usage_cached_input_tokens, usage_output_tokens,
           usage_cost_usd_reported, usage_cost_usd_computed
    FROM dopaios_ai_sessions
    WHERE work_item_id = ${workItemId}
    ORDER BY id
  `)) as unknown as Array<{
    id: string;
    predecessor_id: string | null;
    relation: string | null;
    state: string;
    outcome: string | null;
    budget_state: string | null;
    usage_input_tokens: number;
    usage_cached_input_tokens: number;
    usage_output_tokens: number;
    usage_cost_usd_reported: string;
    usage_cost_usd_computed: string;
  }>;

  // Sắp theo chuỗi predecessor (gốc trước, kế nhiệm sau) để báo cáo đọc được
  // đúng thứ tự đời phiên; phiên không nằm trong chuỗi nào giữ thứ tự id.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depth = (id: string): number => {
    let d = 0;
    let cursor = byId.get(id);
    while (cursor?.predecessor_id && byId.has(cursor.predecessor_id)) {
      d += 1;
      cursor = byId.get(cursor.predecessor_id);
      if (d > rows.length) break;
    }
    return d;
  };
  const ordered = [...rows].sort((a, b) => depth(a.id) - depth(b.id) || a.id.localeCompare(b.id));

  let reportedScaled = 0;
  let computedScaled = 0;
  const sessions: SessionCostRow[] = ordered.map((row) => {
    reportedScaled = addCost(reportedScaled, row.usage_cost_usd_reported);
    computedScaled = addCost(computedScaled, row.usage_cost_usd_computed);
    return {
      sessionId: row.id,
      predecessorId: row.predecessor_id,
      relation: row.relation,
      state: row.state,
      outcome: row.outcome,
      budgetState: row.budget_state,
      inputTokens: Number(row.usage_input_tokens),
      cachedInputTokens: Number(row.usage_cached_input_tokens),
      outputTokens: Number(row.usage_output_tokens),
      costUsdReported: Number(row.usage_cost_usd_reported).toFixed(8),
      costUsdComputed: Number(row.usage_cost_usd_computed).toFixed(8),
      countsAsCompleted: row.outcome === "succeeded",
    };
  });

  return {
    workItemId,
    sessions,
    totals: {
      sessionCount: sessions.length,
      completedSessionCount: sessions.filter((s) => s.countsAsCompleted).length,
      inputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
      cachedInputTokens: sessions.reduce((sum, s) => sum + s.cachedInputTokens, 0),
      outputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
      costUsdReported: (reportedScaled / SCALE).toFixed(8),
      costUsdComputed: (computedScaled / SCALE).toFixed(8),
    },
  };
}
