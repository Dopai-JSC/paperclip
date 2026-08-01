import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateChangedPaths, runCheck } from "./check-test-protection.mjs";

// KC-04 B5 — luật thuần: tất định, không chạm git.

test("nhánh ngoài namespace sản xuất: luật không áp dụng, kể cả khi chạm test", () => {
  const result = evaluateChangedPaths("review/fix-flaky-test", [
    "server/src/__tests__/dopaios-kc04-gate.test.ts",
  ]);
  assert.deepEqual(result, { applies: false, violations: [] });
});

test("nhánh sản xuất chỉ chạm code thường: cho qua", () => {
  const result = evaluateChangedPaths("ai-prod/feature-x", [
    "server/src/dopaios/commands.ts",
    "packages/db/src/schema/dopaios_kc01.ts",
  ]);
  assert.deepEqual(result, { applies: true, violations: [] });
});

test("nhánh sản xuất sửa/xóa test server: chặn", () => {
  const result = evaluateChangedPaths("ai-prod/feature-x", [
    "server/src/dopaios/commands.ts",
    "server/src/__tests__/dopaios-kc04-gate.test.ts",
  ]);
  assert.deepEqual(result.violations, ["server/src/__tests__/dopaios-kc04-gate.test.ts"]);
});

test("nhánh sản xuất vô hiệu test qua cấu hình vitest: chặn", () => {
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["vitest.config.ts"]).violations,
    ["vitest.config.ts"],
  );
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["server/vitest.config.mts"]).violations,
    ["server/vitest.config.mts"],
  );
});

test("nhánh sản xuất chạm CI hoặc chính script bảo vệ: chặn (tự bảo vệ)", () => {
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", [".github/workflows/dopai-test-protection.yml"]).violations,
    [".github/workflows/dopai-test-protection.yml"],
  );
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["scripts/check-test-protection.mjs"]).violations,
    ["scripts/check-test-protection.mjs"],
  );
});

test("B6: vector vô hiệu test không chạm __tests__ — package.json, runner script, vitest.workspace: chặn", () => {
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["package.json"]).violations,
    ["package.json"],
  );
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["server/package.json"]).violations,
    ["server/package.json"],
  );
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["scripts/run-vitest-stable.mjs"]).violations,
    ["scripts/run-vitest-stable.mjs"],
  );
  assert.deepEqual(
    evaluateChangedPaths("ai-prod/x", ["vitest.workspace.ts"]).violations,
    ["vitest.workspace.ts"],
  );
});

// Tích hợp với git thật: repo tạm, hai nhánh, chạy runCheck trên diff thật —
// chứng minh cả vế XÓA test hiện diện trong danh sách file đổi.

function gitIn(cwd, args) {
  execFileSync("git", args, { cwd, encoding: "utf8" });
}

test("tích hợp git: sửa src cho qua, xóa test bị chặn", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "kc04-test-protection-"));
  try {
    gitIn(repo, ["init", "--quiet", "--initial-branch=main"]);
    gitIn(repo, ["config", "user.name", "KC04 Fixture"]);
    gitIn(repo, ["config", "user.email", "kc04@fixture.local"]);
    mkdirSync(path.join(repo, "server/src/__tests__"), { recursive: true });
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "server/src/__tests__/sample.test.ts"), "// test\n");
    writeFileSync(path.join(repo, "src/app.ts"), "export const x = 1;\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "--quiet", "-m", "base"]);
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    // Nhánh sản xuất sửa src: qua.
    gitIn(repo, ["checkout", "--quiet", "-b", "ai-prod/ok"]);
    writeFileSync(path.join(repo, "src/app.ts"), "export const x = 2;\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "--quiet", "-m", "đổi src"]);
    const okHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(runCheck(base, okHead, "ai-prod/ok", repo), 0);

    // Nhánh sản xuất XÓA test: chặn.
    gitIn(repo, ["checkout", "--quiet", "-b", "ai-prod/delete-test", base]);
    gitIn(repo, ["rm", "--quiet", "server/src/__tests__/sample.test.ts"]);
    gitIn(repo, ["commit", "--quiet", "-m", "xóa test"]);
    const delHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(runCheck(base, delHead, "ai-prod/delete-test", repo), 1);

    // B6 (three-dot): base tiến xa sau điểm fork, chạm cả đường bảo vệ —
    // PR chỉ sửa src vẫn PHẢI qua (two-dot sẽ đỏ oan vì tính file đổi của
    // base cho PR).
    gitIn(repo, ["checkout", "--quiet", "main"]);
    mkdirSync(path.join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(repo, ".github/workflows/ci.yml"), "name: ci\n");
    writeFileSync(path.join(repo, "server/src/__tests__/sample.test.ts"), "// test v2\n");
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["commit", "--quiet", "-m", "base tiến xa: đổi CI + test"]);
    const advancedBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(runCheck(advancedBase, okHead, "ai-prod/ok", repo), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI: gọi thiếu tham số exit 2 (fail-closed, không đoán)", () => {
  const script = fileURLToPath(new URL("./check-test-protection.mjs", import.meta.url));
  let code = 0;
  try {
    execFileSync(process.execPath, [script], { encoding: "utf8" });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 2);
});
