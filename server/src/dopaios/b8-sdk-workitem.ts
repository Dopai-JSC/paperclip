import { readFileSync } from "node:fs";
import pg from "pg";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDb } from "@paperclipai/db";
import { payloadSha256 } from "./event-store.js";
import {
  activateSopRun,
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "./commands.js";
import { completeSession, recordSessionArtifact, startAiSession } from "./sessions.js";
import { DopaiosSessionStore } from "./session-store/DopaiosSessionStore.js";

// KC-02 B8: cùng dạng work-item nhưng chạy qua Agent SDK 0.3.220 với
// DopaiosSessionStore mirror transcript vào Postgres (dual-write). Kịch bản
// mất host: turn1 chạy xong thì drive script XÓA sạch CLAUDE_CONFIG_DIR
// (transcript local mất hẳn), turn2 resume bằng session id — SDK phải
// materialize hội thoại THUẦN từ Postgres; giữ được mã bí mật của turn1 là
// bằng chứng resume đúng. Revert file làm bằng git worktree ở drive script
// (cấm enableFileCheckpointing khi dùng SessionStore tùy biến — theo pin
// khảo sát 30/07).
// Usage: DATABASE_URL=... CLAUDE_TOKEN_FILE=... B8_RUN_ID=... B8_CONFIG_DIR=...
//        B8_REPO=... tsx src/dopaios/b8-sdk-workitem.ts <turn1|turn2 <sdkSessionId>>

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const RUN = requireEnv("B8_RUN_ID");
const WORK_ITEM = `WI-B8-${RUN}`;
const SES = `SES-B8-${RUN}`;
const SECRET = `DOPAIOS-B8-${RUN}`;
const databaseUrl = requireEnv("DATABASE_URL");
const db = createDb(databaseUrl);
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new DopaiosSessionStore({ pool });

// Env whitelist cho subprocess SDK — cùng lý do với claude-cli-engine:
// không cho biến điều hướng auth/backend nào lọt vào child.
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"]) {
    if (process.env[name]) env[name] = process.env[name] as string;
  }
  env["CLAUDE_CONFIG_DIR"] = requireEnv("B8_CONFIG_DIR");
  env["CLAUDE_CODE_OAUTH_TOKEN"] = readFileSync(requireEnv("CLAUDE_TOKEN_FILE"), "utf8").trim();
  return env;
}

type TurnOutcome = { sdkSessionId: string; resultText: string };

async function runTurn(prompt: string, resume?: string): Promise<TurnOutcome> {
  let sdkSessionId = "";
  let resultText = "";
  const stream = query({
    prompt,
    options: {
      cwd: requireEnv("B8_REPO"),
      env: childEnv(),
      permissionMode: "acceptEdits",
      sessionStore: store,
      sessionStoreFlush: "eager",
      ...(resume ? { resume } : {}),
    },
  });
  for await (const message of stream) {
    const m = message as Record<string, unknown>;
    if (m["type"] === "system" && m["subtype"] === "init") {
      sdkSessionId = String(m["session_id"] ?? "");
      console.log(`SDK-INIT session_id=${sdkSessionId} model=${String(m["model"] ?? "?")}`);
    }
    if (m["type"] === "result") {
      resultText = String(m["result"] ?? "");
      console.log(
        `SDK-RESULT subtype=${String(m["subtype"] ?? "?")} turns=${String(m["num_turns"] ?? "?")}`,
      );
    }
  }
  return { sdkSessionId, resultText };
}

async function storeRows(sessionId: string): Promise<number> {
  const res = await pool.query(
    "SELECT count(*)::int AS n FROM claude_session_entries WHERE session_id = $1",
    [sessionId],
  );
  return res.rows[0]?.n ?? 0;
}

