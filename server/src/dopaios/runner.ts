import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  executeCommand,
  CommandRejectedError,
  CommandPayloadMismatchError,
} from "./event-store.js";
import {
  activateSopRun,
  runFixtureExecution,
  validateSelfCheck,
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
  // KC-14: chuỗi đầu ra phân rã theo đúng bảng FS-003 — bước nộp pin Hợp
  // đồng chất lượng, validate-self-check và review độc lập cần bằng chứng
  // đúng hash đã pin trong gói fixture.
  outputType: string;
  qualityContractRef: { id: string; revision: number; sha256: string };
  selfCheckSha256: string;
  reviewSha256: string;
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
// không tăng kép. Finding review đối kháng (blocker): danh sách quét nằm
// NGOÀI transaction — handler phải RE-CHECK trong cùng transaction (FOR
// UPDATE) rằng activation vẫn RUNNING, đúng epoch và lease vẫn quá hạn;
// claimer thật hoàn tất xen giữa thì lệnh bị từ chối, KHÔNG hồi sinh
// activation đã DONE (chống chạy đúp work-item).
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
    await fire(actions, "requeue-activation", activation.id, () =>
      executeCommand(db, {
        commandId,
        payload: {
          activationId: activation.id,
          fromEpoch: activation.lease_epoch,
          nowMs: input.nowMs,
        },
        handler: async (ctx, p) => {
          const current = (await ctx.tx.execute(sql`
            SELECT state, lease_epoch, claim_lease_until FROM dopaios_activations
            WHERE id = ${p["activationId"]} FOR UPDATE
          `)) as unknown as Array<{
            state: string;
            lease_epoch: number;
            claim_lease_until: Date | string | null;
          }>;
          const row = current[0];
          const leaseMs = row?.claim_lease_until ? new Date(row.claim_lease_until).getTime() : null;
          if (
            !row ||
            row.state !== "RUNNING" ||
            Number(row.lease_epoch) !== Number(p["fromEpoch"]) ||
            leaseMs === null ||
            leaseMs >= Number(p["nowMs"])
          ) {
            throw new CommandRejectedError(
              "ERR-REQUEUE-STALE",
              `Activation ${p["activationId"]} is no longer an expired epoch-${p["fromEpoch"]} claim — refusing to requeue`,
            );
          }
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
      }),
    );
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
    // Hai instance tick va nhau trên cùng command id với payload khác (vd
    // nowMs trong lease) — bên thua ghi nhận blocked và đi tiếp, không sập
    // cả tick (finding review đối kháng).
    if (error instanceof CommandPayloadMismatchError) {
      actions.push({ command, target, outcome: "blocked", code: "SFR-039" });
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

    // S06 — thực thi work-item ACCEPTED của run đang RUNNING (ready-check
    // máy-kiểm pin Hợp đồng chất lượng nằm trong chính lệnh — KC-14).
    // KC-14 B7 (major review): id lệnh và đối tượng phải tất định theo ĐÚNG
    // dòng đầu ra — work-item rework nộp lên CÙNG dòng của bản trước với
    // revision kế tiếp, không mở dòng song song.
    for (const wi of await rows<{ id: string; rework_output: string | null; rework_rev: number | null }>(
      db,
      sql`SELECT w.id, w.rework_of_output_ref->>'outputId' AS rework_output,
                 (w.rework_of_output_ref->>'revision')::int AS rework_rev
          FROM dopaios_work_items w
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          WHERE w.state = 'ACCEPTED' AND r.state = 'RUNNING' ORDER BY w.id`,
    )) {
      const outputId = wi.rework_output ?? `OUT-${wi.id}`;
      const outputRevision = (wi.rework_rev ?? 0) + 1;
      await fire(actions, "run-fixture-execution", wi.id, () =>
        runFixtureExecution(db, `AUTO-EXEC-${wi.id}-${outputId}-r${outputRevision}`, {
          workItemId: wi.id,
          executor: fx.executor,
          outputId,
          outputRevision,
          contentSha256: fx.contentSha256,
          outputType: fx.outputType,
          qualityContractRef: fx.qualityContractRef,
        }),
      );
    }

    // S06b — validate-self-check (runtime tự động, KC-14): phiên bản
    // SUBMITTED của run RUNNING nhận bằng chứng self-check đúng hash pin.
    for (const output of await rows<{ id: string; revision: number }>(
      db,
      sql`SELECT o.id, o.revision FROM dopaios_output_versions o
          JOIN dopaios_work_items w ON w.id = o.work_item_id
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          WHERE o.state = 'SUBMITTED' AND r.state = 'RUNNING' ORDER BY o.id`,
    )) {
      await fire(actions, "validate-self-check", output.id, () =>
        validateSelfCheck(db, `AUTO-VSC-${output.id}-r${output.revision}`, {
          outputId: output.id,
          outputRevision: output.revision,
          evidence: {
            ref: `SC-${output.id}`,
            sha256: fx.selfCheckSha256,
            targetSha256: fx.contentSha256,
            by: fx.executor,
          },
          expectedSha256: fx.selfCheckSha256,
        }),
      );
    }

    // S07 — review độc lập (reviewer ≠ executor) cho work-item SUBMITTED có
    // phiên bản đã qua SELF_CHECK.
    for (const wi of await rows<{ id: string; output_id: string; revision: number }>(
      db,
      sql`SELECT w.id, o.id AS output_id, o.revision FROM dopaios_work_items w
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          JOIN dopaios_output_versions o ON o.work_item_id = w.id AND o.state = 'SELF_CHECK'
          WHERE w.state = 'SUBMITTED' AND r.state = 'RUNNING' ORDER BY w.id`,
    )) {
      await fire(actions, "run-fixture-review", wi.id, () =>
        reviewFixtureExecution(db, `AUTO-REV-${wi.id}-${wi.output_id}-r${wi.revision}`, {
          workItemId: wi.id,
          outputId: wi.output_id,
          outputRevision: wi.revision,
          executor: fx.executor,
          reviewer: fx.reviewer,
          reviewEvidence: {
            ref: `RE-${wi.output_id}`,
            sha256: fx.reviewSha256,
            targetSha256: fx.contentSha256,
            conclusion: "ready",
          },
          expectedReviewSha256: fx.reviewSha256,
        }),
      );
    }

    // S08 — trình điểm quyết định: dựng Gói + Yêu cầu định tuyến người quyết
    // rồi DỪNG (SFR-014). Đây là điểm runner không bao giờ vượt qua.
    // KC-14 B7: id lệnh + yêu cầu tất định theo (output, revision); gói của
    // điểm dùng revision kế tiếp khi vòng trước đã kết thúc (SFR-053).
    for (const output of await rows<{ id: string; revision: number; run_id: string; sha: string; next_pkg_rev: number }>(
      db,
      sql`SELECT o.id, o.revision, w.run_id, o.content_sha256 AS sha,
                 COALESCE((SELECT max(p.revision) FROM dopaios_decision_packages p
                           WHERE p.id = 'PKG-' || w.run_id), 0) + 1 AS next_pkg_rev
          FROM dopaios_output_versions o
          JOIN dopaios_work_items w ON w.id = o.work_item_id
          JOIN dopaios_sop_runs r ON r.id = w.run_id
          WHERE o.state = 'CHECK_PASSED' AND w.state = 'COMPLETED' AND r.state = 'RUNNING'
          ORDER BY o.id`,
    )) {
      await fire(actions, "advance-to-decision", output.run_id, () =>
        advanceToDecision(db, `AUTO-ADV-${output.id}-r${output.revision}`, {
          runId: output.run_id,
          outputId: output.id,
          outputRevision: output.revision,
          packageId: `PKG-${output.run_id}`,
          packageRevision: output.next_pkg_rev,
          refs: { outputId: output.id, revision: output.revision, sha256: output.sha },
          // Vòng 1 giữ id yêu cầu của KC-13; vòng sau (SFR-053) mang suffix
          // revision gói để tất định theo đối tượng.
          requestId:
            output.next_pkg_rev === 1
              ? `REQ-${output.run_id}`
              : `REQ-${output.run_id}-p${output.next_pkg_rev}`,
        }),
      );
    }

    // S10 — đóng run máy-kiểm: CHỈ khi đã có quyết định của người (tồn tại
    // Yêu cầu DECIDED) và không còn nghĩa vụ mở (tập terminal thống nhất
    // với completeSopRun/cancelTestRun — SUPERSEDED-TARGET-CHANGED là
    // terminal của revision, DEV-009).
    for (const run of await rows<{ id: string }>(
      db,
      sql`SELECT r.id FROM dopaios_sop_runs r
          WHERE r.state = 'RUNNING'
            AND EXISTS (SELECT 1 FROM dopaios_action_requests q
                        WHERE q.run_id = r.id AND q.state = 'DECIDED')
            AND NOT EXISTS (SELECT 1 FROM dopaios_action_requests q
                            WHERE q.run_id = r.id
                              AND q.state NOT IN ('DECIDED','CLOSED','SUPERSEDED-TARGET-CHANGED'))
            AND NOT EXISTS (SELECT 1 FROM dopaios_work_items w
                            WHERE w.run_id = r.id AND w.state NOT IN ('COMPLETED','CANCELLED'))
            AND NOT EXISTS (SELECT 1 FROM dopaios_output_versions o
                            JOIN dopaios_work_items w2 ON w2.id = o.work_item_id
                            WHERE w2.run_id = r.id
                              AND o.state NOT IN ('APPROVED','ACCEPTED','REJECTED','REWORK_REQUIRED'))
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
      xc_id: string | null;
      xc_rev: number;
    }>(
      db,
      sql`SELECT a.id, a.work_item_id, a.lease_epoch, w.routed_to,
                 a.contract_id AS xc_id, a.contract_revision AS xc_rev
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
        // Claim idempotent replay = một instance khác đã thắng lượt này —
        // không chạy engine lần hai (finding review đối kháng).
        claimed = result["idempotentReplay"] !== true;
        return result;
      });
      if (!claimed) continue;

      // Phiên chạy theo ĐÚNG nội dung hợp đồng đã pin trên activation (steps
      // nằm trong fields đã hash) — config runner chỉ là fallback; pin không
      // chỉ để audit mà là thứ được thực thi (finding review đối kháng).
      const pinned = activation.xc_id
        ? await rows<{ fields: Json }>(
            db,
            sql`SELECT fields FROM dopaios_execution_contracts
                WHERE id = ${activation.xc_id} AND revision = ${Number(activation.xc_rev ?? 1)}`,
          )
        : [];
      const pinnedSteps = (pinned[0]?.fields?.["steps"] as string[] | undefined) ?? cfg.steps;

      const outcome = await runWorkItemSession(db, {
        sessionId: `SES-${activation.id}-e${epoch}`,
        agentId: activation.routed_to,
        adapter: cfg.engine(),
        contract: {
          workItemId: activation.work_item_id,
          contractRevision: Number(activation.xc_rev ?? 1),
          sopRef: `${cfg.sopRef.id}@${cfg.sopRef.revision}`,
          steps: pinnedSteps,
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
