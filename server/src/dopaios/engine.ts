import { sql } from "drizzle-orm";
import { type Db, payloadSha256 } from "./event-store.js";
import {
  completeSession,
  createSuccessorSession,
  recordSessionArtifact,
  recordSessionSignal,
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

export type EngineRunInput = {
  sessionId: string;
  contract: ExecutionContract;
  resume?: EngineSessionParams;
  onSignal: (payload: { step: string }) => Promise<void>;
  onCheckpoint: (payload: { step: string; ref: string; sha256: string }) => Promise<void>;
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
// dùng một lần rồi tự xóa để lần resume sau chạy tiếp).
export class FakeEngine implements EngineAdapter {
  readonly name = "fake-acp-shape";
  private crashPlan: string[];

  constructor(crashPlan: string[] = []) {
    this.crashPlan = [...crashPlan];
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
  | { kind: "process-lost"; sessionId: string; afterStep: string };

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
