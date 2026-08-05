import { join } from "node:path";
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
import { completeSession } from "./sessions.js";
import {
  latestConfirmedCheckpoint,
  runWorkItemSession,
  type ExecutionContract,
  type SessionBudget,
} from "./engine.js";
import { ClaudeCliEngine } from "./claude-cli-engine.js";
import { workItemCostSummary } from "./cost-summary.js";

// KC-11 B4–B6: drill chi phí THẬT qua `claude --print` (stream-json).
// Modes (drive tuần tự từ shell, mọi id mang suffix B11_RUN_ID — nếp B7):
//   seed <n>                — SOP def + n work item WI-B11-<RUN>-<i>
//   long                    — MỘT phiên dài trên WI 1: KC11_STEPS bước, mỗi
//                             bước một đoạn ~KC11_WORDS từ; trần KC11_BUDGET_USD
//                             → đo overshoot thật tại hard-stop
//   run <i> <label>         — một phiên thường trên WI <i> (nhãn phiên <label>)
//   retry <i> <label>       — successor: KC11_PREDECESSOR + KC11_RELATION
//                             (+ KC11_AGENT khi reassign), resume từ checkpoint
//                             xác nhận cuối của predecessor
//   parallel <n> <offset>   — n phiên ĐỒNG THỜI trên WI offset..offset+n-1
//                             (V-13: đo thông lượng/throttling cùng seat)
//   report                  — dump phiên + usage + tổng work-item + replay check
// Env: DATABASE_URL, B11_RUN_ID, KC11_CLI_PATH, KC11_TOKEN_FILE,
//      KC11_ARTIFACT_DIR, KC11_CONFIG_BASE, KC11_BUDGET_USD?, KC11_WARN_FRACTION?,
//      KC11_PRIOR_CHAIN_USD?, KC11_STEPS?, KC11_WORDS?, KC11_CLI_TIMEOUT_MS?

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const RUN = requireEnv("B11_RUN_ID");
const AGENT = process.env["KC11_AGENT"] ?? "AGENT-B11";
const STEPS = Number(process.env["KC11_STEPS"] ?? 6);
const WORDS = Number(process.env["KC11_WORDS"] ?? 350);
const CLI_TIMEOUT_MS = Number(process.env["KC11_CLI_TIMEOUT_MS"] ?? 300_000);

const TOPICS = [
  "kien truc event store cua nen tang",
  "vong doi mot Phien chay AI",
  "tran chi phi va ngan sach theo work-item",
  "dinh tuyen va kich hoat work-item",
  "khoi phuc sau gian doan process",
  "doi soat usage voi bang gia da pin",
  "cua so quota thue bao va throttling",
  "bang chung kiem chung kien truc",
];

const db = createDb(requireEnv("DATABASE_URL"));

function workItemId(index: number): string {
  return `WI-B11-${RUN}-${index}`;
}

function contractFor(index: number, steps: number): ExecutionContract {
  return {
    workItemId: workItemId(index),
    contractRevision: 1,
    sopRef: { definitionId: `DEF-B11-${RUN}`, revision: 1 },
    steps: Array.from({ length: steps }, (_, i) => `buoc-${i + 1}`),
  };
}

function engineFor(sessionId: string): ClaudeCliEngine {
  return new ClaudeCliEngine({
    cliPath: requireEnv("KC11_CLI_PATH"),
    tokenFile: requireEnv("KC11_TOKEN_FILE"),
    artifactDir: join(requireEnv("KC11_ARTIFACT_DIR"), sessionId),
    configDir: join(requireEnv("KC11_CONFIG_BASE"), sessionId),
    cliTimeoutMs: CLI_TIMEOUT_MS,
    heartbeatMs: 5_000,
    promptFor: (_contract, _step, index) => {
      const topic = TOPICS[index % TOPICS.length];
      return (
        `Viết một đoạn văn tiếng Việt hoàn chỉnh khoảng ${WORDS} từ về chủ đề ` +
        `"${topic}" trong một nền tảng vận hành sản xuất phần mềm bằng AI. ` +
        `Chỉ trả về đoạn văn, không tiêu đề, không danh sách.`
      );
    },
  });
}

