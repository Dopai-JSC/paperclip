import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  type EngineAdapter,
  type EngineRunInput,
  type EngineRunResult,
  type ExecutionContract,
} from "./engine.js";
import { normalizeCostUsdString } from "./pricing.js";

// KC-02 B7: engine adapter THẬT chạy `claude --print` tại pin CLI đã chốt.
// Cùng hình adapter với FakeEngine nên cắm thẳng vào runWorkItemSession:
// mỗi bước hợp đồng = một lần gọi CLI, sau mỗi bước một checkpoint đã xác
// nhận (ref dạng ckpt/<session>/<index> để latestConfirmedCheckpoint suy ra
// điểm resume). Trong lúc CLI đang bay, adapter phát heartbeat qua onSignal
// để nuôi watchdog NFR-8 — mất process là mất luôn heartbeat, đúng kịch bản
// phát-hiện-qua-im-lặng.
// Vệ sinh credential: token đọc từ file chmod 600, chỉ vào env của child
// (không bao giờ nằm trên argv); ANTHROPIC_API_KEY bị gỡ khỏi env;
// CLAUDE_CONFIG_DIR là thư mục tạm sạch.
// KC-11: gọi CLI với --output-format stream-json để đọc total_cost_usd và
// usage (input/cache_read/cache_creation/output token) của TỪNG bước; usage
// đi vào kênh onUsage của engine — thiếu event result hoặc usage là lỗi bước
// (fail-closed), không được lặng lẽ ghi 0.

export type ClaudeCliEngineOptions = {
  cliPath: string;
  tokenFile: string;
  artifactDir: string;
  promptFor: (contract: ExecutionContract, step: string, index: number) => string;
  heartbeatMs?: number;
  cliTimeoutMs?: number;
  // KC-11: billingType ghi vào usage (mặc định subscription_included — đường
  // OAuth token thuê bao; đổi khi chạy fallback API key có trần).
  billingType?: string;
  // KC-11: pin CLAUDE_CONFIG_DIR theo phiên để ccusage đối soát được đúng
  // transcript của từng Phiên chạy AI; bỏ trống thì dùng thư mục tạm sạch.
  configDir?: string;
};

// Kết quả parse một lượt stream-json của `claude --print`.
export type ClaudeStepResult = {
  text: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsdReported: string | null;
};

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

