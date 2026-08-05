import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  activateSopRun,
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "../dopaios/commands.ts";
import { runWorkItemSession } from "../dopaios/engine.ts";
import {
  ClaudeCliEngine,
  parseClaudeStreamJson,
} from "../dopaios/claude-cli-engine.ts";

// KC-11 B2: ClaudeCliEngine đọc usage/total_cost_usd từ stream-json của
// `claude --print`. Test dùng STUB CLI (bash phát JSONL đóng hộp) — hợp đồng
// parse + luồng usage được kiểm tất định, không đốt token thật; số thật đo ở
// batch Lightsail.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-11 CLI engine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Stub phát đúng khuôn stream-json của CLI 2.1.220: system → assistant →
// result(total_cost_usd + usage bốn loại token + modelUsage một key).
// Mỗi lần gọi tăng biến đếm để nội dung từng bước khác nhau.
const STUB_SCRIPT = `#!/usr/bin/env bash
COUNT_FILE="\${STUB_DIR}/count"
N=$(cat "\$COUNT_FILE" 2>/dev/null || echo 0)
N=$((N+1)); echo \$N > "\$COUNT_FILE"
cat <<EOF
{"type":"system","subtype":"init","session_id":"stub-session"}
{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"dang lam buoc \$N"}]}}
{"type":"result","subtype":"success","is_error":false,"result":"KET-QUA buoc \$N","total_cost_usd":0.0123,"usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":4500,"output_tokens":800},"modelUsage":{"claude-sonnet-5":{"inputTokens":1200}}}
EOF
`;

// computed tại pin LiteLLM: 1200×2e-6 + 4500×2e-7 + 300×2.5e-6 + 800×1e-5
// = 0.0024 + 0.0009 + 0.00075 + 0.008 = 0.01205000; reported = 0.01230000.
const STEP_REPORTED = "0.01230000";
const STEP_COMPUTED = "0.01205000";