function budgetFromEnv(): SessionBudget | undefined {
  const limit = process.env["KC11_BUDGET_USD"];
  if (!limit) return undefined;
  return {
    costUsdLimit: Number(limit),
    warnAtFraction: process.env["KC11_WARN_FRACTION"]
      ? Number(process.env["KC11_WARN_FRACTION"])
      : undefined,
    priorChainCostUsd: process.env["KC11_PRIOR_CHAIN_USD"]
      ? Number(process.env["KC11_PRIOR_CHAIN_USD"])
      : undefined,
  };
}

async function seed(count: number): Promise<void> {
  const sha = "c".repeat(64);
  await registerApprovedArtifact(db, `B11-SEED-ART-${RUN}`, {
    artifactId: `SOP-B11-${RUN}`,
    revision: 1,
    sha256: sha,
  });
  await createSopDefinition(db, `B11-SEED-DEF-${RUN}`, {
    definitionId: `DEF-B11-${RUN}`,
    revision: 1,
    sopPin: { artifactId: `SOP-B11-${RUN}`, revision: 1, sha256: sha },
  });
  await publishSopDefinition(db, `B11-SEED-PUB-${RUN}`, {
    definitionId: `DEF-B11-${RUN}`,
    definitionContentSha256: sha,
    expectedSopSha256: sha,
  });
  for (let index = 1; index <= count; index += 1) {
    await requestTestRun(db, `B11-SEED-RUN-${RUN}-${index}`, {
      runId: `RUN-B11-${RUN}-${index}`,
      definitionRef: { definitionId: `DEF-B11-${RUN}`, revision: 1 },
      decider: "DECIDER-B11",
      pod: "POD-B11",
      fixturePackage: {},
    });
    await activateSopRun(db, `B11-SEED-ACT-${RUN}-${index}`, {
      runId: `RUN-B11-${RUN}-${index}`,
      workItemId: workItemId(index),
    });
  }
  console.log(`SEED-OK run=${RUN} work_items=${count}`);
}

type DrillOutcome = {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  wallMs: number;
  outcome: unknown;
  error: string | null;
};

async function driveSession(input: {
  sessionId: string;
  workItemIndex: number;
  steps: number;
  budget?: SessionBudget;
  predecessor?: { id: string; relation: "retry" | "continue" | "reassign" };
  resume?: { nextStepIndex: number };
}): Promise<DrillOutcome> {
  const startedAtMs = Date.now();
  try {
    const outcome = await runWorkItemSession(db, {
      sessionId: input.sessionId,
      agentId: AGENT,
      adapter: engineFor(input.sessionId),
      contract: contractFor(input.workItemIndex, input.steps),
      budget: input.budget,
      predecessor: input.predecessor,
      resume: input.resume,
    });
    const endedAtMs = Date.now();
    return {
      sessionId: input.sessionId,
      startedAtMs,
      endedAtMs,
      wallMs: endedAtMs - startedAtMs,
      outcome,
      error: null,
    };
  } catch (error) {
    // Lỗi CLI (kể cả thông điệp usage limit/429) là BẰNG CHỨNG — in nguyên văn
    // stderr đuôi, đóng phiên failed để không kẹt RUNNING, không retry ngầm.
    const message = error instanceof Error ? error.message : String(error);
    try {
      await completeSession(db, `CMD-SES-FAILDONE-${input.sessionId}`, {
        sessionId: input.sessionId,
        outcome: "failed",
      });
    } catch {
      // phiên có thể chưa mở được hoặc đã terminal — giữ lỗi gốc làm evidence
    }
    const endedAtMs = Date.now();
    return {
      sessionId: input.sessionId,
      startedAtMs,
      endedAtMs,
      wallMs: endedAtMs - startedAtMs,
      outcome: null,
      error: message,
    };
  }
}

