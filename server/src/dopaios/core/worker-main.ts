import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import type { Db } from "./event-store.js";
import { CommandPayloadMismatchError } from "./errors.js";
import { claimActivation, completeActivation } from "./activation.js";
import {
  FakeEngine,
  latestConfirmedCheckpoint,
  runWorkItemSession,
  type EngineAdapter,
  type EngineSessionParams,
  type ExecutionContract,
  type SessionBudget,
  type SessionRunOutcome,
} from "./engine.js";
import { ClaudeCliEngine, type ClaudeCliEngineOptions } from "./claude-cli-engine.js";
import { requireActiveWorkspace, recordWorkspacePurge, resolveScopedPath } from "./workspace.js";
import { purgeReleaseScopeOnDisk, workspaceBoundEngine } from "./workspace-fs.js";

// I-10 — entry tiến trình worker PRODUCTION trên máy trạm, thay vai trò
// kc05-worker.ts của drills. Hợp đồng theo hồ sơ kiến trúc phần 5 + ADR-023/
// 029 (a)/030 (iv):
//   - máy trạm chỉ nói chuyện với PostgreSQL — không RPC với server; kill
//     worker không mất việc (claim lease + epoch, watchdog thu hồi);
//   - cấu hình nhân viên AI và nội dung chạy (engine, Hợp đồng thực hiện AI,
//     Context Package) KÉO từ event store tại thời điểm claim — server không
//     đẩy; đổi cấu hình trên Dopaios có hiệu lực từ lượt claim kế tiếp;
//   - command gửi cho máy được QUAN SÁT và THI HÀNH kèm bằng chứng: purge
//     workspace khi Release đóng (evidence qua recordWorkspacePurge), dừng
//     khẩn cấp/thu hồi lease được kiểm tại ranh mỗi bước (fence epoch —
//     checkpoint của phiên bị thu hồi không được ghi tiếp);
//   - worker KHÔNG giữ trạng thái ngoài event store: workerTick là hàm thuần
//     nhận nowMs (cùng idiom runnerTick/detectStalledSessions — ADR-030),
//     mọi command id tất định theo đối tượng + epoch nên tick lặp không tạo
//     tác dụng kép.
// Ranh giới phân vai giữ nguyên FS-005: định tuyến/requeue là việc của
// runnerTick phía server; worker chỉ claim việc ĐÃ định tuyến cho đúng Staff
// của mình, chạy phiên và nộp qua tầng lệnh.

type Json = Record<string, unknown>;

export type WorkerEngineRegistry = Record<string, () => EngineAdapter>;

export type WorkerMainConfig = {
  // Danh tính Staff AI của máy trạm (1:1 theo ADR-029 (a)).
  agentId: string;
  engines: WorkerEngineRegistry;
  leaseMs: number;
  // Gốc workspace vật lý trên máy trạm; null = máy không giữ workspace nào.
  rootAbs?: string | null;
  // Repo nền cho purge worktree (cùng tham số purgeReleaseScopeOnDisk).
  repoPath?: string | null;
  // Steps dự phòng cho activation không pin hợp đồng (đường run test KC-01/
  // KC-02); activation gắn Project luôn lấy steps từ fields hợp đồng đã pin.
  fallbackSteps?: string[];
  // Liên kết work-item → Release để bind workspace (fence ba tầng KC-05).
  // Schema hiện hành CHƯA có cột liên kết này trên dopaios_work_items (thuộc
  // FS sau) nên đường bind là tùy chọn tiêm vào; không có resolver = phiên
  // chạy không bind workspace (đường run test).
  releaseIdForWorkItem?: (db: Db, workItemId: string) => Promise<string | null>;
};

export type WorkerTickReport = {
  machineCommands: Array<
    | { kind: "workspace-purge"; workspaceId: string; releaseId: string; outcome: "purged" | "failed" }
    | { kind: "fence-stop"; sessionId: string; reason: string }
  >;
  claimed: {
    activationId: string;
    sessionId: string;
    outcome: SessionRunOutcome["kind"] | "session-busy" | "already-claimed" | "skipped";
    reason?: string;
  } | null;
};

