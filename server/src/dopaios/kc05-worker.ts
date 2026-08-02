import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { CommandPayloadMismatchError } from "./event-store.js";
import { claimActivation, completeActivation } from "./activation.js";
import {
  FakeEngine,
  runWorkItemSession,
  latestConfirmedCheckpoint,
  type EngineAdapter,
  type EngineSessionParams,
} from "./engine.js";
import { requireActiveWorkspace, resolveScopedPath } from "./workspace.js";
import { workspaceBoundEngine } from "./workspace-fs.js";

// KC-05 B4/B7: worker THẬT — tiến trình con do test spawn rồi SIGKILL giữa
// chừng (QD-4 kế hoạch KC-05). Worker claim activation với lease + epoch, chạy
// phiên FakeEngine gắn workspace (kèm fence trạng thái) với nhịp chậm theo
// từng bước. Marker trên stdout cho cha đồng bộ: KC05-CLAIMED → KC05-CKPT
// step=<s> → KC05-DONE.
//
// "Dừng đột ngột" nghĩa là SIGKILL: không cleanup, không catch — claim, lease,
// phiên RUNNING và artifact đã ghi nằm nguyên trong DB/đĩa; thu hồi là việc
// của watchdog KC-02 + requeue theo epoch KC-13, không phải của worker.
//
// B7 (major review lens 1): trình tự KHỞI ĐỘNG LẠI nằm trong CHÍNH worker,
// không do test đạo diễn — worker nhìn phiên gần nhất của work-item: có phiên
// INTERRUPTED/failed thì mở phiên kế nhiệm (retry) và resume từ checkpoint đã
// xác nhận; còn phiên RUNNING thì KHÔNG chen (guard ERR-SESSION-CONFLICT của
// tầng lệnh cũng chặn), thoát chờ watchdog/requeue.

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Thiếu biến môi trường ${name}`);
  }
  return value;
}

const DATABASE_URL = env("KC05_DATABASE_URL");
const ACTIVATION_ID = env("KC05_ACTIVATION_ID");
const WORK_ITEM_ID = env("KC05_WORK_ITEM_ID");
const RELEASE_ID = env("KC05_RELEASE_ID");
const AGENT_ID = env("KC05_AGENT_ID");
const SESSION_ID = env("KC05_SESSION_ID");
const ROOT_ABS = env("KC05_ROOT_ABS");
const LEASE_MS = Number(env("KC05_LEASE_MS"));
const SLOW_MS = Number(env("KC05_SLOW_MS"));
const EPOCH = Number(process.env["KC05_EPOCH"] ?? "0");
const STEPS = ["plan", "build", "test"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL);
  const workspace = await requireActiveWorkspace(db, RELEASE_ID);
  const wsAbs = resolveScopedPath(ROOT_ABS, workspace.relPath);
  const cacheAbs = resolveScopedPath(ROOT_ABS, workspace.cacheRelPath);

  try {
    await claimActivation(db, `KC05-B4-CLAIM-${ACTIVATION_ID}-e${EPOCH}`, {
      activationId: ACTIVATION_ID,
      claimedBy: AGENT_ID,
      lease: { untilMs: Date.now() + LEASE_MS },
    });
  } catch (error) {
    // B7 (minor review lens 2): lần chạy trước cùng epoch đã claim xong rồi
    // chết — cùng command id, untilMs khác → mismatch không phải hỏng dữ
    // liệu; thoát êm chờ lease hết hạn và requeue cấp epoch mới.
    if (error instanceof CommandPayloadMismatchError) {
      console.log("KC05-ALREADY-CLAIMED epoch=" + EPOCH);
      process.exit(0);
    }
    throw error;
  }
  console.log("KC05-CLAIMED");

  // Phục hồi production-shaped: phiên gần nhất của work-item quyết định mở
  // mới hay kế nhiệm + điểm resume (AC-FR-47.1 checkpoint/recovery).
  const previous = (await db.execute(sql`
    SELECT id, state, outcome FROM dopaios_ai_sessions
    WHERE work_item_id = ${WORK_ITEM_ID}
    ORDER BY id DESC LIMIT 1
  `)) as unknown as Array<{ id: string; state: string; outcome: string | null }>;
  let predecessor: { id: string; relation: "retry" } | undefined;
  let resume: EngineSessionParams | undefined;
  if (previous.length > 0) {
    if (previous[0].state === "RUNNING") {
      console.log(`KC05-SESSION-BUSY ${previous[0].id}`);
      process.exit(0);
    }
    if (previous[0].state === "INTERRUPTED" || previous[0].outcome === "failed") {
      predecessor = { id: previous[0].id, relation: "retry" };
      const checkpoint = await latestConfirmedCheckpoint(db, previous[0].id);
      if (checkpoint) {
        resume = { nextStepIndex: checkpoint.nextStepIndex };
        console.log(`KC05-RESUME from=${previous[0].id} nextStepIndex=${checkpoint.nextStepIndex}`);
      }
    }
  }

  const bound = workspaceBoundEngine(
    new FakeEngine(),
    { wsAbs, cacheAbs },
    { db, workspaceId: workspace.id },
  );
  const slow: EngineAdapter = {
    name: bound.name,
    async execute(input) {
      return bound.execute({
        ...input,
        onCheckpoint: async (payload) => {
          await input.onCheckpoint(payload);
          console.log(`KC05-CKPT step=${payload.step}`);
          await sleep(SLOW_MS);
        },
      });
    },
  };

  const outcome = await runWorkItemSession(db, {
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    adapter: slow,
    contract: {
      workItemId: WORK_ITEM_ID,
      contractRevision: 1,
      sopRef: { id: "SOPDEF-KC05", revision: 1 },
      steps: STEPS,
    },
    predecessor,
    resume,
  });
  if (outcome.kind === "succeeded") {
    await completeActivation(db, `KC05-B4-DONE-${ACTIVATION_ID}-e${EPOCH}`, {
      activationId: ACTIVATION_ID,
      outcome: "succeeded",
      leaseEpoch: EPOCH,
    });
  }
  console.log(`KC05-DONE kind=${outcome.kind}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("KC05-WORKER-ERROR", error);
  process.exit(1);
});
