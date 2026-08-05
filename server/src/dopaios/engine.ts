import { sql } from "drizzle-orm";
import { type Db, payloadSha256 } from "./event-store.js";
import { computeCostUsd, PRICE_SOURCE } from "./pricing.js";
import {
  completeSession,
  createSuccessorSession,
  recordBudgetStop,
  recordBudgetWarning,
  recordSessionArtifact,
  recordSessionSignal,
  recordSessionUsage,
  startAiSession,
} from "./sessions.js";

// KC-02 B3: adapter interface tối giản theo hình ACP (chỉ interface — không
// nhận dependency acpx alpha) và bám contract adapter của fork: execute nhận
// ngữ cảnh + sessionParams để resume, trả kết quả kèm sessionParams mới.
// FakeEngine mô phỏng engine thật đủ cho walking skeleton: phát tín hiệu theo
// bước, chết cứng giữa chừng (throw EngineCrashError — với runner nghĩa là
// mất process, KHÔNG phải kết thúc phiên), và resume từ checkpoint.

export type ExecutionContract = {
  workItemId: string;
  contractRevision: number;
  sopRef: Record<string, unknown>;
  steps: string[];
  contextPackageRef?: { id: string; revision: number; sha256: string };
};

export type EngineSessionParams = Record<string, unknown>;

// KC-11: usage của một bước engine — một lần gọi CLI/model. costUsdReported
// là số adapter tự báo (null khi đường không báo, ví dụ Codex); token là số
// nguyên không âm. Cost chuỗi 8 chữ số thập phân do tầng trên quantize.
export type StepUsage = {
  step: string;
  model: string;
  billingType: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsdReported: string | null;
};

export type EngineRunInput = {
  sessionId: string;
  contract: ExecutionContract;
  resume?: EngineSessionParams;
  onSignal: (payload: { step: string }) => Promise<void>;
  onCheckpoint: (payload: { step: string; ref: string; sha256: string }) => Promise<void>;
  // KC-11: gọi SAU checkpoint của bước (bước đã bền — successor resume qua
  // được bước này kể cả khi budget dừng ngay sau đó).
  onUsage?: (usage: StepUsage) => Promise<void>;
};

export type EngineRunResult = {
  status: "succeeded";
  sessionParams: EngineSessionParams;
  output: { ref: string; sha256: string };
};

export interface EngineAdapter {
  readonly name: string;
  execute(input: EngineRunInput): Promise<EngineRunResult>;
}

export class EngineCrashError extends Error {
  constructor(readonly afterStep: string) {
    super(`engine process lost after step ${afterStep}`);
    this.name = "EngineCrashError";
  }
}

// FakeEngine: chạy tuần tự các bước của hợp đồng, mỗi bước một tín hiệu +
// một checkpoint; `crashAfterStep` giả lập process chết sau bước đó (lần
// dùng một lần rồi tự xóa để lần resume sau chạy tiếp). KC-11: mỗi bước phát
// một usage tất định (cấu hình qua constructor) để contract test đo chi phí
// không cần token thật.
export type FakeStepUsage = {
  model: string;
  billingType: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsdReported: string | null;
};

export class FakeEngine implements EngineAdapter {
  readonly name = "fake-acp-shape";
  private crashPlan: string[];
  private readonly stepUsage: FakeStepUsage | null;

  constructor(crashPlan: string[] = [], stepUsage: FakeStepUsage | null = null) {
    this.crashPlan = [...crashPlan];
    this.stepUsage = stepUsage;
  }

  async execute(input: EngineRunInput): Promise<EngineRunResult> {
    const startIndex = typeof input.resume?.["nextStepIndex"] === "number"
      ? (input.resume["nextStepIndex"] as number)
      : 0;
    for (let index = startIndex; index < input.contract.steps.length; index += 1) {
      const step = input.contract.steps[index];
      await input.onSignal({ step });
      await input.onCheckpoint({
        step,
        ref: `ckpt/${input.sessionId}/${index}`,
        sha256: payloadSha256({ sessionId: input.sessionId, step, index }),
      });
      if (this.stepUsage && input.onUsage) {
        await input.onUsage({ step, ...this.stepUsage });
      }
      if (this.crashPlan[0] === step) {
        this.crashPlan.shift();
        throw new EngineCrashError(step);
      }
    }
    return {
      status: "succeeded",
      sessionParams: { nextStepIndex: input.contract.steps.length },
      output: {
        ref: `out/${input.contract.workItemId}`,
        sha256: payloadSha256({ workItem: input.contract.workItemId, steps: input.contract.steps }),
      },
    };
  }
}