export class WorkerFencedError extends Error {
  constructor(readonly reason: string) {
    super(`worker fenced: ${reason}`);
    this.name = "WorkerFencedError";
  }
}

async function rows<T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

// Dừng khẩn cấp + fence lease tại ranh mỗi bước: phiên bị interrupt ngoài
// (watchdog/dừng khẩn cấp) hoặc activation bị requeue sang epoch mới /
// claimer khác thì worker DỪNG trước khi ghi thêm bất kỳ event nào. Ném lỗi
// từ onCheckpoint làm adapter dừng giữa chừng; phiên ở nguyên trạng thái
// trong event store — thu hồi là việc của watchdog, đúng ngữ nghĩa KC-05.
function fencedAdapter(
  db: Db,
  base: EngineAdapter,
  fence: { sessionId: string; activationId: string; agentId: string; epoch: number },
): EngineAdapter {
  const checkFence = async (): Promise<void> => {
    const session = await rows<{ state: string }>(
      db,
      sql`SELECT state FROM dopaios_ai_sessions WHERE id = ${fence.sessionId}`,
    );
    if (session[0] && session[0].state !== "RUNNING") {
      throw new WorkerFencedError(`session ${fence.sessionId} is ${session[0].state} (external stop)`);
    }
    const activation = await rows<{ lease_epoch: number; claimed_by: string | null }>(
      db,
      sql`SELECT lease_epoch, claimed_by FROM dopaios_activations WHERE id = ${fence.activationId}`,
    );
    if (
      activation[0] &&
      (Number(activation[0].lease_epoch) !== fence.epoch || activation[0].claimed_by !== fence.agentId)
    ) {
      throw new WorkerFencedError(
        `activation ${fence.activationId} lease moved (epoch ${activation[0].lease_epoch}, claimed_by ${activation[0].claimed_by})`,
      );
    }
  };
  return {
    name: base.name,
    async execute(input) {
      return base.execute({
        ...input,
        // Fence cả hai điểm chạm đầu bước (signal) và cuối bước (checkpoint)
        // — engine phát signal trước checkpoint nên dừng khẩn cấp có hiệu
        // lực ngay đầu bước kế tiếp, trước khi ghi thêm bất kỳ event nào.
        onSignal: async (payload) => {
          await checkFence();
          await input.onSignal(payload);
        },
        onCheckpoint: async (payload) => {
          await checkFence();
          await input.onCheckpoint(payload);
        },
      });
    },
  };
}

// Quan sát command cho máy: workspace của Release đã bắt đầu đóng
// (CLOSING/PURGE_BLOCKED) mà scope còn nằm trên đĩa máy này thì thi hành
// purge kèm bằng chứng (ADR-012/022 — unmount/purge có bằng chứng). Máy khác
// giữ scope thì bỏ qua — không claim việc không thuộc máy mình.
async function executeWorkspacePurges(
  db: Db,
  cfg: WorkerMainConfig,
  report: WorkerTickReport,
): Promise<void> {
  if (!cfg.rootAbs || !cfg.repoPath) return;
  const closing = await rows<{ id: string; release_id: string; rel_path: string; state: string }>(
    db,
    sql`SELECT id, release_id, rel_path, state FROM dopaios_workspaces
        WHERE state IN ('CLOSING', 'PURGE_BLOCKED') ORDER BY id`,
  );
  for (const workspace of closing) {
    const scopeAbs = join(cfg.rootAbs, "releases", workspace.release_id);
    if (!existsSync(scopeAbs)) continue;
    const { report: purgeReport, error } = await purgeReleaseScopeOnDisk({
      db,
      rootAbs: cfg.rootAbs,
      repoPath: cfg.repoPath,
      releaseId: workspace.release_id,
      actor: cfg.agentId,
    });
    if (error) {
      await recordWorkspacePurge(db, `WKR-PURGE-FAIL-${workspace.id}`, {
        workspaceId: workspace.id,
        actorId: cfg.agentId,
        outcome: "failed",
        failure: {
          reason: error,
          leftoverScope: purgeReport.residue,
          correctiveAction: {
            owner: cfg.agentId,
            dueMs: 24 * 60 * 60 * 1000,
            scope: purgeReport.residue,
            state: "open",
          },
        },
      });
      report.machineCommands.push({
        kind: "workspace-purge",
        workspaceId: workspace.id,
        releaseId: workspace.release_id,
        outcome: "failed",
      });
      continue;
    }
    await recordWorkspacePurge(db, `WKR-PURGE-${workspace.id}`, {
      workspaceId: workspace.id,
      actorId: cfg.agentId,
      outcome: "purged",
      report: purgeReport,
    });
    report.machineCommands.push({
      kind: "workspace-purge",
      workspaceId: workspace.id,
      releaseId: workspace.release_id,
      outcome: "purged",
    });
  }
}

