import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, readlink, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, relative, sep } from "node:path";
import { sql } from "drizzle-orm";
import {
  canonicalJsonString,
  payloadSha256,
  writeEvent,
  type Db,
  CommandRejectedError,
} from "./event-store.js";
import {
  releaseScopePrefix,
  resolveScopedPath,
  type WorkspaceCredentialRef,
  type WorkspacePurgeReport,
  type WorkspaceRetentionControl,
} from "./workspace.js";

// KC-05 B3: tầng đĩa của workspace — vật chất hóa những gì lệnh provision đã
// cấp phát (QD-3 kế hoạch KC-05): git worktree THẬT cắt từ repo nền, thư mục
// cache riêng, credential fixture theo Release, bind port THẬT để chứng minh
// độc quyền ở mức OS. Mọi đường ghi/đọc đi qua resolveScopedPath (guard
// ASM-001, B2). Purge (B5) xóa ĐÚNG prefix Release, prune sổ worktree của
// repo nền, rồi post-check inventory — báo cáo theo khuôn ADR-012.

const run = promisify(execFile);

export type MaterializedWorkspace = {
  workspaceId: string;
  releaseId: string;
  wsAbs: string;
  cacheAbs: string;
  credentialAbs: string;
  worktreeHead: string;
  port: number;
  server: Server;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

// Repo nền fixture: một repo git thật với nội dung tất định — nguồn để cắt
// worktree cho từng Release (vai "codebase của Release" trong spike).
export async function initFixtureRepo(rootAbs: string): Promise<{ repoPath: string; headSha: string }> {
  const repoPath = join(rootAbs, "base-repo");
  await mkdir(repoPath, { recursive: true });
  await run("git", ["init", "-q", "-b", "main", repoPath]);
  await git(repoPath, "config", "user.name", "kc05-fixture");
  await git(repoPath, "config", "user.email", "kc05@dopai.test");
  await writeFile(join(repoPath, "README.md"), "# KC-05 fixture repo\n", "utf8");
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(join(repoPath, "src", "app.txt"), "shared base content v1\n", "utf8");
  await git(repoPath, "add", "-A");
  await git(repoPath, "commit", "-q", "-m", "kc05: base fixture");
  const headSha = await git(repoPath, "rev-parse", "HEAD");
  return { repoPath, headSha };
}

export function bindPort(port: number): Promise<Server> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rejectPromise);
      resolvePromise(server);
    });
  });
}

// Vật chất hóa một workspace đã PROVISIONED: worktree thật trên branch riêng
// ws/<releaseId>, cache dir, credential fixture (nội dung canonical có sha256
// khớp đúng credentialRef trong sổ), bind port thật. Trả bằng chứng cho lệnh
// activate (fail-closed nếu thiếu).
export async function materializeWorkspace(input: {
  rootAbs: string;
  repoPath: string;
  workspaceId: string;
  releaseId: string;
  relPath: string;
  cacheRelPath: string;
  port: number;
  credentialRef: WorkspaceCredentialRef;
  baseRef: string;
}): Promise<MaterializedWorkspace> {
  const wsAbs = resolveScopedPath(input.rootAbs, input.relPath);
  const cacheAbs = resolveScopedPath(input.rootAbs, input.cacheRelPath);
  await mkdir(dirname(wsAbs), { recursive: true });
  // B7 (major review lens 2 — ngõ cụt hai pha DB–đĩa): materialize idempotent.
  // Lần vật chất hóa trước chết giữa chừng để lại thư mục worktree dở, entry
  // sổ worktree hoặc branch ws/<releaseId> mồ côi — dọn trước khi add để
  // retry (sau abortWorkspace + provision mới) không nổ vì rác của lần trước.
  await rm(wsAbs, { recursive: true, force: true });
  await run("git", ["-C", input.repoPath, "worktree", "prune"]);
  try {
    await run("git", ["-C", input.repoPath, "branch", "-q", "-D", `ws/${input.releaseId}`]);
  } catch {
    // Branch chưa tồn tại — lần vật chất hóa đầu.
  }
  await run("git", [
    "-C",
    input.repoPath,
    "worktree",
    "add",
    "-q",
    "-b",
    `ws/${input.releaseId}`,
    wsAbs,
    input.baseRef,
  ]);
  const worktreeHead = await git(wsAbs, "rev-parse", "HEAD");
  await mkdir(cacheAbs, { recursive: true });
  // Credential fixture: nội dung canonical đúng công thức của provision —
  // sha256(file) PHẢI khớp credentialRef.sha256 trong sổ (kiểm khi đọc).
  const credentialAbs = resolveScopedPath(
    input.rootAbs,
    `${releaseScopePrefix(input.releaseId)}credential.json`,
  );
  const credentialBody = canonicalJsonString({
    fixtureCredential: input.releaseId,
    workspaceId: input.workspaceId,
  });
  await writeFile(credentialAbs, credentialBody, "utf8");
  const server = await bindPort(input.port);
  return {
    workspaceId: input.workspaceId,
    releaseId: input.releaseId,
    wsAbs,
    cacheAbs,
    credentialAbs,
    worktreeHead,
    port: input.port,
    server,
  };
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

// B7 (major review cả hai lens — symlink): resolveScopedPath chỉ chuẩn hóa
// TỪ VỰNG; nội dung repo nền chứa symlink thì đường "trong scope" theo chữ
// vẫn ghi ra ngoài theo thật. Sau khi phân giải từ vựng, đối chiếu realpath
// của thư mục cha với realpath của gốc — cha nằm ngoài gốc thật là chặn.
async function requireRealParentInScope(baseAbs: string, target: string): Promise<void> {
  const baseReal = await realpath(baseAbs);
  const parentReal = await realpath(dirname(target));
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + sep)) {
    throw new CommandRejectedError(
      "ERR-WS-PATH-ESCAPE",
      `Đường dẫn ${target} có cha thật ${parentReal} nằm ngoài scope ${baseReal} (symlink) — chặn`,
    );
  }
}

