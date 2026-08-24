import { sql } from "drizzle-orm";
import { type Db } from "./event-store.js";

// KC-14 B6: giao diện ĐỌC hai vòng đời (QD-3 — Mission-Control-shaped query,
// không UI). Một truy vấn trả về, cho một run:
//  - trục THỰC HIỆN: work-item với trạng thái thực hiện + liên kết rework;
//  - trục CHẤT LƯỢNG: từng dòng đầu ra với chuỗi phiên bản — trạng thái chất
//    lượng riêng, quan hệ thay thế, hợp đồng chất lượng được pin, các loại
//    kiểm đã có bằng chứng, và các quyết định nhắm ĐÚNG phiên bản đó (kèm
//    hiệu lực còn/mất theo SFR-031/034).
// Hai trục hiển thị ĐỘC LẬP: work-item COMPLETED không suy ra phiên bản đạt;
// rework hiển thị là work-item MỚI + revision MỚI, không mở lại bản cũ.

export type TwoLifecyclesView = {
  run: { id: string; state: string; decider: string; pod: string } | null;
  workItems: Array<{
    id: string;
    state: string;
    executor: string | null;
    reworkOfWorkItemId: string | null;
    reworkOfOutputRef: Record<string, unknown> | null;
  }>;
  outputs: Array<{
    id: string;
    versions: Array<{
      revision: number;
      state: string;
      workItemId: string;
      replacesRevision: number | null;
      qualityContractRef: Record<string, unknown> | null;
      evidencedChecks: string[];
      decisions: Array<{
        recordId: string;
        outcome: string;
        actor: string;
        effective: boolean;
        invalidationReason: string | null;
      }>;
    }>;
  }>;
  steps: Array<{ stepId: string; state: string; openedByRecordId: string | null }>;
  requests: Array<{ id: string; kind: string; state: string }>;
};

export async function readTwoLifecycles(dbOrTx: Db, runId: string): Promise<TwoLifecyclesView> {
  // KC-14 B7 (minor review): sáu truy vấn đọc trong MỘT transaction
  // REPEATABLE READ — view không bị xé bởi lệnh commit xen giữa.
  return dbOrTx.transaction(async (db) => {
    await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    return readTwoLifecyclesInner(db as unknown as Db, runId);
  });
}

async function readTwoLifecyclesInner(db: Db, runId: string): Promise<TwoLifecyclesView> {
  const runs = (await db.execute(
    sql`SELECT id, state, decider, pod FROM dopaios_sop_runs WHERE id = ${runId}`,
  )) as unknown as Array<{ id: string; state: string; decider: string; pod: string }>;

  const workItems = (await db.execute(sql`
    SELECT id, state, executor, rework_of_work_item_id, rework_of_output_ref
    FROM dopaios_work_items WHERE run_id = ${runId} ORDER BY id
  `)) as unknown as Array<{
    id: string;
    state: string;
    executor: string | null;
    rework_of_work_item_id: string | null;
    rework_of_output_ref: Record<string, unknown> | null;
  }>;

  const versions = (await db.execute(sql`
    SELECT o.id, o.revision, o.state, o.work_item_id, o.replaces_revision,
           o.quality_contract_ref, o.check_evidence
    FROM dopaios_output_versions o
    JOIN dopaios_work_items w ON w.id = o.work_item_id
    WHERE w.run_id = ${runId}
    ORDER BY o.id, o.revision
  `)) as unknown as Array<{
    id: string;
    revision: number;
    state: string;
    work_item_id: string;
    replaces_revision: number | null;
    quality_contract_ref: Record<string, unknown> | null;
    check_evidence: Record<string, unknown> | null;
  }>;

  const decisions = (await db.execute(sql`
    SELECT r.id, r.outcome, r.actor, r.target_id, r.target_revision,
           r.invalidated_at, r.invalidation_reason
    FROM dopaios_approval_records r
    WHERE r.target_id IN (
      SELECT DISTINCT o.id FROM dopaios_output_versions o
      JOIN dopaios_work_items w ON w.id = o.work_item_id
      WHERE w.run_id = ${runId}
    )
    ORDER BY r.id
  `)) as unknown as Array<{
    id: string;
    outcome: string;
    actor: string;
    target_id: string;
    target_revision: number;
    invalidated_at: Date | null;
    invalidation_reason: string | null;
  }>;

  const steps = (await db.execute(sql`
    SELECT step_id, state, opened_by_record_id FROM dopaios_run_steps
    WHERE run_id = ${runId} ORDER BY step_id
  `)) as unknown as Array<{ step_id: string; state: string; opened_by_record_id: string | null }>;

  const requests = (await db.execute(sql`
    SELECT id, kind, state FROM dopaios_action_requests
    WHERE run_id = ${runId} ORDER BY id
  `)) as unknown as Array<{ id: string; kind: string; state: string }>;

  const outputIds = [...new Set(versions.map((v) => v.id))];
  return {
    run: runs[0] ?? null,
    workItems: workItems.map((w) => ({
      id: w.id,
      state: w.state,
      executor: w.executor,
      reworkOfWorkItemId: w.rework_of_work_item_id,
      reworkOfOutputRef: w.rework_of_output_ref,
    })),
    outputs: outputIds.map((outputId) => ({
      id: outputId,
      versions: versions
        .filter((v) => v.id === outputId)
        .map((v) => ({
          revision: v.revision,
          state: v.state,
          workItemId: v.work_item_id,
          replacesRevision: v.replaces_revision,
          qualityContractRef: v.quality_contract_ref,
          evidencedChecks: Object.keys(v.check_evidence ?? {}).sort(),
          decisions: decisions
            .filter((d) => d.target_id === outputId && d.target_revision === v.revision)
            .map((d) => ({
              recordId: d.id,
              outcome: d.outcome,
              actor: d.actor,
              effective: d.invalidated_at === null,
              invalidationReason: d.invalidation_reason,
            })),
        })),
    })),
    steps: steps.map((s) => ({ stepId: s.step_id, state: s.state, openedByRecordId: s.opened_by_record_id })),
    requests,
  };
}