// Một lượt quan sát + làm việc của máy trạm. Thứ tự cố ý: thi hành command
// cho máy TRƯỚC (purge/dừng) rồi mới nhận việc mới.
export async function workerTick(
  db: Db,
  cfg: WorkerMainConfig,
  input: { nowMs: number },
): Promise<WorkerTickReport> {
  const report: WorkerTickReport = { machineCommands: [], claimed: null };

  await executeWorkspacePurges(db, cfg, report);

  // Việc ĐÃ định tuyến cho đúng Staff của máy này, còn QUEUED.
  const queued = await rows<{
    id: string;
    work_item_id: string;
    engine: string;
    lease_epoch: number;
    contract_id: string | null;
    contract_revision: number | null;
  }>(
    db,
    sql`SELECT id, work_item_id, engine, lease_epoch, contract_id, contract_revision
        FROM dopaios_activations
        WHERE state = 'QUEUED' AND agent_id = ${cfg.agentId}
        ORDER BY id LIMIT 1`,
  );
  if (queued.length === 0) return report;
  const activation = queued[0];
  const epoch = Number(activation.lease_epoch);
  const sessionId = `SES-${activation.id}-e${epoch}`;

  // KÉO cấu hình tại thời điểm claim: engine theo activation (đã pin từ
  // route), nội dung theo hợp đồng đã pin. Engine không đăng ký = fail-closed
  // không claim (không gọi engine thật ngoài danh mục).
  const engineFactory = cfg.engines[activation.engine];
  if (!engineFactory) {
    report.claimed = {
      activationId: activation.id,
      sessionId,
      outcome: "skipped",
      reason: `engine ${activation.engine} không có trong registry của máy`,
    };
    return report;
  }

  try {
    await claimActivation(db, `WKR-CLAIM-${activation.id}-e${epoch}`, {
      activationId: activation.id,
      claimedBy: cfg.agentId,
      lease: { untilMs: input.nowMs + cfg.leaseMs },
    });
  } catch (error) {
    // Lần chạy trước cùng epoch đã claim rồi chết (untilMs khác → mismatch):
    // thoát êm chờ lease hết hạn và requeue cấp epoch mới (mẫu KC-05 B7).
    if (error instanceof CommandPayloadMismatchError) {
      report.claimed = { activationId: activation.id, sessionId, outcome: "already-claimed" };
      return report;
    }
    throw error;
  }

  // Hợp đồng thực hiện AI đã pin trên activation là thứ được thực thi
  // (steps + trần chi phí nằm trong fields đã hash — cùng luật runnerTick).
  let steps = cfg.fallbackSteps;
  let budget: SessionBudget | undefined;
  if (activation.contract_id) {
    const pinned = await rows<{ fields: Json }>(
      db,
      sql`SELECT fields FROM dopaios_execution_contracts
          WHERE id = ${activation.contract_id} AND revision = ${Number(activation.contract_revision ?? 1)}`,
    );
    const fields = pinned[0]?.fields;
    steps = (fields?.["steps"] as string[] | undefined) ?? steps;
    const costUsdLimit = (fields?.["limits"] as Json | undefined)?.["costUsd"];
    if (typeof costUsdLimit === "number") {
      // Trần áp theo WORK-ITEM: cộng chi phí các phiên trước trong chuỗi
      // (KC-11) — nguồn duy nhất là projection dựng lại được từ event.
      const prior = await rows<{ total: string | null }>(
        db,
        sql`SELECT sum(coalesce(u.cost_usd_reported, u.cost_usd_computed))::text AS total
            FROM dopaios_session_usage u
            JOIN dopaios_ai_sessions s ON s.id = u.session_id
            WHERE s.work_item_id = ${activation.work_item_id}`,
      );
      budget = {
        costUsdLimit,
        priorChainCostUsd: prior[0]?.total ? Number(prior[0].total) : 0,
      };
    }
  }
  if (!steps || steps.length === 0) {
    report.claimed = {
      activationId: activation.id,
      sessionId,
      outcome: "skipped",
      reason: "không có steps: activation không pin hợp đồng và máy không cấu hình fallbackSteps",
    };
    return report;
  }

  // Phục hồi production-shaped (mẫu KC-05 B7): phiên gần nhất của work-item
  // quyết định mở mới hay kế nhiệm + điểm resume; RUNNING thì không chen.
  const previous = await rows<{ id: string; state: string; outcome: string | null }>(
    db,
    sql`SELECT id, state, outcome FROM dopaios_ai_sessions
        WHERE work_item_id = ${activation.work_item_id}
        ORDER BY id DESC LIMIT 1`,
  );
  let predecessor: { id: string; relation: "retry" } | undefined;
  let resume: EngineSessionParams | undefined;
  if (previous.length > 0) {
    if (previous[0].state === "RUNNING") {
      report.claimed = { activationId: activation.id, sessionId, outcome: "session-busy" };
      return report;
    }
    if (previous[0].state === "INTERRUPTED" || previous[0].outcome === "failed") {
      predecessor = { id: previous[0].id, relation: "retry" };
      const checkpoint = await latestConfirmedCheckpoint(db, previous[0].id);
      if (checkpoint) resume = { nextStepIndex: checkpoint.nextStepIndex };
    }
  }

  const contract: ExecutionContract = {
    workItemId: activation.work_item_id,
    contractRevision: Number(activation.contract_revision ?? 1),
    sopRef: activation.contract_id
      ? { id: activation.contract_id, revision: Number(activation.contract_revision ?? 1) }
      : { id: "run-test", revision: 1 },
    steps,
  };

  // Workspace theo Release nếu có (fence ba tầng KC-05); không có thì engine
  // chạy trần (đường run test).
  let adapter = engineFactory();
  if (cfg.rootAbs && cfg.releaseIdForWorkItem) {
    const releaseId = await cfg.releaseIdForWorkItem(db, activation.work_item_id);
    if (releaseId) {
      const workspace = await requireActiveWorkspace(db, releaseId).catch(() => null);
      if (workspace) {
        adapter = workspaceBoundEngine(
          adapter,
          {
            wsAbs: resolveScopedPath(cfg.rootAbs, workspace.relPath),
            cacheAbs: resolveScopedPath(cfg.rootAbs, workspace.cacheRelPath),
          },
          { db, workspaceId: workspace.id },
        );
      }
    }
  }
  adapter = fencedAdapter(db, adapter, {
    sessionId,
    activationId: activation.id,
    agentId: cfg.agentId,
    epoch,
  });

  try {
    const outcome = await runWorkItemSession(db, {
      sessionId,
      agentId: cfg.agentId,
      adapter,
      contract,
      predecessor,
      resume,
      budget,
    });
    if (outcome.kind === "succeeded") {
      await completeActivation(db, `WKR-DONE-${activation.id}-e${epoch}`, {
        activationId: activation.id,
        outcome: "succeeded",
        leaseEpoch: epoch,
      });
    }
    report.claimed = { activationId: activation.id, sessionId, outcome: outcome.kind };
    return report;
  } catch (error) {
    if (error instanceof WorkerFencedError) {
      // Dừng khẩn cấp/thu hồi đã thi hành: không ghi gì thêm, không complete;
      // trạng thái phiên thuộc về bên đã ra lệnh (event store là nguồn).
      report.machineCommands.push({ kind: "fence-stop", sessionId, reason: error.reason });
      report.claimed = { activationId: activation.id, sessionId, outcome: "skipped", reason: error.reason };
      return report;
    }
    throw error;
  }
}