async function turn1(): Promise<void> {
  await store.ensureSchema();
  const sha = "c".repeat(64);
  await registerApprovedArtifact(db, "B8-SEED-ART", { artifactId: "SOP-B8", revision: 1, sha256: sha });
  await createSopDefinition(db, "B8-SEED-DEF", {
    definitionId: "DEF-B8",
    revision: 1,
    sopPin: { artifactId: "SOP-B8", revision: 1, sha256: sha },
  });
  await publishSopDefinition(db, "B8-SEED-PUB", {
    definitionId: "DEF-B8",
    definitionContentSha256: sha,
    expectedSopSha256: sha,
  });
  await requestTestRun(db, `B8-SEED-RUN-${RUN}`, {
    runId: `RUN-B8-${RUN}`,
    definitionRef: { definitionId: "DEF-B8", revision: 1 },
    decider: "DECIDER-B8",
    pod: "POD-B8",
    fixturePackage: {},
  });
  await activateSopRun(db, `B8-SEED-ACT-${RUN}`, { runId: `RUN-B8-${RUN}`, workItemId: WORK_ITEM });
  await startAiSession(db, `CMD-SES-START-${SES}`, {
    sessionId: SES,
    workItemId: WORK_ITEM,
    agentId: "AGENT-B8",
    engine: "agent-sdk-0.3.220",
  });

  const { sdkSessionId, resultText } = await runTurn(
    `Hãy nhớ mã bí mật của phiên làm việc này: ${SECRET}. ` +
      `Nhiệm vụ: tạo file ghichu-b8.md trong thư mục làm việc hiện tại với nội dung đúng một dòng: "Dopaios B8 demo - worktree revert". ` +
      `Tạo xong thì trả lời đúng một câu xác nhận, không nhắc lại mã bí mật.`,
  );
  if (!sdkSessionId) throw new Error("no SDK session id captured");

  await recordSessionArtifact(db, `CMD-SES-ART-${SES}-1`, {
    sessionId: SES,
    seq: 1,
    kind: "sdk-session",
    ref: `sdk/${sdkSessionId}`,
    sha256: payloadSha256({ sdkSessionId }),
    confirmed: true,
  });
  await recordSessionArtifact(db, `CMD-SES-ART-${SES}-2`, {
    sessionId: SES,
    seq: 2,
    kind: "output",
    ref: `sdk-out/${WORK_ITEM}/turn1`,
    sha256: payloadSha256({ resultText }),
    confirmed: true,
  });
  await completeSession(db, `CMD-SES-DONE-${SES}`, { sessionId: SES, outcome: "succeeded" });

  console.log(`TURN1-RESULT ${resultText.slice(0, 200)}`);
  console.log(`STORE-ROWS-AFTER-TURN1=${await storeRows(sdkSessionId)}`);
  console.log(`SDK_SESSION_ID=${sdkSessionId}`);
}

async function turn2(sdkSessionId: string): Promise<void> {
  console.log(`STORE-ROWS-BEFORE-TURN2=${await storeRows(sdkSessionId)}`);
  const { sdkSessionId: resumedId, resultText } = await runTurn(
    "Không dùng công cụ nào. Mã bí mật tôi dặn ở lượt trước là gì? Trả về đúng mã, không thêm gì khác.",
    sdkSessionId,
  );
  console.log(`TURN2-RESULT ${resultText.slice(0, 200)}`);
  console.log(`RESUMED-SESSION-ID=${resumedId}`);
  console.log(resultText.includes(SECRET) ? "B8-RESUME=PASS" : "B8-RESUME=FAIL");
  if (!resultText.includes(SECRET)) process.exitCode = 1;
}

const mode = process.argv[2];
try {
  if (mode === "turn1") await turn1();
  else if (mode === "turn2") {
    const sid = process.argv[3];
    if (!sid) throw new Error("turn2 requires <sdkSessionId>");
    await turn2(sid);
  } else {
    console.error("usage: b8-sdk-workitem.ts <turn1|turn2 <sdkSessionId>>");
    process.exitCode = 2;
  }
} finally {
  await pool.end();
}
process.exit(process.exitCode ?? 0);
