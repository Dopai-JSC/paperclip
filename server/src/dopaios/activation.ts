import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  executeCommand,
  CommandRejectedError,
} from "./event-store.js";
import {
  type EngineAdapter,
  type EngineRunInput,
  type EngineRunResult,
  type ExecutionContract,
  runWorkItemSession,
  type SessionRunOutcome,
} from "./engine.js";
import { executeAuditedCommand } from "./approval.js";
import { requireActiveContract } from "./contract.js";
import { requireClaimEligibility } from "./router.js";

// KC-02 B5: bề mặt kích hoạt mà KC-13 sẽ gọi (FS-003 SFR-011 — kích hoạt
// đúng-một-lần idempotent, claim compare-and-set theo DEV-010) và
// circuit-breaker chuỗi lỗi xác thực: hard-stop TRƯỚC khi gọi engine khi lỗi
// auth lặp quá ngưỡng (bài học upstream #9539) — điều kiện gác bắt buộc
// trước khi bind credential thật (V-01).

type Json = Record<string, unknown>;

export async function requestActivation(
  db: Db,
  commandId: string,
  payload: {
    activationId: string;
    workItemId: string;
    agentId: string;
    engine: string;
    // KC-13 B3: pin Hợp đồng thực hiện AI tại thời điểm yêu cầu kích hoạt —
    // phiên giữ pin này kể cả khi hợp đồng có revision mới (FR-63).
    contract?: { contractId: string; revision: number };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workItem = (await ctx.tx.execute(sql`
        SELECT state, project_id FROM dopaios_work_items WHERE id = ${p["workItemId"]}
      `)) as unknown as Array<{ state: string; project_id: string | null }>;
      if (workItem.length === 0) {
        throw new CommandRejectedError("ERR-WORKITEM", `Work item ${p["workItemId"]} not found`);
      }
      // KC-13 khóa cửa PREPARING (FS-001 SFR-003, FX-01-C13): work-item gắn
      // Project chỉ được mở Phiên chạy AI khi Project đã qua approval P0-01.
      // Fail-closed: mọi trạng thái ngoài P0_ACTIVE — kể cả Project không
      // tồn tại trong registry — đều chặn.
      if (workItem[0].project_id) {
        const project = (await ctx.tx.execute(sql`
          SELECT state FROM dopaios_projects WHERE id = ${workItem[0].project_id}
        `)) as unknown as Array<{ state: string }>;
        if (project.length === 0 || project[0].state !== "P0_ACTIVE") {
          throw new CommandRejectedError(
            "SFR-003",
            `Project ${workItem[0].project_id} does not allow AI sessions (state ${project[0]?.state ?? "unknown"}) — FS-001 SFR-003`,
          );
        }
      }
      const contractPin = p["contract"] as { contractId: string; revision: number } | undefined;
      if (contractPin) {
        // Fail-closed FR-63: hợp đồng phải active và đủ trường ngay tại
        // thời điểm xin kích hoạt — thiếu là AI không bắt đầu.
        await requireActiveContract(ctx, contractPin.contractId, contractPin.revision);
      }
      await ctx.emit({
        streamName: `dopaiosActivation-${p["activationId"]}`,
        type: "ActivationRequested",
        data: {
          activationId: p["activationId"],
          workItemId: p["workItemId"],
          agentId: p["agentId"],
          engine: p["engine"],
          contractId: contractPin?.contractId ?? null,
          contractRevision: contractPin?.revision ?? null,
        },
        expectedVersion: -1,
      });
      return { activationId: p["activationId"] as string, state: "QUEUED" };
    },
  });
}

// Claim compare-and-set: chỉ thắng khi activation còn QUEUED trên chính
// snapshot của transaction — hai claimer song song thì đúng một bên thắng.
// KC-13 B4: với work-item gắn Project, bốn điều kiện FR-15 được kiểm LẠI
// tại thời điểm claim (trạng thái có thể đã đổi từ lúc route) và claimer
// phải đúng Staff đã được định tuyến; đường run test KC-01/KC-02 giữ nguyên.
export async function claimActivation(
  db: Db,
  commandId: string,
  payload: {
    activationId: string;
    claimedBy: string;
    // KC-13 B5: lease TTL — claim bền vững giữa các lệnh nên claimer chết
    // phải thu hồi được (requeueExpiredActivations). Không lease = đường
    // KC-02 cũ, watchdog không thu hồi.
    lease?: { untilMs: number };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const rows = (await ctx.tx.execute(sql`
        SELECT state, work_item_id FROM dopaios_activations
        WHERE id = ${p["activationId"]} FOR UPDATE
      `)) as unknown as Array<{ state: string; work_item_id: string }>;
      if (rows.length === 0) {
        throw new CommandRejectedError("ERR-ACTIVATION", "Activation not found");
      }
      if (rows[0].state !== "QUEUED") {
        throw new CommandRejectedError("DEV-010", "Activation already claimed");
      }
      await requireClaimEligibility(ctx, {
        workItemId: rows[0].work_item_id,
        claimedBy: p["claimedBy"] as string,
      });
      const lease = p["lease"] as { untilMs: number } | undefined;
      await ctx.emit({
        streamName: `dopaiosActivation-${p["activationId"]}`,
        type: "ActivationClaimed",
        data: {
          activationId: p["activationId"],
          claimedBy: p["claimedBy"],
          leaseUntil: lease ? new Date(lease.untilMs).toISOString() : null,
        },
      });
      return { activationId: p["activationId"] as string, state: "RUNNING" };
    },
  });
}