// Vòng chạy thật trên máy trạm: poll theo chu kỳ, dừng êm khi SIGTERM/SIGINT.
// Không giữ trạng thái giữa các tick ngoài event store.
export async function runWorkerMain(
  db: Db,
  cfg: WorkerMainConfig,
  opts: { pollMs: number; signal?: AbortSignal; onReport?: (r: WorkerTickReport) => void },
): Promise<void> {
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  while (!opts.signal?.aborted) {
    const report = await workerTick(db, cfg, { nowMs: Date.now() });
    opts.onReport?.(report);
    if (opts.signal?.aborted) break;
    await sleep(opts.pollMs);
  }
}

// Registry engine production của v1: hai đường sau EngineAdapter (ADR-018/
// 030 (ii)) + FakeEngine cho môi trường diễn tập. ClaudeCliEngine chỉ đăng
// ký khi máy trạm có cấu hình CLI (đường OAuth thủ công theo ADR-029 (b));
// thiếu cấu hình thì activation đòi engine đó bị skip fail-closed, không gọi
// engine thật. Codex qua CLI dùng chung khuôn adapter là việc của I-8
// (reviewer khác họ) — chưa đăng ký ở đây.
export function defaultEngineRegistry(claude?: ClaudeCliEngineOptions): WorkerEngineRegistry {
  const registry: WorkerEngineRegistry = {
    fake: () => new FakeEngine(),
  };
  if (claude) {
    registry["claude-cli"] = () => new ClaudeCliEngine(claude);
  }
  return registry;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
  return value;
}