describeEmbeddedPostgres("dopaios KC-11 ClaudeCliEngine stream-json usage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let stubDir!: string;
  let stubCli!: string;
  let tokenFile!: string;
  let artifactDir!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc11cli-");
    db = createDb(tempDb.connectionString);
    const sha = "b".repeat(64);
    await registerApprovedArtifact(db, "C-SEED-ART", { artifactId: "SOP-C", revision: 1, sha256: sha });
    await createSopDefinition(db, "C-SEED-DEF", {
      definitionId: "DEF-C",
      revision: 1,
      sopPin: { artifactId: "SOP-C", revision: 1, sha256: sha },
    });
    await publishSopDefinition(db, "C-SEED-PUB", {
      definitionId: "DEF-C",
      definitionContentSha256: sha,
      expectedSopSha256: sha,
    });
    for (const [runId, workItemId] of [
      ["RUN-KC11-CLI-A", "WI-KC11-CLI-A"],
      ["RUN-KC11-CLI-B", "WI-KC11-CLI-B"],
    ] as const) {
      await requestTestRun(db, `C-SEED-RUN-${runId}`, {
        runId,
        definitionRef: { definitionId: "DEF-C", revision: 1 },
        decider: "DECIDER-1",
        pod: "POD-1",
        fixturePackage: {},
      });
      await activateSopRun(db, `C-SEED-ACT-${runId}`, { runId, workItemId });
    }

    stubDir = mkdtempSync(join(tmpdir(), "dopaios-kc11-stub-"));
    stubCli = join(stubDir, "claude-stub.sh");
    // STUB_DIR nhúng cứng vào script vì engine chạy child với env allowlist.
    writeFileSync(stubCli, STUB_SCRIPT.replaceAll("${STUB_DIR}", stubDir), "utf8");
    chmodSync(stubCli, 0o755);
    tokenFile = join(stubDir, "stub-token");
    writeFileSync(tokenFile, "stub-token-khong-phai-token-that\n", "utf8");
    chmodSync(tokenFile, 0o600);
    artifactDir = join(stubDir, "artifacts");
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("parses the 2.1.220 stream-json result shape and fails closed on malformed streams", () => {
    const parsed = parseClaudeStreamJson(
      [
        '{"type":"system","subtype":"init"}',
        '{"type":"assistant","message":{"model":"claude-sonnet-5"}}',
        '{"type":"result","subtype":"success","is_error":false,"result":"xin chao","total_cost_usd":0.05,' +
          '"usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":5,"output_tokens":7},' +
          '"modelUsage":{"claude-sonnet-5":{}}}',
      ].join("\n"),
    );
    expect(parsed).toEqual({
      text: "xin chao",
      model: "claude-sonnet-5",
      inputTokens: 10,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 2,
      outputTokens: 7,
      costUsdReported: "0.05000000",
    });

    expect(() => parseClaudeStreamJson('{"type":"system"}')).toThrowError(/missing result/u);
    expect(() =>
      parseClaudeStreamJson('{"type":"result","subtype":"success","is_error":false,"result":"x"}'),
    ).toThrowError(/no usage/u);
    expect(() =>
      parseClaudeStreamJson(
        '{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{}}',
      ),
    ).toThrowError(/is_error/u);
  });

  it("records reported and computed cost per CLI step through the session ledger", async () => {
    const engine = new ClaudeCliEngine({
      cliPath: stubCli,
      tokenFile,
      artifactDir,
      promptFor: (_contract, step, index) => `Buoc ${index}: ${step}`,
      cliTimeoutMs: 20_000,
    });
    const outcome = await runWorkItemSession(db, {
      sessionId: "SES-CLI-1",
      agentId: "AGENT-CLI",
      adapter: engine,
      contract: {
        workItemId: "WI-KC11-CLI-A",
        contractRevision: 1,
        sopRef: {},
        steps: ["phan-tich", "tong-hop"],
      },
    });
    expect(outcome.kind).toBe("succeeded");

    const usageRows = (await db.execute(sql`
      SELECT seq, step, model, billing_type, input_tokens, cached_input_tokens,
             cache_creation_input_tokens, output_tokens, cost_usd_reported,
             cost_usd_computed
      FROM dopaios_session_usage WHERE session_id = 'SES-CLI-1' ORDER BY seq
    `)) as unknown as Array<Record<string, unknown>>;
    expect(usageRows).toHaveLength(2);
    for (const row of usageRows) {
      expect(row).toMatchObject({
        model: "claude-sonnet-5",
        billing_type: "subscription_included",
        input_tokens: 1200,
        cached_input_tokens: 4500,
        cache_creation_input_tokens: 300,
        output_tokens: 800,
        cost_usd_reported: STEP_REPORTED,
        cost_usd_computed: STEP_COMPUTED,
      });
    }

    const session = (await db.execute(sql`
      SELECT usage_cost_usd_reported, usage_cost_usd_computed
      FROM dopaios_ai_sessions WHERE id = 'SES-CLI-1'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(Number(session[0]["usage_cost_usd_reported"])).toBeCloseTo(0.0246, 8);
    expect(Number(session[0]["usage_cost_usd_computed"])).toBeCloseTo(0.0241, 8);
  });

  it("hard-stops a CLI session at the contract cost limit with frozen overshoot", async () => {
    const engine = new ClaudeCliEngine({
      cliPath: stubCli,
      tokenFile,
      artifactDir,
      promptFor: (_contract, step, index) => `Buoc ${index}: ${step}`,
      cliTimeoutMs: 20_000,
    });
    const outcome = await runWorkItemSession(db, {
      sessionId: "SES-CLI-2",
      agentId: "AGENT-CLI",
      adapter: engine,
      contract: {
        workItemId: "WI-KC11-CLI-B",
        contractRevision: 1,
        sopRef: {},
        steps: ["b1", "b2", "b3"],
      },
      budget: { costUsdLimit: 0.02 },
    });
    // Bước 1: 0.0123 < 0.02; bước 2: 0.0246 ≥ 0.02 → dừng, bước 3 không chạy.
    expect(outcome).toMatchObject({
      kind: "budget-stopped",
      afterStep: "b2",
      limitUsd: "0.02000000",
      observedUsd: "0.02460000",
      overshootUsd: "0.00460000",
    });
    const usageCount = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_session_usage WHERE session_id = 'SES-CLI-2'
    `)) as unknown as Array<{ n: number }>;
    expect(usageCount[0].n).toBe(2);
  });
});
