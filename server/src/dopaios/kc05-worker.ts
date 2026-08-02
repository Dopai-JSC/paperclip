import { createDb } from "@paperclipai/db";
import { claimActivation, completeActivation } from "./activation.js";
import { FakeEngine, runWorkItemSession, type EngineAdapter } from "./engine.js";
import { requireActiveWorkspace, resolveScopedPath } from "./workspace.js";
import { workspaceBoundEngine } from "./workspace-fs.js";

// KC-05 B4: worker THẬT — tiến trình con do test spawn rồi SIGKILL giữa chừng
// (QD-4 kế hoạch KC-05). Worker claim activation với lease + epoch, chạy phiên
// FakeEngine gắn workspace với nhịp chậm theo từng bước (đủ cửa sổ để cha
// giết đúng lúc đang giữ claim và vừa ghi checkpoint đầu). Marker trên stdout
// cho cha đồng bộ: KC05-CLAIMED → KC05-CKPT step=<s> → KC05-DONE.
//
// "Dừng đột ngột" nghĩa là SIGKILL: không cleanup, không catch — claim, lease,
// phiên RUNNING và artifact đã ghi nằm nguyên trong DB/đĩa; thu hồi là việc
// của watchdog KC-02 + requeue theo epoch KC-13, không phải của worker.

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

  await claimActivation(db, `KC05-B4-CLAIM-${ACTIVATION_ID}-e${EPOCH}`, {
    activationId: ACTIVATION_ID,
    claimedBy: AGENT_ID,
    lease: { untilMs: Date.now() + LEASE_MS },
  });
  console.log("KC05-CLAIMED");

  const bound = workspaceBoundEngine(new FakeEngine(), { wsAbs, cacheAbs });
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