// Ghi trong scope: mọi đường tương đối đi qua resolveScopedPath (từ vựng) +
// kiểm realpath cha (symlink) ngay tại tầng fs.
export async function writeScoped(baseAbs: string, relPath: string, content: string): Promise<string> {
  const target = resolveScopedPath(baseAbs, relPath);
  await mkdir(dirname(target), { recursive: true });
  await requireRealParentInScope(baseAbs, target);
  await writeFile(target, content, "utf8");
  return sha256Hex(content);
}

export async function readScoped(baseAbs: string, relPath: string): Promise<string> {
  const target = resolveScopedPath(baseAbs, relPath);
  await requireRealParentInScope(baseAbs, target);
  return readFile(target, "utf8");
}

// Đọc credential fixture qua đường fs kèm KIỂM sha256 với ref trong sổ —
// file bị tráo là bị phát hiện (bằng chứng nội dung, không chỉ vị trí).
export async function readCredentialFile(
  credentialAbs: string,
  expected: WorkspaceCredentialRef,
): Promise<Record<string, unknown>> {
  const body = await readFile(credentialAbs, "utf8");
  const actual = sha256Hex(body);
  if (actual !== expected.sha256) {
    throw new Error(`Credential fixture sha ${actual} khác sổ ${expected.sha256} — nội dung đã bị tráo`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

// Cây hash của một thư mục: bằng chứng cô lập và purge — so sánh trước/sau
// theo từng byte nội dung. B7 (major review cả hai lens): symlink được liệt
// kê theo TARGET của nó (không đi theo), nên inventory residue/checksum
// không mù symlink; includeGit=true để đường purge thấy cả metadata `.git`
// (file gitdir-pointer của worktree) — so sánh nội dung workspace thường thì
// bỏ `.git` như cũ. File biến mất giữa walk (đua với writer/purge khác) coi
// như đã mất, không nổ lỗi thô.
export async function hashTree(
  dirAbs: string,
  options?: { includeGit?: boolean },
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" && !options?.includeGit) continue;
      const abs = join(current, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          out[relative(dirAbs, abs)] = `symlink:${sha256Hex(await readlink(abs))}`;
        } else if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          out[relative(dirAbs, abs)] = sha256Hex(await readFile(abs));
        }
      } catch {
        // Biến mất giữa chừng — bỏ qua như "đã mất".
      }
    }
  }
  if (existsSync(dirAbs)) {
    await walk(dirAbs);
  }
  return out;
}

export async function listTree(dirAbs: string, options?: { includeGit?: boolean }): Promise<string[]> {
  return Object.keys(await hashTree(dirAbs, options)).sort();
}

export type PurgeFsAdapter = {
  removeDir: (dirAbs: string) => Promise<void>;
};

export const realPurgeFs: PurgeFsAdapter = {
  removeDir: (dirAbs) => rm(dirAbs, { recursive: true, force: true }),
};

