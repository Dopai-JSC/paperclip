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

export type ClaudeCliEngineOptions = {
  cliPath: string;
  tokenFile: string;
  artifactDir: string;
  promptFor: (contract: ExecutionContract, step: string, index: number) => string;
  heartbeatMs?: number;
  cliTimeoutMs?: number;
};

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
      ...options,
    };
    mkdirSync(this.options.artifactDir, { recursive: true });
  }

  stepFile(workItemId: string, index: number): string {
    return join(this.options.artifactDir, `${workItemId}-step${index}.txt`);
  }

  private childEnv(): NodeJS.ProcessEnv {
    if (!this.configDir) {
      this.configDir = mkdtempSync(join(tmpdir(), "dopaios-b7-cfg-"));
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

  private runCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.cliPath, ["--print", prompt], {
        env: this.childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
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
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude --print exit ${code}: ${stderr.slice(-300)}`));
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

      let output: string;
      try {
        output = await this.runCli(this.options.promptFor(input.contract, step, index));
      } finally {
        inFlight = false;
      }
      await heartbeat;

      writeFileSync(this.stepFile(input.contract.workItemId, index), output, "utf8");
      await input.onCheckpoint({
        step,
        ref: `ckpt/${input.sessionId}/${index}`,
        sha256: sha256(output),
      });
      console.log(`STEP-DONE ${index} step=${step} bytes=${output.length}`);
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
