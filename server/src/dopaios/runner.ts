import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  executeCommand,
  CommandRejectedError,
} from "./event-store.js";
import {
  activateSopRun,
  runFixtureExecution,
  reviewFixtureExecution,
  advanceToDecision,
  completeSopRun,
} from "./commands.js";
import { routeWorkItem } from "./router.js";
import { compileExecutionContract } from "./contract.js";
import { requestActivation, claimActivation, completeActivation } from "./activation.js";
import { runWorkItemSession, type EngineAdapter } from "./engine.js";

// KC-13 B5: runner tick — trái tim của AC-NFR-3.1 ("work-item đủ điều kiện
// tự kích hoạt/chuyển tiếp mà không cần nhắc hoặc bấm giao thủ công").
// Quyết định hàng đợi của KC-13: KHÔNG thêm pg-boss — vòng tick thuần hàm
// (nhận nowMs tất định) theo đúng mẫu tick-scheduler sẵn có của fork
// (plugin-job-scheduler) và watchdog KC-02 (detectStalledSessions); mọi
// lệnh đi qua executeCommand nên idempotency/audit/replay có sẵn, command id
// tất định theo đối tượng để tick lặp không tạo tác dụng kép. Chi tiết và
// tiêu chí đánh giá lại pg-boss ghi ở ADR định tuyến/kích hoạt (hồ sơ B7).
//
// Ranh cứng: runner tự chuyển MỌI bước máy-kiểm nhưng DỪNG tại điểm phê
// duyệt (SFR-014) — nó dựng Gói quyết định + Yêu cầu định tuyến người quyết
// rồi chờ; nó không bao giờ là actor của record-approval (SFR-023). Run
// CANCELLED không nhận thêm lệnh nào (FX-02 N15).

type Json = Record<string, unknown>;

export type RunnerAction = {
  command: string;
  target: string;
  outcome: "ok" | "blocked";
  code?: string;
};

export type RunnerFixtureConfig = {
  executor: string;
  reviewer: string;
  contentSha256: string;
};

export type RunnerProjectConfig = {
  engine: () => EngineAdapter;
  sopRef: { id: string; revision: number; sha256: string };
  contractFields: Json;
  steps: string[];
  leaseMs: number;
};

async function rows<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

// Thu hồi claim mồ côi: lease hết hạn mà activation vẫn RUNNING → về QUEUED
// với epoch tăng. Command id mang epoch nên tick lặp là idempotent replay,
// không tăng kép.
export async function requeueExpiredActivations(
  db: Db,
  input: { nowMs: number },
): Promise<RunnerAction[]> {
  const actions: RunnerAction[] = [];
  const expired = await rows<{ id: string; lease_epoch: number }>(
    db,
    sql`SELECT id, lease_epoch FROM dopaios_activations
        WHERE state = 'RUNNING' AND claim_lease_until IS NOT NULL
          AND claim_lease_until < ${new Date(input.nowMs).toISOString()}
        ORDER BY id`,
  );
  for (const activation of expired) {
    const commandId = `REQUEUE-${activation.id}-e${activation.lease_epoch}`;
    await executeCommand(db, {
      commandId,
      payload: { activationId: activation.id, fromEpoch: activation.lease_epoch },
      handler: async (ctx, p) => {
        await ctx.emit({
          streamName: `dopaiosActivation-${p["activationId"]}`,
          type: "ActivationRequeued",
          data: {
            activationId: p["activationId"],
            fromEpoch: p["fromEpoch"],
            newEpoch: Number(p["fromEpoch"]) + 1,
            reason: "lease-expired",
          },
          metadata: { commandId, audit: true },
        });
        return { activationId: p["activationId"] as string, state: "QUEUED" };
      },
    });
    actions.push({ command: "requeue-activation", target: activation.id, outcome: "ok" });
  }
  return actions;
}

async function fire(
  actions: RunnerAction[],
  command: string,
  target: string,
  run: () => Promise<CommandResult>,
): Promise<void> {
  try {
    await run();
    actions.push({ command, target, outcome: "ok" });
  } catch (error) {
    if (error instanceof CommandRejectedError) {
      actions.push({ command, target, outcome: "blocked", code: error.code });
      return;
    }
    throw error;
  }
}

