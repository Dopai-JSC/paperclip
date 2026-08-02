import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, relative } from "node:path";
import { canonicalJsonString, payloadSha256 } from "./event-store.js";
import {
  releaseScopePrefix,
  resolveScopedPath,
  type WorkspaceCredentialRef,
  type WorkspacePurgeReport,
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

// Ghi trong scope: mọi đường tương đối đi qua resolveScopedPath — thoát scope
// là ERR-WS-PATH-ESCAPE ngay tại tầng fs, không phụ thuộc caller tự giác.
export async function writeScoped(baseAbs: string, relPath: string, content: string): Promise<string> {
  const target = resolveScopedPath(baseAbs, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return sha256Hex(content);
}

export async function readScoped(baseAbs: string, relPath: string): Promise<string> {
  const target = resolveScopedPath(baseAbs, relPath);
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

// Cây hash của một thư mục (đệ quy, bỏ .git): bằng chứng cô lập và purge —
// so sánh trước/sau theo từng byte nội dung.
export async function hashTree(dirAbs: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out[relative(dirAbs, abs)] = sha256Hex(await readFile(abs));
      }
    }
  }
  if (existsSync(dirAbs)) {
    await walk(dirAbs);
  }
  return out;
}

export async function listTree(dirAbs: string): Promise<string[]> {
  return Object.keys(await hashTree(dirAbs)).sort();
}

export type PurgeFsAdapter = {
  removeDir: (dirAbs: string) => Promise<void>;
};

export const realPurgeFs: PurgeFsAdapter = {
  removeDir: (dirAbs) => rm(dirAbs, { recursive: true, force: true }),
};

// Thực thi purge trên đĩa cho MỘT Release (B5): tính checksum + inventory
// trước khi xóa, xóa đúng thư mục scope, prune sổ worktree của repo nền,
// post-check residue. KHÔNG tự ghi sổ — caller đưa report vào lệnh
// recordWorkspacePurge để guard phạm vi/residue quyết định purged hay failed.
export async function purgeReleaseScopeOnDisk(input: {
  rootAbs: string;
  repoPath: string;
  releaseId: string;
  actor: string;
  fs?: PurgeFsAdapter;
}): Promise<{ report: WorkspacePurgeReport; error?: string }> {
  const fs = input.fs ?? realPurgeFs;
  const prefix = releaseScopePrefix(input.releaseId);
  const scopeAbs = resolveScopedPath(input.rootAbs, prefix.slice(0, -1));
  const before = await hashTree(scopeAbs);
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
  // Sổ worktree của repo nền không được giữ entry trỏ vào scope đã xóa.
  await run("git", ["-C", input.repoPath, "worktree", "prune"]);
  const worktrees = await git(input.repoPath, "worktree", "list", "--porcelain");
  const residue = (await listTree(scopeAbs)).map((rel) => `${prefix}${rel}`);
  if (worktrees.includes(scopeAbs)) {
    residue.push(`${prefix}#worktree-entry`);
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
export function workspaceBoundEngine(
  inner: import("./engine.js").EngineAdapter,
  ws: { wsAbs: string; cacheAbs: string },
): import("./engine.js").EngineAdapter {
  return {
    name: `${inner.name}+workspace`,
    async execute(input) {
      return inner.execute({
        ...input,
        onCheckpoint: async (payload) => {
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
