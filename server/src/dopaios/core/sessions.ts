import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandContext,
  type CommandResult,
  executeCommand,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";
import { requireApprovedContextPackage } from "./context-package.js";

// KC-02 spike: record Phiên chạy AI theo work-item trên event store KC-01,
// đúng ngữ nghĩa PRD Mục 3:
//  - mỗi phiên một stream event riêng — lịch sử hai phiên không bao giờ gộp;
//  - phiên mới liên kết predecessor qua (predecessorId, relation) với
//    relation ∈ {retry, continue, reassign}; KHÔNG mở lại phiên terminal;
//  - artifact (checkpoint/output) đã xác nhận lưu là immutable, append-only
//    theo seq;
//  - tín hiệu hoạt động (AiSessionSignal) nuôi watchdog phát hiện gián đoạn:
//    định nghĩa đo NFR-8 của spike = detectedAt − lastSignalAt, ghi vào event
//    AiSessionInterrupted (detectionLatencyMs) — ngưỡng mục tiêu ≤ 5 phút.

type Json = Record<string, unknown>;

type SessionRow = {
  state: string;
  agent_id: string;
  work_item_id: string;
  outcome: string | null;
  last_signal_at: Date | string | null;
  context_package_id: string | null;
  context_package_revision: number | null;
  context_package_sha256: string | null;
};

async function loadSession(ctx: CommandContext, sessionId: string): Promise<SessionRow | null> {
  const rows = (await ctx.tx.execute(sql`
    SELECT state, agent_id, work_item_id, outcome, last_signal_at,
           context_package_id, context_package_revision, context_package_sha256
    FROM dopaios_ai_sessions WHERE id = ${sessionId}
  `)) as unknown as SessionRow[];
  return rows[0] ?? null;
}

async function requireActorActiveIfRegistered(
  ctx: CommandContext,
  actorId: string,
): Promise<void> {
  const actors = (await ctx.tx.execute(sql`
    SELECT active FROM dopaios_actors WHERE id = ${actorId}
  `)) as unknown as Array<{ active: boolean }>;
  if (actors[0] && !actors[0].active) {
    throw new CommandRejectedError(
      "ERR-AUTH-REVOKED",
      `Actor ${actorId} was revoked before the next session action`,
    );
  }
}

async function requireSessionActorAuthorized(
  ctx: CommandContext,
  session: SessionRow,
): Promise<void> {
  await requireActorActiveIfRegistered(ctx, session.agent_id);
}

function sessionStream(sessionId: string): string {
  return `dopaiosAiSession-${sessionId}`;
}

// KC-05 B7 (blocker vòng review đối kháng — lens tương tranh): một work-item
// chỉ có MỘT phiên RUNNING tại một thời điểm. Trước đây cấm "hai tác nhân
// cùng ghi" chỉ đứng ở tầng activation (epoch fence lúc HOÀN TẤT); requeue
// chạy trước watchdog thì claimer mới mở được phiên thứ hai song song với
// phiên treo của claimer cũ và cả hai cùng ghi checkpoint hợp lệ. Guard này
// đóng lỗ ở tầng phiên: phiên cũ phải rời RUNNING (watchdog interrupt hoặc
// terminal) trước khi phiên mới của cùng work-item được mở — đọc projection
// trong cùng transaction SERIALIZABLE nên hai lệnh start đua nhau cũng chỉ
// một bên thắng (PRD Mục 3, AC-FR-12.2 tinh thần "một kết quả thắng").
async function requireNoRunningSession(ctx: CommandContext, workItemId: string): Promise<void> {
  const running = (await ctx.tx.execute(sql`
    SELECT id FROM dopaios_ai_sessions WHERE work_item_id = ${workItemId} AND state = 'RUNNING'
  `)) as unknown as Array<{ id: string }>;
  if (running.length > 0) {
    throw new CommandRejectedError(
      "ERR-SESSION-CONFLICT",
      `Work item ${workItemId} đang có phiên RUNNING ${running[0].id} — interrupt/kết thúc phiên đó trước`,
    );
  }
}