// Một tick: quét trạng thái, bắn các lệnh máy-kiểm đủ điều kiện, trả lại
// nhật ký hành động (bằng chứng "0 thao tác người" — phân loại AC-V1-04).
export async function runnerTick(
  db: Db,
  input: {
    nowMs: number;
    fixture?: RunnerFixtureConfig;
    project?: RunnerProjectConfig;
  },
): Promise<RunnerAction[]> {
  const actions: RunnerAction[] = [];

  actions.push(...(await requeueExpiredActivations(db, { nowMs: input.nowMs })));

  if (input.fixture) {
    const fx = input.fixture;

    // S05 — kích hoạt run đủ guard máy-kiểm; idempotent theo run ID (SFR-011):
    // command id tất định theo run nên retry/tick lặp không sinh run kép.
    for (const run of await rows<{ id: string }>(
      db,
      sql`SELECT id FROM dopaios_sop_runs WHERE state = 'NOT_ACTIVATED' AND label = 'test' ORDER BY id`,
    )) {
      await fire(actions, "activate-sop-run", run.id, () =>
        activateSopRun(db, `AUTO-ACT-${run.id}`, { runId: run.id, workItemId: `${run.id}-T1` }),
      );
    }

    // S06 — thực thi work-item ACCEPTED của run đang RUNNING.
    for (const wi of await rows<{ id: string }>(
      db,
      sql`SELECT w.id FROM dopaios_work_items w
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          WHERE w.state = 'ACCEPTED' AND r.state = 'RUNNING' ORDER BY w.id`,
    )) {
      await fire(actions, "run-fixture-execution", wi.id, () =>
        runFixtureExecution(db, `AUTO-EXEC-${wi.id}`, {
          workItemId: wi.id,
          executor: fx.executor,
          outputId: `OUT-${wi.id}`,
          outputRevision: 1,
          contentSha256: fx.contentSha256,
        }),
      );
    }

    // S07 — review độc lập (reviewer ≠ executor) cho work-item SUBMITTED.
    for (const wi of await rows<{ id: string }>(
      db,
      sql`SELECT w.id FROM dopaios_work_items w
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          WHERE w.state = 'SUBMITTED' AND r.state = 'RUNNING' ORDER BY w.id`,
    )) {
      await fire(actions, "run-fixture-review", wi.id, () =>
        reviewFixtureExecution(db, `AUTO-REV-${wi.id}`, {
          workItemId: wi.id,
          outputId: `OUT-${wi.id}`,
          outputRevision: 1,
          executor: fx.executor,
          reviewer: fx.reviewer,
        }),
      );
    }

    // S08 — trình điểm quyết định: dựng Gói + Yêu cầu định tuyến người quyết
    // rồi DỪNG (SFR-014). Đây là điểm runner không bao giờ vượt qua.
    for (const output of await rows<{ id: string; revision: number; run_id: string; sha: string }>(
      db,
      sql`SELECT o.id, o.revision, w.run_id, o.content_sha256 AS sha
          FROM dopaios_output_versions o
          JOIN dopaios_work_items w ON w.id = o.work_item_id
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          WHERE o.state = 'CHECK_PASSED' AND w.state = 'COMPLETED' AND r.state = 'RUNNING'
          ORDER BY o.id`,
    )) {
      await fire(actions, "advance-to-decision", output.run_id, () =>
        advanceToDecision(db, `AUTO-ADV-${output.run_id}`, {
          runId: output.run_id,
          outputId: output.id,
          outputRevision: output.revision,
          packageId: `PKG-${output.run_id}`,
          packageRevision: 1,
          refs: { outputId: output.id, revision: output.revision, sha256: output.sha },
          requestId: `REQ-${output.run_id}`,
        }),
      );
    }

    // S10 — đóng run máy-kiểm: CHỈ khi đã có quyết định của người (tồn tại
    // Yêu cầu DECIDED) và không còn nghĩa vụ mở.
    for (const run of await rows<{ id: string }>(
      db,
      sql`SELECT r.id FROM dopaios_sop_runs r
          WHERE r.state = 'RUNNING'
            AND EXISTS (SELECT 1 FROM dopaios_action_requests q
                        WHERE q.run_id = r.id AND q.state = 'DECIDED')
            AND NOT EXISTS (SELECT 1 FROM dopaios_action_requests q
                            WHERE q.run_id = r.id AND q.state NOT IN ('DECIDED','CLOSED'))
          ORDER BY r.id`,
    )) {
      await fire(actions, "complete-sop-run", run.id, () =>
        completeSopRun(db, `AUTO-DONE-${run.id}`, { runId: run.id }),
      );
    }
  }

  if (input.project) {
    const cfg = input.project;

    // Định tuyến work-item Project READY chưa có đích (FR-15/FR-42).
    for (const wi of await rows<{ id: string }>(
      db,
      sql`SELECT id FROM dopaios_work_items
          WHERE state = 'READY' AND project_id IS NOT NULL AND role IS NOT NULL
            AND routed_to IS NULL ORDER BY id`,
    )) {
      await fire(actions, "route-work-item", wi.id, () =>
        routeWorkItem(db, `AUTO-ROUTE-${wi.id}`, { workItemId: wi.id }),
      );
    }

    // Biên dịch Hợp đồng thực hiện AI cho work-item đã định tuyến (FR-63).
    for (const wi of await rows<{ id: string }>(
      db,
      sql`SELECT w.id FROM dopaios_work_items w
          WHERE w.state = 'READY' AND w.routed_to IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM dopaios_execution_contracts c
                            WHERE c.id = ${sql.raw("'XC-' || w.id")} AND c.state = 'active')
          ORDER BY w.id`,
    )) {
      await fire(actions, "compile-contract", wi.id, () =>
        compileExecutionContract(db, `AUTO-XC-${wi.id}`, {
          contractId: `XC-${wi.id}`,
          workItemId: wi.id,
          compiledBy: "dopaios-runner",
          sopRef: cfg.sopRef,
          fields: { ...cfg.contractFields, steps: cfg.steps },
        }),
      );
    }

    // Xin kích hoạt với pin hợp đồng active mới nhất.
    for (const wi of await rows<{ id: string; routed_to: string; xc_rev: number }>(
      db,
      sql`SELECT w.id, w.routed_to, c.revision AS xc_rev
          FROM dopaios_work_items w
          JOIN dopaios_execution_contracts c
            ON c.id = ${sql.raw("'XC-' || w.id")} AND c.state = 'active'
          WHERE w.state = 'READY' AND w.routed_to IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM dopaios_activations a
                            WHERE a.id = ${sql.raw("'ACT-' || w.id")})
          ORDER BY w.id`,
    )) {
      await fire(actions, "request-activation", wi.id, () =>
        requestActivation(db, `AUTO-REQ-${wi.id}`, {
          activationId: `ACT-${wi.id}`,
          workItemId: wi.id,
          agentId: wi.routed_to,
          engine: "fake",
          contract: { contractId: `XC-${wi.id}`, revision: wi.xc_rev },
        }),
      );
    }

    // Claim CAS kèm lease rồi chạy phiên engine; hoàn tất với epoch guard —
    // claimer cũ sau requeue không ghi đè được lượt mới.
    for (const activation of await rows<{
      id: string;
      work_item_id: string;
      lease_epoch: number;
      routed_to: string;
      xc_rev: number;
    }>(
      db,
      sql`SELECT a.id, a.work_item_id, a.lease_epoch, w.routed_to, a.contract_revision AS xc_rev
          FROM dopaios_activations a
          JOIN dopaios_work_items w ON w.id = a.work_item_id
          WHERE a.state = 'QUEUED' AND w.routed_to IS NOT NULL
          ORDER BY a.id`,
    )) {
      const epoch = Number(activation.lease_epoch);
      const claimId = `AUTO-CLAIM-${activation.id}-e${epoch}`;
      let claimed = false;
      await fire(actions, "claim-activation", activation.id, async () => {
        const result = await claimActivation(db, claimId, {
          activationId: activation.id,
          claimedBy: activation.routed_to,
          lease: { untilMs: input.nowMs + cfg.leaseMs },
        });
        claimed = true;
        return result;
      });
      if (!claimed) continue;

      const outcome = await runWorkItemSession(db, {
        sessionId: `SES-${activation.id}-e${epoch}`,
        agentId: activation.routed_to,
        adapter: cfg.engine(),
        contract: {
          workItemId: activation.work_item_id,
          contractRevision: Number(activation.xc_rev ?? 1),
          sopRef: `${cfg.sopRef.id}@${cfg.sopRef.revision}`,
          steps: cfg.steps,
        },
      });
      if (outcome.kind === "succeeded") {
        await fire(actions, "complete-activation", activation.id, () =>
          completeActivation(db, `AUTO-COMPLETE-${activation.id}-e${epoch}`, {
            activationId: activation.id,
            outcome: "succeeded",
            leaseEpoch: epoch,
          }),
        );
      }
      // process-lost: phiên ở nguyên RUNNING — gián đoạn là việc của watchdog
      // KC-02 (detectStalledSessions) và lease requeue tick sau, không phải
      // của runner (đúng phân vai FS-005).
    }
  }

  return actions;
}

// Bằng chứng đo AC-V1-04: chạy tick tới khi hết việc máy-kiểm (quiesce) và
// trả trọn nhật ký — mọi hành động đều do runner bắn, không lệnh nào cần
// người nhắc/bấm giao.
export async function runUntilQuiescent(
  db: Db,
  input: {
    nowMs: number;
    fixture?: RunnerFixtureConfig;
    project?: RunnerProjectConfig;
    maxTicks?: number;
  },
): Promise<{ ticks: number; actions: RunnerAction[] }> {
  const all: RunnerAction[] = [];
  const maxTicks = input.maxTicks ?? 10;
  for (let tick = 1; tick <= maxTicks; tick += 1) {
    const actions = await runnerTick(db, {
      nowMs: input.nowMs + tick,
      fixture: input.fixture,
      project: input.project,
    });
    const fresh = actions.filter((a) => a.outcome === "ok");
    all.push(...actions);
    if (fresh.length === 0) return { ticks: tick, actions: all };
  }
  return { ticks: maxTicks, actions: all };
}