async function main(): Promise<void> {
  const db = createDb(env("DOPAIOS_WORKER_DATABASE_URL"));
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  // Đường claude-cli chỉ mở khi máy trạm khai đủ cấu hình CLI (fail-closed).
  const claudeCliPath = process.env["DOPAIOS_WORKER_CLAUDE_CLI_PATH"];
  const claudeTokenFile = process.env["DOPAIOS_WORKER_CLAUDE_TOKEN_FILE"];
  const claudeArtifactDir = process.env["DOPAIOS_WORKER_CLAUDE_ARTIFACT_DIR"];
  const claudeOptions =
    claudeCliPath && claudeTokenFile && claudeArtifactDir
      ? {
          cliPath: claudeCliPath,
          tokenFile: claudeTokenFile,
          artifactDir: claudeArtifactDir,
          promptFor: (contract: ExecutionContract, step: string, index: number) =>
            JSON.stringify({ workItemId: contract.workItemId, step, index, steps: contract.steps }),
        }
      : undefined;
  await runWorkerMain(
    db,
    {
      agentId: env("DOPAIOS_WORKER_AGENT_ID"),
      engines: defaultEngineRegistry(claudeOptions),
      leaseMs: Number(process.env["DOPAIOS_WORKER_LEASE_MS"] ?? "300000"),
      rootAbs: process.env["DOPAIOS_WORKER_ROOT_ABS"] ?? null,
      repoPath: process.env["DOPAIOS_WORKER_REPO_PATH"] ?? null,
    },
    {
      pollMs: Number(process.env["DOPAIOS_WORKER_POLL_MS"] ?? "5000"),
      signal: controller.signal,
      onReport: (report) => {
        if (report.claimed || report.machineCommands.length > 0) {
          console.log(JSON.stringify({ workerReport: report }));
        }
      },
    },
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error("DOPAIOS-WORKER-ERROR", error);
    process.exit(1);
  });
}