export async function startAiSession(
  db: Db,
  commandId: string,
  payload: {
    sessionId: string;
    workItemId: string;
    agentId: string;
    engine: string;
    contextPackageRef?: { id: string; revision: number; sha256: string };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await requireActorActiveIfRegistered(ctx, p["agentId"] as string);
      const workItem = (await ctx.tx.execute(sql`
        SELECT id, project_id FROM dopaios_work_items WHERE id = ${p["workItemId"]}
      `)) as unknown as Array<{ id: string; project_id: string | null }>;
      if (workItem.length === 0) {
        throw new CommandRejectedError("ERR-WORKITEM", `Work item ${p["workItemId"]} not found`);
      }
      const contextPackageRef = p["contextPackageRef"] as
        | { id: string; revision: number; sha256: string }
        | undefined;
      if (contextPackageRef) {
        if (!workItem[0].project_id) {
          throw new CommandRejectedError("ERR-CONTEXT-PIN", "Context Package session requires a Project-bound work item");
        }
        await requireApprovedContextPackage(ctx, contextPackageRef, {
          projectId: workItem[0].project_id,
          workItemId: p["workItemId"] as string,
        });
      }
      await requireNoRunningSession(ctx, p["workItemId"] as string);
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionStarted",
        data: {
          sessionId: p["sessionId"],
          workItemId: p["workItemId"],
          agentId: p["agentId"],
          engine: p["engine"],
          contextPackageId: contextPackageRef?.id ?? null,
          contextPackageRevision: contextPackageRef?.revision ?? null,
          contextPackageSha256: contextPackageRef?.sha256 ?? null,
        },
        expectedVersion: -1,
      });
      return { sessionId: p["sessionId"] as string, state: "RUNNING" };
    },
  });
}

export async function recordSessionSignal(
  db: Db,
  commandId: string,
  payload: { sessionId: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || session.state !== "RUNNING") {
        throw new CommandRejectedError("ERR-SESSION-STATE", "Session is not RUNNING");
      }
      await requireSessionActorAuthorized(ctx, session);
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionSignal",
        data: { sessionId: p["sessionId"] },
      });
      return { sessionId: p["sessionId"] as string };
    },
  });
}

export async function recordSessionArtifact(
  db: Db,
  commandId: string,
  payload: {
    sessionId: string;
    seq: number;
    kind: string;
    ref: string;
    sha256: string;
    confirmed: boolean;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || session.state !== "RUNNING") {
        throw new CommandRejectedError("ERR-SESSION-STATE", "Session is not RUNNING");
      }
      await requireSessionActorAuthorized(ctx, session);
      const existing = (await ctx.tx.execute(sql`
        SELECT seq FROM dopaios_session_artifacts
        WHERE session_id = ${p["sessionId"]} AND seq = ${p["seq"]}
      `)) as unknown as unknown[];
      if (existing.length > 0) {
        throw new CommandRejectedError(
          "ERR-ARTIFACT-IMMUTABLE",
          "Artifact seq already recorded — confirmed artifacts are immutable",
        );
      }
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionArtifactRecorded",
        data: {
          sessionId: p["sessionId"],
          seq: p["seq"],
          kind: p["kind"],
          ref: p["ref"],
          sha256: p["sha256"],
          confirmed: p["confirmed"],
        },
      });
      return { sessionId: p["sessionId"] as string, seq: p["seq"] as number };
    },
  });
}

// KC-11: usage của một bước engine (một lần gọi CLI/model). Cost mang dạng
// CHUỖI đã quantize 8 chữ số thập phân — caller tính qua module pricing đã
// pin; handler chỉ kiểm bất biến và ghi event, nên replay không tái tính và
// byte-identical. Seq bất biến như artifact: ghi trùng seq bị từ chối.
export async function recordSessionUsage(
  db: Db,
  commandId: string,
  payload: {
    sessionId: string;
    seq: number;
    step: string;
    model: string;
    billingType: string;
    inputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
    costUsdReported: string | null;
    costUsdComputed: string;
    priceSource: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || session.state !== "RUNNING") {
        throw new CommandRejectedError("ERR-SESSION-STATE", "Session is not RUNNING");
      }
      await requireSessionActorAuthorized(ctx, session);
      for (const key of [
        "inputTokens",
        "cachedInputTokens",
        "cacheCreationInputTokens",
        "outputTokens",
      ] as const) {
        const value = p[key];
        if (!Number.isInteger(value) || (value as number) < 0) {
          throw new CommandRejectedError("ERR-USAGE-TOKENS", `${key} must be a non-negative integer`);
        }
      }
      const costPattern = /^\d+\.\d{8}$/u;
      const computed = p["costUsdComputed"];
      if (typeof computed !== "string" || !costPattern.test(computed)) {
        throw new CommandRejectedError(
          "ERR-USAGE-COST",
          "costUsdComputed must be a decimal string with 8 fraction digits",
        );
      }
      const reported = p["costUsdReported"];
      if (reported !== null && (typeof reported !== "string" || !costPattern.test(reported))) {
        throw new CommandRejectedError(
          "ERR-USAGE-COST",
          "costUsdReported must be null or a decimal string with 8 fraction digits",
        );
      }
      const existing = (await ctx.tx.execute(sql`
        SELECT seq FROM dopaios_session_usage
        WHERE session_id = ${p["sessionId"]} AND seq = ${p["seq"]}
      `)) as unknown as unknown[];
      if (existing.length > 0) {
        throw new CommandRejectedError(
          "ERR-USAGE-IMMUTABLE",
          "Usage seq already recorded — usage rows are append-only",
        );
      }
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionUsageRecorded",
        data: {
          sessionId: p["sessionId"],
          seq: p["seq"],
          step: p["step"],
          model: p["model"],
          billingType: p["billingType"],
          inputTokens: p["inputTokens"],
          cachedInputTokens: p["cachedInputTokens"],
          cacheCreationInputTokens: p["cacheCreationInputTokens"],
          outputTokens: p["outputTokens"],
          costUsdReported: reported,
          costUsdComputed: computed,
          priceSource: p["priceSource"],
        },
      });
      return { sessionId: p["sessionId"] as string, seq: p["seq"] as number };
    },
  });
}