export type SessionRunOutcome =
  | { kind: "succeeded"; sessionId: string }
  | { kind: "process-lost"; sessionId: string; afterStep: string }
  | {
      kind: "budget-stopped";
      sessionId: string;
      afterStep: string;
      limitUsd: string;
      observedUsd: string;
      overshootUsd: string;
    };

// KC-11: trần chi phí của Hợp đồng thực hiện AI (limits.costUsd) áp tại ranh
// bước — đơn vị nguyên tử là một lần gọi CLI/model, nên overshoot bị chặn
// trên bởi chi phí đúng một bước. priorChainCostUsd cộng chi phí các phiên
// trước trong chuỗi retry/continue/reassign để trần áp theo WORK-ITEM chứ
// không reset theo phiên.
export type SessionBudget = {
  costUsdLimit: number;
  warnAtFraction?: number;
  priorChainCostUsd?: number;
};

export class BudgetStopError extends Error {
  constructor(
    readonly afterStep: string,
    readonly limitUsd: string,
    readonly observedUsd: string,
    readonly overshootUsd: string,
  ) {
    super(`budget hard-stop after step ${afterStep}: observed ${observedUsd} >= limit ${limitUsd}`);
    this.name = "BudgetStopError";
  }
}

// Chạy một phiên cho một work-item dưới Hợp đồng thực hiện AI. Mọi bước đi
// qua tầng lệnh (event trước projection); khi engine chết cứng thì phiên Ở
// NGUYÊN trạng thái RUNNING — gián đoạn là việc của watchdog phát hiện qua
// im lặng, không phải của runner.
export async function runWorkItemSession(
  db: Db,
  input: {
    sessionId: string;
    agentId: string;
    adapter: EngineAdapter;
    contract: ExecutionContract;
    predecessor?: { id: string; relation: "retry" | "continue" | "reassign" };
    resume?: EngineSessionParams;
    budget?: SessionBudget;
  },
): Promise<SessionRunOutcome> {
  const contractSha = payloadSha256(input.contract);
  if (input.predecessor) {
    await createSuccessorSession(db, `CMD-SES-START-${input.sessionId}`, {
      sessionId: input.sessionId,
      predecessorId: input.predecessor.id,
      relation: input.predecessor.relation,
      agentId: input.agentId,
      engine: input.adapter.name,
    });
  } else {
    await startAiSession(db, `CMD-SES-START-${input.sessionId}`, {
      sessionId: input.sessionId,
      workItemId: input.contract.workItemId,
      agentId: input.agentId,
      engine: input.adapter.name,
      contextPackageRef: input.contract.contextPackageRef,
    });
  }

  let signalSeq = 0;
  let artifactSeq = 0;
  let usageSeq = 0;
  // KC-11: cộng dồn chi phí hiệu lực (reported nếu có, computed nếu không)
  // theo micro-USD nguyên (8 chữ số thập phân × 1e8) để so sánh trần không
  // dính lỗi float; trần áp theo work-item = priorChain + phiên hiện tại.
  const SCALE = 1e8;
  const toScaled = (cost: string): number => Math.round(Number(cost) * SCALE);
  const toCostString = (scaled: number): string => (scaled / SCALE).toFixed(8);
  let chainScaled = Math.round((input.budget?.priorChainCostUsd ?? 0) * SCALE);
  const limitScaled = input.budget ? Math.round(input.budget.costUsdLimit * SCALE) : null;
  const warnScaled = input.budget
    ? Math.round(input.budget.costUsdLimit * (input.budget.warnAtFraction ?? 0.8) * SCALE)
    : null;
  let warned = false;
  try {
    const result = await input.adapter.execute({
      sessionId: input.sessionId,
      contract: input.contract,
      resume: input.resume,
      onSignal: async ({ step }) => {
        signalSeq += 1;
        await recordSessionSignal(db, `CMD-SES-SIG-${input.sessionId}-${signalSeq}`, {
          sessionId: input.sessionId,
        });
        void step;
      },
      onCheckpoint: async ({ step, ref, sha256 }) => {
        artifactSeq += 1;
        await recordSessionArtifact(db, `CMD-SES-CKPT-${input.sessionId}-${artifactSeq}`, {
          sessionId: input.sessionId,
          seq: artifactSeq,
          kind: "checkpoint",
          ref,
          sha256,
          confirmed: true,
        });
        void step;
      },
      onUsage: async (usage) => {
        usageSeq += 1;
        const computed = computeCostUsd(usage.model, {
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          outputTokens: usage.outputTokens,
        });
        await recordSessionUsage(db, `CMD-SES-USE-${input.sessionId}-${usageSeq}`, {
          sessionId: input.sessionId,
          seq: usageSeq,
          step: usage.step,
          model: usage.model,
          billingType: usage.billingType,
          inputTokens: usage.inputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          outputTokens: usage.outputTokens,
          costUsdReported: usage.costUsdReported,
          costUsdComputed: computed,
          priceSource: PRICE_SOURCE,
        });
        chainScaled += toScaled(usage.costUsdReported ?? computed);
        if (limitScaled !== null && chainScaled >= limitScaled) {
          const observed = toCostString(chainScaled);
          const limit = toCostString(limitScaled);
          const overshoot = toCostString(chainScaled - limitScaled);
          await recordBudgetStop(db, `CMD-SES-BSTOP-${input.sessionId}`, {
            sessionId: input.sessionId,
            limitUsd: limit,
            observedUsd: observed,
            overshootUsd: overshoot,
          });
          throw new BudgetStopError(usage.step, limit, observed, overshoot);
        }
        if (warnScaled !== null && !warned && chainScaled >= warnScaled) {
          warned = true;
          await recordBudgetWarning(db, `CMD-SES-BWARN-${input.sessionId}`, {
            sessionId: input.sessionId,
            limitUsd: toCostString(limitScaled!),
            observedUsd: toCostString(chainScaled),
          });
        }
      },
    });
    artifactSeq += 1;
    await recordSessionArtifact(db, `CMD-SES-OUT-${input.sessionId}`, {
      sessionId: input.sessionId,
      seq: artifactSeq,
      kind: "output",
      ref: result.output.ref,
      sha256: result.output.sha256,
      confirmed: true,
    });
    await completeSession(db, `CMD-SES-DONE-${input.sessionId}`, {
      sessionId: input.sessionId,
      outcome: "succeeded",
    });
    void contractSha;
    return { kind: "succeeded", sessionId: input.sessionId };
  } catch (error) {
    if (error instanceof EngineCrashError) {
      return { kind: "process-lost", sessionId: input.sessionId, afterStep: error.afterStep };
    }
    if (error instanceof BudgetStopError) {
      // Hard-stop FR-38: phiên đóng terminal budget_stopped — không tiếp tục
      // âm thầm; checkpoint của bước đã bền nên successor (sau khi người nới
      // trần qua revision hợp đồng) resume được từ bước kế tiếp.
      await completeSession(db, `CMD-SES-DONE-${input.sessionId}`, {
        sessionId: input.sessionId,
        outcome: "budget_stopped",
      });
      return {
        kind: "budget-stopped",
        sessionId: input.sessionId,
        afterStep: error.afterStep,
        limitUsd: error.limitUsd,
        observedUsd: error.observedUsd,
        overshootUsd: error.overshootUsd,
      };
    }
    throw error;
  }
}

// Điểm resume cho successor: checkpoint đã xác nhận mới nhất của predecessor
// (đọc từ projection — nguồn có thể dựng lại từ event log).
export async function latestConfirmedCheckpoint(
  db: Db,
  sessionId: string,
): Promise<{ ref: string; sha256: string; nextStepIndex: number } | null> {
  const rows = (await db.execute(sql`
    SELECT ref, sha256 FROM dopaios_session_artifacts
    WHERE session_id = ${sessionId} AND kind = 'checkpoint' AND confirmed = true
    ORDER BY seq DESC LIMIT 1
  `)) as unknown as Array<{ ref: string; sha256: string }>;
  if (rows.length === 0) return null;
  const match = rows[0].ref.match(/\/(\d+)$/);
  return {
    ref: rows[0].ref,
    sha256: rows[0].sha256,
    nextStepIndex: match ? Number(match[1]) + 1 : 0,
  };
}