async function report(): Promise<void> {
  const sessions = (await db.execute(sql`
    SELECT s.id, s.work_item_id, s.agent_id, s.engine, s.state, s.outcome,
           s.predecessor_id, s.relation, s.budget_state, s.detection_latency_ms,
           s.usage_input_tokens, s.usage_cached_input_tokens,
           s.usage_cache_creation_input_tokens, s.usage_output_tokens,
           s.usage_cost_usd_reported, s.usage_cost_usd_computed
    FROM dopaios_ai_sessions s
    WHERE s.work_item_id LIKE ${"WI-B11-" + RUN + "-%"}
    ORDER BY s.id
  `)) as unknown as Array<Record<string, unknown>>;
  for (const row of sessions) console.log(`SESSION ${JSON.stringify(row)}`);

  const usage = (await db.execute(sql`
    SELECT u.session_id, u.seq, u.step, u.model, u.billing_type, u.input_tokens,
           u.cached_input_tokens, u.cache_creation_input_tokens, u.output_tokens,
           u.cost_usd_reported, u.cost_usd_computed, u.price_source
    FROM dopaios_session_usage u
    JOIN dopaios_ai_sessions s ON s.id = u.session_id
    WHERE s.work_item_id LIKE ${"WI-B11-" + RUN + "-%"}
    ORDER BY u.session_id, u.seq
  `)) as unknown as Array<Record<string, unknown>>;
  for (const row of usage) console.log(`USAGE ${JSON.stringify(row)}`);

  const workItems = (await db.execute(sql`
    SELECT DISTINCT work_item_id FROM dopaios_ai_sessions
    WHERE work_item_id LIKE ${"WI-B11-" + RUN + "-%"} ORDER BY work_item_id
  `)) as unknown as Array<{ work_item_id: string }>;
  for (const row of workItems) {
    const summary = await workItemCostSummary(db, row.work_item_id);
    console.log(`WORKITEM-SUMMARY ${JSON.stringify(summary)}`);
  }

  const before = await snapshotProjections(db);
  await replayProjections(db);
  const after = await snapshotProjections(db);
  console.log(`REPLAY-IDENTICAL=${JSON.stringify(before) === JSON.stringify(after)}`);
}

const mode = process.argv[2];
if (mode === "seed") {
  await seed(Number(process.argv[3] ?? 1));
} else if (mode === "long") {
  const result = await driveSession({
    sessionId: `SES-B11-${RUN}-LONG`,
    workItemIndex: 1,
    steps: STEPS,
    budget: budgetFromEnv(),
  });
  console.log(`DRILL-OUTCOME ${JSON.stringify(result)}`);
} else if (mode === "run") {
  const index = Number(process.argv[3] ?? 1);
  const label = process.argv[4] ?? "RUN";
  const result = await driveSession({
    sessionId: `SES-B11-${RUN}-${label}`,
    workItemIndex: index,
    steps: STEPS,
    budget: budgetFromEnv(),
  });
  console.log(`DRILL-OUTCOME ${JSON.stringify(result)}`);
} else if (mode === "retry") {
  const index = Number(process.argv[3] ?? 1);
  const label = process.argv[4] ?? "RETRY";
  const predecessorId = requireEnv("KC11_PREDECESSOR");
  const relation = (process.env["KC11_RELATION"] ?? "retry") as "retry" | "continue" | "reassign";
  const checkpoint = await latestConfirmedCheckpoint(db, predecessorId);
  console.log(`RESUME-FROM ${JSON.stringify(checkpoint)}`);
  const result = await driveSession({
    sessionId: `SES-B11-${RUN}-${label}`,
    workItemIndex: index,
    steps: STEPS,
    budget: budgetFromEnv(),
    predecessor: { id: predecessorId, relation },
    resume: checkpoint ? { nextStepIndex: checkpoint.nextStepIndex } : undefined,
  });
  console.log(`DRILL-OUTCOME ${JSON.stringify(result)}`);
} else if (mode === "parallel") {
  const n = Number(process.argv[3] ?? 2);
  const offset = Number(process.argv[4] ?? 2);
  const batchStartMs = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      driveSession({
        sessionId: `SES-B11-${RUN}-PAR${offset + i}`,
        workItemIndex: offset + i,
        steps: STEPS,
      }),
    ),
  );
  const batchWallMs = Date.now() - batchStartMs;
  for (const result of results) console.log(`DRILL-OUTCOME ${JSON.stringify(result)}`);
  console.log(
    `PARALLEL-SUMMARY ${JSON.stringify({
      n,
      batchWallMs,
      succeeded: results.filter((r) => (r.outcome as { kind?: string } | null)?.kind === "succeeded").length,
      failed: results.filter((r) => r.error !== null).length,
      maxSessionWallMs: Math.max(...results.map((r) => r.wallMs)),
      minSessionWallMs: Math.min(...results.map((r) => r.wallMs)),
    })}`,
  );
} else if (mode === "report") {
  await report();
} else {
  console.error(
    "usage: b11-cost-drill.ts <seed [n]|long|run <i> <label>|retry <i> <label>|parallel <n> <offset>|report>",
  );
  process.exit(2);
}
process.exit(0);