// KC-11: cảnh báo sắp chạm trần chi phí (FR-38 — sắp chạm thì cảnh báo).
// Ghi một lần cho mỗi phiên; số quan sát đóng băng trong event.
export async function recordBudgetWarning(
  db: Db,
  commandId: string,
  payload: { sessionId: string; limitUsd: string; observedUsd: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || session.state !== "RUNNING") {
        throw new CommandRejectedError("ERR-SESSION-STATE", "Session is not RUNNING");
      }
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionBudgetWarned",
        data: {
          sessionId: p["sessionId"],
          limitUsd: p["limitUsd"],
          observedUsd: p["observedUsd"],
        },
      });
      return { sessionId: p["sessionId"] as string };
    },
  });
}

// KC-11: chạm trần chi phí của Hợp đồng thực hiện AI (limits.costUsd) —
// hard-stop theo FR-38: dừng, không tiếp tục âm thầm; overshoot đóng băng
// trong event làm số đo cho NFR-2/ADR budget.
export async function recordBudgetStop(
  db: Db,
  commandId: string,
  payload: { sessionId: string; limitUsd: string; observedUsd: string; overshootUsd: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || session.state !== "RUNNING") {
        throw new CommandRejectedError("ERR-SESSION-STATE", "Session is not RUNNING");
      }
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionBudgetStopped",
        data: {
          sessionId: p["sessionId"],
          limitUsd: p["limitUsd"],
          observedUsd: p["observedUsd"],
          overshootUsd: p["overshootUsd"],
        },
      });
      return { sessionId: p["sessionId"] as string, overshootUsd: p["overshootUsd"] as string };
    },
  });
}

// Watchdog interruption. The caller (watchdog tick) supplies its clock; the
// detection latency is computed against last_signal_at on the SAME snapshot
// and frozen into the event — this is the NFR-8 measurement of the spike.
export async function interruptSession(
  db: Db,
  commandId: string,
  payload: { sessionId: string; detectedAtMs: number; reason: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || session.state !== "RUNNING") {
        throw new CommandRejectedError("ERR-SESSION-STATE", "Session is not RUNNING");
      }
      const lastSignal = session.last_signal_at
        ? new Date(session.last_signal_at).getTime()
        : 0;
      const detectionLatencyMs = Math.max(0, (p["detectedAtMs"] as number) - lastSignal);
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionInterrupted",
        data: {
          sessionId: p["sessionId"],
          reason: p["reason"],
          detectionLatencyMs,
        },
      });
      return { sessionId: p["sessionId"] as string, detectionLatencyMs };
    },
  });
}

export async function completeSession(
  db: Db,
  commandId: string,
  payload: { sessionId: string; outcome: "succeeded" | "failed" | "abandoned" | "budget_stopped" },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const session = await loadSession(ctx, p["sessionId"] as string);
      if (!session || (session.state !== "RUNNING" && session.state !== "INTERRUPTED")) {
        throw new CommandRejectedError(
          "ERR-SESSION-TERMINAL",
          "Only RUNNING or INTERRUPTED sessions can reach terminal",
        );
      }
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionTerminal",
        data: { sessionId: p["sessionId"], outcome: p["outcome"] },
      });
      return { sessionId: p["sessionId"] as string, outcome: p["outcome"] as string };
    },
  });
}