// Thực thi purge trên đĩa cho MỘT Release (B5): tính checksum + inventory
// trước khi xóa (KỂ CẢ `.git` và symlink — B7), xóa đúng thư mục scope, xóa
// branch ws/<releaseId> của repo nền, prune sổ worktree, post-check residue
// gồm cả entry worktree/branch còn sót và port còn bận. KHÔNG tự ghi sổ —
// caller đưa report vào lệnh recordWorkspacePurge để guard quyết định.
// B7/KC-09 (hai lens review — fail-closed tại tầng đĩa): trước khi chạm byte,
// hàm đọc sổ và TỪ CHỐI nếu workspace chưa đóng, actor governed không hợp lệ,
// hold/retention còn hiệu lực hoặc vẫn có session/claim RUNNING. Mỗi lần từ
// chối ghi CommandRejected bất biến; recordWorkspacePurge vẫn lặp lại guard ở
// bước ghi sổ để không tin báo cáo do caller cung cấp.
export async function purgeReleaseScopeOnDisk(input: {
  db: Db;
  rootAbs: string;
  repoPath: string;
  releaseId: string;
  actor: string;
  port?: number;
  fs?: PurgeFsAdapter;
}): Promise<{ report: WorkspacePurgeReport; error?: string }> {
  const workspaceRows = await (async () => {
    const rows = (await input.db.execute(sql`
      SELECT id, state, port, retention_control FROM dopaios_workspaces
      WHERE release_id = ${input.releaseId} AND state <> 'PURGED'
    `)) as unknown as Array<{
      id: string;
      state: string;
      port: number;
      retention_control: WorkspaceRetentionControl | null;
    }>;
    if (rows.length === 0 || (rows[0].state !== "CLOSING" && rows[0].state !== "PURGE_BLOCKED")) {
      throw new CommandRejectedError(
        "ERR-WS-STATE",
        `Release ${input.releaseId} không có workspace ở CLOSING/PURGE_BLOCKED — không đụng đĩa (fail-closed)`,
      );
    }
    const retentionControl = rows[0].retention_control;
    if (retentionControl !== null) {
      const actors = (await input.db.execute(sql`
        SELECT active, capabilities FROM dopaios_actors WHERE id = ${input.actor}
      `)) as unknown as Array<{ active: boolean; capabilities: string[] }>;
      if (!actors[0]?.active || !actors[0].capabilities.includes("retention-admin")) {
        throw new CommandRejectedError(
          "ERR-WS-PURGE-AUTH",
          "A governed workspace purge requires one active retention administrator before physical deletion",
        );
      }
      if (retentionControl.legalHold?.active === true) {
        throw new CommandRejectedError(
          "ERR-WS-LEGAL-HOLD",
          `Workspace ${rows[0].id} is protected by legal hold ${retentionControl.legalHold.holdId}`,
        );
      }
      if (retentionControl.retentionUntil !== null) {
        const nowRows = (await input.db.execute(sql`SELECT CURRENT_TIMESTAMP AS now`)) as unknown as Array<{ now: Date }>;
        if (Date.parse(retentionControl.retentionUntil) > new Date(nowRows[0]!.now).getTime()) {
          throw new CommandRejectedError(
            "ERR-WS-RETENTION",
            `Workspace ${rows[0].id} is retained until ${retentionControl.retentionUntil}`,
          );
        }
      }
    }
    const openWriters = (await input.db.execute(sql`
      SELECT s.id AS session_id, NULL AS activation_id
      FROM dopaios_ai_sessions s
      JOIN dopaios_work_items w ON w.id = s.work_item_id
      WHERE w.run_id = ${input.releaseId} AND s.state = 'RUNNING'
      UNION ALL
      SELECT NULL AS session_id, a.id AS activation_id
      FROM dopaios_activations a
      JOIN dopaios_work_items w ON w.id = a.work_item_id
      WHERE w.run_id = ${input.releaseId} AND a.state = 'RUNNING'
    `)) as unknown as Array<{ session_id: string | null; activation_id: string | null }>;
    if (openWriters.length > 0) {
      const detail = openWriters.map((writer) => writer.session_id ?? writer.activation_id).join(", ");
      throw new CommandRejectedError(
        "ERR-WS-SESSIONS-OPEN",
        `Release ${input.releaseId} còn phiên/claim sống (${detail}) — không xóa dữ liệu vật lý`,
      );
    }
    return rows;
  })().catch(async (error: unknown) => {
    if (error instanceof CommandRejectedError) {
      const commandId = `KC09-PURGE-FS-${input.releaseId}-${input.actor}`;
      await input.db.transaction(async (tx) => {
        await writeEvent(tx, {
          streamName: `dopaiosAudit-${commandId}`,
          type: "CommandRejected",
          data: {
            commandId,
            code: error.code,
            reason: error.message,
            payloadSha256: payloadSha256({
              releaseId: input.releaseId,
              actor: input.actor,
              operation: "workspace-physical-purge",
            }),
          },
        });
      });
    }
    throw error;
  });
  const port = input.port ?? Number(workspaceRows[0].port);
  const fs = input.fs ?? realPurgeFs;
  const prefix = releaseScopePrefix(input.releaseId);
  const scopeAbs = resolveScopedPath(input.rootAbs, prefix.slice(0, -1));
  const before = await hashTree(scopeAbs, { includeGit: true });
  const checksums: Record<string, string> = {};
  for (const [rel, sha] of Object.entries(before)) {
    checksums[`${prefix}${rel}`] = sha;
  }
  let error: string | undefined;
  try {
    await fs.removeDir(scopeAbs);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  // Repo nền dùng chung không được giữ residue mang tên Release: entry
  // worktree và branch ws/<releaseId> (B7 — thiếu branch làm tái vật chất
  // hóa sau purge nổ "branch already exists").
  await run("git", ["-C", input.repoPath, "worktree", "prune"]);
  try {
    await run("git", ["-C", input.repoPath, "branch", "-q", "-D", `ws/${input.releaseId}`]);
  } catch {
    // Branch không tồn tại — đã sạch.
  }
  const worktrees = await git(input.repoPath, "worktree", "list", "--porcelain");
  const branches = await git(input.repoPath, "branch", "--list", `ws/${input.releaseId}`);
  const residue = (await listTree(scopeAbs, { includeGit: true })).map((rel) => `${prefix}${rel}`);
  if (worktrees.includes(scopeAbs)) {
    residue.push(`${prefix}#worktree-entry`);
  }
  if (branches.trim().length > 0) {
    residue.push(`${prefix}#branch-ws`);
  }
  // B7 (major review lens 2 — vòng đời port): bằng chứng "port đã nhả" bằng
  // probe bind thật; còn bận thì residue giữ purge ở nhánh failed thay vì
  // released một port mà OS còn phục vụ.
  if (Number.isFinite(port)) {
    try {
      const probe = await bindPort(port);
      await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
    } catch {
      residue.push(`${prefix}#port-still-bound`);
    }
  }
  return {
    report: {
      actor: input.actor,
      purgedScope: Object.keys(checksums),
      checksums,
      residue,
    },
    error,
  };
}

// Adapter engine gắn workspace: mỗi checkpoint của phiên được ghi thành
// artifact tạm TRONG scope workspace + một entry cache — dữ liệu tạm thật
// trên đĩa cho bằng chứng cô lập (B3) và purge (B5).
// B7 (blocker vòng review đối kháng): fence trạng thái TRƯỚC MỖI lần ghi —
// workspace rời ACTIVE (CLOSING/PURGE_BLOCKED/PURGED) thì checkpoint kế tiếp
// bị chặn ở tầng fs, writer sống sót không tái tạo được cây scope sau purge.
// Còn cửa sổ TOCTOU giữa lần đọc trạng thái và writeFile của TIẾN TRÌNH
// zombie — ghi giới hạn tại hồ sơ; tầng sổ đã kín nhờ guard
// ERR-WS-SESSIONS-OPEN của recordWorkspacePurge.
export function workspaceBoundEngine(
  inner: import("./engine.js").EngineAdapter,
  ws: { wsAbs: string; cacheAbs: string },
  fence?: { db: Db; workspaceId: string },
): import("./engine.js").EngineAdapter {
  return {
    name: `${inner.name}+workspace`,
    async execute(input) {
      return inner.execute({
        ...input,
        onCheckpoint: async (payload) => {
          if (fence) {
            const rows = (await fence.db.execute(sql`
              SELECT state FROM dopaios_workspaces WHERE id = ${fence.workspaceId}
            `)) as unknown as Array<{ state: string }>;
            if (rows[0]?.state !== "ACTIVE") {
              throw new CommandRejectedError(
                "ERR-WS-FENCED",
                `Workspace ${fence.workspaceId} ở ${rows[0]?.state ?? "unknown"} — checkpoint bị fence, không ghi đĩa`,
              );
            }
          }
          const body = canonicalJsonString({
            sessionId: input.sessionId,
            step: payload.step,
            ref: payload.ref,
            sha256: payload.sha256,
          });
          await writeScoped(ws.wsAbs, `artifacts/${input.sessionId}/${payload.step}.ckpt.json`, body);
          await writeScoped(ws.cacheAbs, `steps/${payload.step}.cache`, payloadSha256({ cacheOf: payload.ref }));
          await input.onCheckpoint(payload);
        },
      });
    },
  };
}