// Parse JSONL stream: cần đúng một event type=result subtype=success có
// usage; model lấy từ modelUsage (một key) hoặc message assistant cuối.
export function parseClaudeStreamJson(stdout: string): ClaudeStepResult {
  let result: Record<string, unknown> | null = null;
  let lastAssistantModel: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "assistant") {
      const message = event["message"] as Record<string, unknown> | undefined;
      if (typeof message?.["model"] === "string") lastAssistantModel = message["model"];
    }
    if (event["type"] === "result") result = event;
  }
  if (!result) {
    throw new Error("claude stream-json: missing result event");
  }
  if (result["is_error"] === true) {
    throw new Error(`claude stream-json: result is_error (${String(result["subtype"])})`);
  }
  const usage = result["usage"] as Record<string, unknown> | undefined;
  if (!usage) {
    throw new Error("claude stream-json: result has no usage block");
  }
  const modelUsage = result["modelUsage"] as Record<string, unknown> | undefined;
  const modelUsageKeys = modelUsage ? Object.keys(modelUsage) : [];
  const model = modelUsageKeys.length === 1 ? modelUsageKeys[0] : lastAssistantModel;
  if (!model) {
    throw new Error("claude stream-json: cannot resolve model for pricing");
  }
  return {
    text: typeof result["result"] === "string" ? (result["result"] as string) : "",
    model,
    inputTokens: asCount(usage["input_tokens"]),
    cachedInputTokens: asCount(usage["cache_read_input_tokens"]),
    cacheCreationInputTokens: asCount(usage["cache_creation_input_tokens"]),
    outputTokens: asCount(usage["output_tokens"]),
    costUsdReported: normalizeCostUsdString(result["total_cost_usd"] as number | undefined),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ClaudeCliEngine implements EngineAdapter {
  readonly name = "claude-cli";
  private readonly options: Required<ClaudeCliEngineOptions>;
  private configDir: string | null = null;

  constructor(options: ClaudeCliEngineOptions) {
    this.options = {
      heartbeatMs: 5_000,
      cliTimeoutMs: 180_000,
      billingType: "subscription_included",
      configDir: "",
      ...options,
    };
    mkdirSync(this.options.artifactDir, { recursive: true });
  }

  stepFile(workItemId: string, index: number): string {
    return join(this.options.artifactDir, `${workItemId}-step${index}.txt`);
  }

  private childEnv(): NodeJS.ProcessEnv {
    if (!this.configDir) {
      if (this.options.configDir) {
        mkdirSync(this.options.configDir, { recursive: true });
        this.configDir = this.options.configDir;
      } else {
        this.configDir = mkdtempSync(join(tmpdir(), "dopaios-b7-cfg-"));
      }
    }
    // Whitelist tối thiểu thay vì kế thừa process.env: chặn mọi biến điều
    // hướng auth/backend (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,
    // CLAUDE_CODE_USE_BEDROCK/VERTEX…) có thể đưa token thật đi endpoint
    // ngoài ý muốn.
    const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TERM"];
    const env: NodeJS.ProcessEnv = {};
    for (const name of keep) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env["CLAUDE_CONFIG_DIR"] = this.configDir;
    env["CLAUDE_CODE_OAUTH_TOKEN"] = readFileSync(this.options.tokenFile, "utf8").trim();
    return env;
  }

  private runCli(prompt: string): Promise<ClaudeStepResult> {
    return new Promise((resolve, reject) => {
      // stream-json với --print yêu cầu --verbose tại pin CLI 2.1.220.
      const child = spawn(
        this.options.cliPath,
        ["--print", "--output-format", "stream-json", "--verbose", prompt],
        {
          env: this.childEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`claude --print timed out after ${this.options.cliTimeoutMs}ms`));
      }, this.options.cliTimeoutMs);
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude --print exit ${code}: ${stderr.slice(-300)}`));
          return;
        }
        try {
          resolve(parseClaudeStreamJson(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async execute(input: EngineRunInput): Promise<EngineRunResult> {
    const startIndex =
      typeof input.resume?.["nextStepIndex"] === "number"
        ? (input.resume["nextStepIndex"] as number)
        : 0;
    for (let index = startIndex; index < input.contract.steps.length; index += 1) {
      const step = input.contract.steps[index];
      await input.onSignal({ step });

      // Heartbeat trong lúc CLI đang bay: dừng ngay khi bước xong; lỗi ghi
      // signal (phiên không còn RUNNING) chỉ dừng heartbeat, việc xử lý trạng
      // thái phiên là của tầng lệnh chứ không phải của adapter.
      let inFlight = true;
      const heartbeat = (async () => {
        let waited = 0;
        while (inFlight) {
          await sleep(500);
          waited += 500;
          if (!inFlight) break;
          if (waited >= this.options.heartbeatMs) {
            waited = 0;
            try {
              await input.onSignal({ step });
            } catch {
              return;
            }
          }
        }
      })();

      let stepResult: ClaudeStepResult;
      try {
        stepResult = await this.runCli(this.options.promptFor(input.contract, step, index));
      } finally {
        inFlight = false;
      }
      await heartbeat;

      const output = stepResult.text;
      writeFileSync(this.stepFile(input.contract.workItemId, index), output, "utf8");
      await input.onCheckpoint({
        step,
        ref: `ckpt/${input.sessionId}/${index}`,
        sha256: sha256(output),
      });
      if (input.onUsage) {
        await input.onUsage({
          step,
          model: stepResult.model,
          billingType: this.options.billingType,
          inputTokens: stepResult.inputTokens,
          cachedInputTokens: stepResult.cachedInputTokens,
          cacheCreationInputTokens: stepResult.cacheCreationInputTokens,
          outputTokens: stepResult.outputTokens,
          costUsdReported: stepResult.costUsdReported,
        });
      }
      console.log(
        `STEP-DONE ${index} step=${step} bytes=${output.length} ` +
          `tokens=${stepResult.inputTokens}/${stepResult.cachedInputTokens}/` +
          `${stepResult.cacheCreationInputTokens}/${stepResult.outputTokens} ` +
          `costUsd=${stepResult.costUsdReported ?? "n/a"}`,
      );
    }

    // Output cuối = ghép toàn bộ bước từ đĩa (kể cả bước do predecessor chạy
    // trước khi mất process — file artifact sống sót qua kill là một phần
    // bằng chứng resume).
    const parts = input.contract.steps.map((_, index) =>
      readFileSync(this.stepFile(input.contract.workItemId, index), "utf8"),
    );
    const finalText = parts.join("\n\n---\n\n");
    const finalFile = join(this.options.artifactDir, `${input.contract.workItemId}-final.txt`);
    writeFileSync(finalFile, finalText, "utf8");
    return {
      status: "succeeded",
      sessionParams: { nextStepIndex: input.contract.steps.length },
      output: { ref: `out/${input.contract.workItemId}`, sha256: sha256(finalText) },
    };
  }
}