// Successor per PRD Mục 3: a new session linked to its predecessor — never a
// reopen. Allowed from INTERRUPTED (retry/continue/reassign) or a failed
// terminal (retry/reassign); a reassign must change the agent.
export async function createSuccessorSession(
  db: Db,
  commandId: string,
  payload: {
    sessionId: string;
    predecessorId: string;
    relation: "retry" | "continue" | "reassign";
    agentId: string;
    engine: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const predecessor = await loadSession(ctx, p["predecessorId"] as string);
      if (!predecessor) {
        throw new CommandRejectedError("ERR-PREDECESSOR", "Predecessor session not found");
      }
      if (predecessor.state === "RUNNING") {
        throw new CommandRejectedError(
          "ERR-PREDECESSOR-RUNNING",
          "Predecessor is still RUNNING — interrupt or complete it first",
        );
      }
      if (predecessor.state === "TERMINAL" && predecessor.outcome === "succeeded") {
        throw new CommandRejectedError(
          "ERR-TERMINAL-REOPEN",
          "A succeeded terminal session never gets a successor",
        );
      }
      if (p["relation"] === "reassign" && p["agentId"] === predecessor.agent_id) {
        throw new CommandRejectedError("ERR-REASSIGN-SAME-AGENT", "Reassign must change the agent");
      }
      const inheritedContextRef = predecessor.context_package_id
        ? {
            id: predecessor.context_package_id,
            revision: Number(predecessor.context_package_revision),
            sha256: predecessor.context_package_sha256!,
          }
        : null;
      if (inheritedContextRef) {
        const workItem = (await ctx.tx.execute(sql`
          SELECT project_id FROM dopaios_work_items WHERE id = ${predecessor.work_item_id}
        `)) as unknown as Array<{ project_id: string | null }>;
        if (!workItem[0]?.project_id) {
          throw new CommandRejectedError("ERR-CONTEXT-PIN", "Inherited Context Package has no Project-bound work item");
        }
        await requireApprovedContextPackage(ctx, inheritedContextRef, {
          projectId: workItem[0].project_id,
          workItemId: predecessor.work_item_id,
        });
      }
      // KC-05 B7: kế nhiệm cũng không được mở khi work-item còn phiên RUNNING
      // khác (cùng bất biến một-work-item-một-phiên-RUNNING).
      await requireNoRunningSession(ctx, predecessor.work_item_id);
      await ctx.emit({
        streamName: sessionStream(p["sessionId"] as string),
        type: "AiSessionStarted",
        data: {
          sessionId: p["sessionId"],
          workItemId: predecessor.work_item_id,
          agentId: p["agentId"],
          engine: p["engine"],
          predecessorId: p["predecessorId"],
          relation: p["relation"],
          contextPackageId: inheritedContextRef?.id ?? null,
          contextPackageRevision: inheritedContextRef?.revision ?? null,
          contextPackageSha256: inheritedContextRef?.sha256 ?? null,
        },
        expectedVersion: -1,
      });
      return { sessionId: p["sessionId"] as string, relation: p["relation"] as string };
    },
  });
}

// Watchdog tick: finds RUNNING sessions silent beyond the threshold on the
// caller's clock and interrupts each one idempotently (command id derived
// from session + last signal, so a repeated tick cannot double-fire).
export async function detectStalledSessions(
  db: Db,
  input: { thresholdMs: number; nowMs: number },
): Promise<Array<{ sessionId: string; detectionLatencyMs: number }>> {
  const stalled = (await db.execute(sql`
    SELECT id, last_signal_at FROM dopaios_ai_sessions
    WHERE state = 'RUNNING'
      AND last_signal_at < to_timestamp(${(input.nowMs - input.thresholdMs) / 1000})
  `)) as unknown as Array<{ id: string; last_signal_at: Date | string }>;

  const interrupted: Array<{ sessionId: string; detectionLatencyMs: number }> = [];
  for (const row of stalled) {
    const lastSignalMs = new Date(row.last_signal_at).getTime();
    const result = await interruptSession(db, `WATCHDOG-${row.id}-${lastSignalMs}`, {
      sessionId: row.id,
      detectedAtMs: input.nowMs,
      reason: "no-progress",
    });
    interrupted.push({
      sessionId: row.id,
      detectionLatencyMs: result["detectionLatencyMs"] as number,
    });
  }
  return interrupted;
}
