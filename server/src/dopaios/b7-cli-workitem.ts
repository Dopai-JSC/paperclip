import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import { replayProjections, snapshotProjections } from "./event-store.js";
import {
  activateSopRun,
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "./commands.js";
import { detectStalledSessions } from "./sessions.js";
import {
  latestConfirmedCheckpoint,
  runWorkItemSession,
  type ExecutionContract,
} from "./engine.js";
import { ClaudeCliEngine } from "./claude-cli-engine.js";

// KC-02 B7: work-item THẬT qua `claude --print` trên DB container dopaios_kc02.
// Các mode chạy tuần tự bởi b7-drive.sh:
//   seed     — dựng chuỗi SOP → test run → activate (tạo work item WI-B7-CLI)
//   full     — phiên chạy trọn vòng đến TERMINAL succeeded
//   victim   — phiên bị kill -9 cả process group giữa chừng (mất process,
//              phiên Ở NGUYÊN RUNNING — không có handler nào kịp chạy)
//   watchdog <thresholdMs> — tick 5s/lần tới khi tuyên bố gián đoạn; in
//              detectionLatencyMs (đo NFR-8 thật: detectedAt − lastSignalAt)
//   retry    — successor relation=retry, resume từ checkpoint xác nhận cuối
//   report   — dump phiên + artifact + kiểm replay byte-identical (KC-01)
// Usage: DATABASE_URL=... CLAUDE_CLI_PATH=... CLAUDE_TOKEN_FILE=... \
//        B7_ARTIFACT_DIR=... B7_RUN_ID=... tsx src/dopaios/b7-cli-workitem.ts <mode>

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Mọi id mang suffix run-id từ drive script: chạy lại trên cùng DB không bao
// giờ đụng command id cũ (finding review — rerun với id cố định sẽ đốt một
// lần gọi CLI trả tiền rồi chết vì CommandPayloadMismatchError), và bằng
// chứng của các lần chạy hỏng vẫn nằm nguyên trong event log.
const RUN = requireEnv("B7_RUN_ID");
const WORK_ITEM = `WI-B7-${RUN}`;
const SES_FULL = `SES-B7-FULL-${RUN}`;
const SES_VICTIM = `SES-B7-VICTIM-${RUN}`;
const SES_RETRY = `SES-B7-RETRY-${RUN}`;
const AGENT = "AGENT-B7";

const GOAL =
  "Viết mô tả ngắn bằng tiếng Việt cho module 'entry kích hoạt của Dopaios': " +
  "nhận yêu cầu kích hoạt work-item, claim đúng-một-lần khi nhiều worker cạnh tranh, " +
  "chạy phiên AI, ghi kết quả khi xong.";

const contract: ExecutionContract = {
  workItemId: WORK_ITEM,
  contractRevision: 1,
  sopRef: { definitionId: "DEF-B7", revision: 1 },
  steps: ["phan-tich", "soan-thao", "tu-kiem"],
};

const db = createDb(requireEnv("DATABASE_URL"));

const engine = new ClaudeCliEngine({
  cliPath: requireEnv("CLAUDE_CLI_PATH"),
  tokenFile: requireEnv("CLAUDE_TOKEN_FILE"),
  artifactDir: requireEnv("B7_ARTIFACT_DIR"),
  heartbeatMs: 5_000,
  promptFor: (c, step, index) => {
    if (step === "phan-tich") {
      return `Yêu cầu: ${GOAL}\nLiệt kê đúng 3 gạch đầu dòng các ý chính cần có trong mô tả. Chỉ trả về 3 gạch đầu dòng, không thêm gì khác.`;
    }
    if (step === "soan-thao") {
      return `Yêu cầu: ${GOAL}\nSoạn đoạn mô tả 3–4 câu tiếng Việt hoàn chỉnh. Chỉ trả về đoạn văn, không thêm gì khác.`;
    }
    // tu-kiem: đọc output bước soạn thảo từ đĩa — chuỗi bước có phụ thuộc
    // thật, và file bước trước phải sống sót qua kill để retry dùng được.
    const draft = readFileSync(engine.stepFile(c.workItemId, index - 1), "utf8");
    return `Đoạn mô tả sau có đủ các ý: nhận yêu cầu kích hoạt, claim đúng-một-lần, chạy phiên AI, ghi kết quả không?\n---\n${draft}\n---\nTrả về đúng một dòng: "PASS" nếu đủ, hoặc "FAIL: <lý do>" nếu thiếu.`;
  },
});

async function seed(): Promise<void> {
  const sha = "b".repeat(64);
  await registerApprovedArtifact(db, "B7-SEED-ART", {
    artifactId: "SOP-B7",
    revision: 1,
    sha256: sha,
  });
  await createSopDefinition(db, "B7-SEED-DEF", {
    definitionId: "DEF-B7",
    revision: 1,
    sopPin: { artifactId: "SOP-B7", revision: 1, sha256: sha },
  });
  await publishSopDefinition(db, "B7-SEED-PUB", {
    definitionId: "DEF-B7",
    definitionContentSha256: sha,
    expectedSopSha256: sha,
  });
  await requestTestRun(db, `B7-SEED-RUN-${RUN}`, {
    runId: `RUN-B7-${RUN}`,
    definitionRef: { definitionId: "DEF-B7", revision: 1 },
    decider: "DECIDER-B7",
    pod: "POD-B7",
    fixturePackage: {},
  });
  await activateSopRun(db, `B7-SEED-ACT-${RUN}`, { runId: `RUN-B7-${RUN}`, workItemId: WORK_ITEM });
  console.log(`SEED-OK work_item=${WORK_ITEM}`);
}

async function runSession(sessionId: string): Promise<void> {
  const outcome = await runWorkItemSession(db, {
    sessionId,
    agentId: AGENT,
    adapter: engine,
    contract,
  });
  console.log(`SESSION-OUTCOME ${JSON.stringify(outcome)}`);
}

async function watchdog(thresholdMs: number): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 10 * 60_000;
  for (;;) {
    const nowMs = Date.now();
    if (nowMs - startedAt > timeoutMs) throw new Error("watchdog timed out after 10 minutes");
    const interrupted = await detectStalledSessions(db, { thresholdMs, nowMs });
    for (const hit of interrupted) {
      console.log(
        `WATCHDOG-INTERRUPTED session=${hit.sessionId} detection_latency_ms=${hit.detectionLatencyMs} threshold_ms=${thresholdMs} wall_clock_wait_ms=${nowMs - startedAt}`,
      );
    }
    if (interrupted.some((hit) => hit.sessionId === SES_VICTIM)) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function retry(): Promise<void> {
  const checkpoint = await latestConfirmedCheckpoint(db, SES_VICTIM);
  console.log(`RESUME-FROM ${JSON.stringify(checkpoint)}`);
  // Kịch bản đóng đinh: kill rơi giữa bước hai nên checkpoint xác nhận cuối
  // phải là index 0 → resume từ 1. Lệch nghĩa là kill quá muộn/quá sớm —
  // dừng TRƯỚC khi đốt tiền để người vận hành quyết.
  if (checkpoint?.nextStepIndex !== 1) {
    throw new Error(`RESUME-INDEX-UNEXPECTED: ${JSON.stringify(checkpoint)}`);
  }
  const outcome = await runWorkItemSession(db, {
    sessionId: SES_RETRY,
    agentId: AGENT,
    adapter: engine,
    contract,
    predecessor: { id: SES_VICTIM, relation: "retry" },
    resume: { nextStepIndex: checkpoint?.nextStepIndex ?? 0 },
  });
  console.log(`SESSION-OUTCOME ${JSON.stringify(outcome)}`);
}

async function report(): Promise<void> {
  const sessions = (await db.execute(sql`
    SELECT id, state, outcome, predecessor_id, relation, engine, detection_latency_ms,
           last_signal_at
    FROM dopaios_ai_sessions WHERE id IN (${SES_FULL}, ${SES_VICTIM}, ${SES_RETRY})
    ORDER BY id
  `)) as unknown as Array<Record<string, unknown>>;
  for (const row of sessions) console.log(`SESSION ${JSON.stringify(row)}`);

  const artifacts = (await db.execute(sql`
    SELECT session_id, seq, kind, ref, sha256, confirmed
    FROM dopaios_session_artifacts
    WHERE session_id IN (${SES_FULL}, ${SES_VICTIM}, ${SES_RETRY})
    ORDER BY session_id, seq
  `)) as unknown as Array<Record<string, unknown>>;
  for (const row of artifacts) console.log(`ARTIFACT ${JSON.stringify(row)}`);

  const before = await snapshotProjections(db);
  await replayProjections(db);
  const after = await snapshotProjections(db);
  console.log(`REPLAY-IDENTICAL=${JSON.stringify(before) === JSON.stringify(after)}`);
}

const mode = process.argv[2];
if (mode === "seed") await seed();
else if (mode === "full") await runSession(SES_FULL);
else if (mode === "victim") await runSession(SES_VICTIM);
else if (mode === "watchdog") await watchdog(Number(process.argv[3] ?? 60_000));
else if (mode === "retry") await retry();
else if (mode === "report") await report();
else {
  console.error("usage: b7-cli-workitem.ts <seed|full|victim|watchdog [thresholdMs]|retry|report>");
  process.exit(2);
}
process.exit(0);