export async function completeActivation(
  db: Db,
  commandId: string,
  payload: {
    activationId: string;
    outcome: string;
    // KC-13 B5: claimer giữ epoch của lượt claim mình — activation đã bị thu
    // hồi và giao lại (epoch tăng) thì claimer cũ ghi muộn bị chặn.
    leaseEpoch?: number;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const rows = (await ctx.tx.execute(sql`
        SELECT state, lease_epoch FROM dopaios_activations WHERE id = ${p["activationId"]}
      `)) as unknown as Array<{ state: string; lease_epoch: number }>;
      if (rows.length === 0 || rows[0].state !== "RUNNING") {
        throw new CommandRejectedError("ERR-ACTIVATION-STATE", "Activation is not RUNNING");
      }
      if (p["leaseEpoch"] !== undefined && Number(rows[0].lease_epoch) !== Number(p["leaseEpoch"])) {
        throw new CommandRejectedError(
          "ERR-LEASE-EPOCH",
          `Stale claimer: activation ${p["activationId"]} is at lease epoch ${rows[0].lease_epoch}, claimer holds ${p["leaseEpoch"]}`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosActivation-${p["activationId"]}`,
        type: "ActivationCompleted",
        data: { activationId: p["activationId"], outcome: p["outcome"] },
      });
      return { activationId: p["activationId"] as string, state: "DONE" };
    },
  });
}

// Đường trọn gói mà KC-13 sẽ dùng: claim → chạy phiên → ghi kết quả.
export async function runActivation(
  db: Db,
  input: {
    activationId: string;
    claimedBy: string;
    sessionId: string;
    agentId: string;
    adapter: EngineAdapter;
    contract: ExecutionContract;
  },
): Promise<SessionRunOutcome> {
  await claimActivation(db, `CMD-ACT-CLAIM-${input.activationId}`, {
    activationId: input.activationId,
    claimedBy: input.claimedBy,
  });
  const outcome = await runWorkItemSession(db, {
    sessionId: input.sessionId,
    agentId: input.agentId,
    adapter: input.adapter,
    contract: input.contract,
  });
  if (outcome.kind === "succeeded") {
    await completeActivation(db, `CMD-ACT-DONE-${input.activationId}`, {
      activationId: input.activationId,
      outcome: "succeeded",
    });
  }
  return outcome;
}

// ===== Circuit-breaker chuỗi lỗi xác thực =====

export class AuthError extends Error {
  constructor(message = "authentication failed (401)") {
    super(message);
    this.name = "AuthError";
  }
}

export class BreakerOpenError extends Error {
  constructor(readonly breakerId: string) {
    super(`auth circuit breaker OPEN for ${breakerId} — hard stop, no engine call`);
    this.name = "BreakerOpenError";
  }
}

export const AUTH_BREAKER_THRESHOLD = 3;

async function breakerState(
  db: Db,
  breakerId: string,
): Promise<{ state: string; consecutive_failures: number } | null> {
  const rows = (await db.execute(sql`
    SELECT state, consecutive_failures FROM dopaios_auth_breakers WHERE id = ${breakerId}
  `)) as unknown as Array<{ state: string; consecutive_failures: number }>;
  return rows[0] ?? null;
}

export async function recordAuthFailure(
  db: Db,
  commandId: string,
  payload: { breakerId: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const rows = (await ctx.tx.execute(sql`
        SELECT consecutive_failures FROM dopaios_auth_breakers
        WHERE id = ${p["breakerId"]} FOR UPDATE
      `)) as unknown as Array<{ consecutive_failures: number }>;
      const count = (rows[0]?.consecutive_failures ?? 0) + 1;
      await ctx.emit({
        streamName: `dopaiosAuthBreaker-${p["breakerId"]}`,
        type: "AuthFailureRecorded",
        data: { breakerId: p["breakerId"], count },
      });
      if (count >= AUTH_BREAKER_THRESHOLD) {
        await ctx.emit({
          streamName: `dopaiosAuthBreaker-${p["breakerId"]}`,
          type: "BreakerTripped",
          data: { breakerId: p["breakerId"] },
        });
      }
      return { breakerId: p["breakerId"] as string, count, open: count >= AUTH_BREAKER_THRESHOLD };
    },
  });
}

export async function resetAuthBreaker(
  db: Db,
  commandId: string,
  payload: { breakerId: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await ctx.emit({
        streamName: `dopaiosAuthBreaker-${p["breakerId"]}`,
        type: "BreakerReset",
        data: { breakerId: p["breakerId"] },
      });
      return { breakerId: p["breakerId"] as string, state: "CLOSED" };
    },
  });
}

// Wrapper adapter: kiểm breaker TRƯỚC khi gọi engine; lỗi auth được ghi
// nhận và tự trip khi chạm ngưỡng — mọi lần gọi sau bị chặn cứng cho tới
// khi người vận hành reset (không tự đóng lại, đúng tinh thần hard-stop).
export function withAuthBreaker(db: Db, adapter: EngineAdapter): EngineAdapter {
  return {
    name: `${adapter.name}+breaker`,
    async execute(input: EngineRunInput): Promise<EngineRunResult> {
      const breakerId = `${adapter.name}:${input.contract.workItemId}`;
      const state = await breakerState(db, breakerId);
      if (state?.state === "OPEN") {
        throw new BreakerOpenError(breakerId);
      }
      try {
        return await adapter.execute(input);
      } catch (error) {
        if (error instanceof AuthError) {
          await recordAuthFailure(db, `CMD-AUTHFAIL-${breakerId}-${(state?.consecutive_failures ?? 0) + 1}`, {
            breakerId,
          });
        }
        throw error;
      }
    },
  };
}
