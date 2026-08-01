#!/usr/bin/env node
/**
 * check-test-protection.mjs — KC-04 B5 (Dopaios).
 *
 * FR-29 / tiêu chí 4 KC-04: "Thử sửa hoặc vô hiệu hóa test từ quyền của tác
 * nhân sản xuất phải bị branch protection hoặc CI chặn." Cơ chế chọn là CI
 * (QD-4 KC-04): tác nhân SẢN XUẤT của Dopaios chỉ được đẩy code qua namespace
 * nhánh `ai-prod/**` (ranh quyền ở tầng credential — giả định môi trường ghi
 * trong hồ sơ KC-04); check này chạy trên pull request và TỪ CHỐI mọi thay đổi
 * từ nhánh sản xuất chạm vào đường bảo vệ:
 *
 *   - test của server (`server/src/__tests__/**`) — sửa, xóa hay đổi tên đều
 *     là "sửa/vô hiệu hóa test";
 *   - cấu hình vitest (`vitest.config.*`) — tắt test bằng cấu hình;
 *   - `.github/**` — vô hiệu hóa chính CI (gồm workflow của check này);
 *   - chính script này — tự bảo vệ.
 *
 * Nhánh ngoài namespace sản xuất không áp luật này: thay đổi test của người
 * hoặc AI-Test đi qua đường review thường (SFR-019 — reviewer độc lập).
 * Danh mục đường bảo vệ đầy đủ cho production thuộc kiến trúc CI (DS-2);
 * fixture KC-04 chứng minh CƠ CHẾ với danh mục tối thiểu.
 *
 * Cách gọi: node scripts/check-test-protection.mjs <base-sha> <head-sha> <head-branch>
 * Exit 0 = cho qua; exit 1 = chặn (in danh sách vi phạm); exit 2 = gọi sai.
 */

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PRODUCTION_BRANCH_PATTERN = /^ai-prod\//;

export const PROTECTED_PATH_PATTERNS = [
  /^server\/src\/__tests__\//,
  /(^|\/)vitest\.config\.[^/]+$/,
  /(^|\/)vitest\.workspace\.[^/]+$/,
  /^\.github\//,
  // B6 (major review lens 1): vector vô-hiệu-hóa-test không chạm __tests__ —
  // đổi lệnh test trong package.json hoặc gutting runner script. Chặn
  // package.json MỌI cấp (fail-closed là đúng hướng của tiêu chí 4; nhu cầu
  // thêm dependency của tác nhân sản xuất đi qua đường review có người) và
  // toàn bộ scripts/ chạy trong CI.
  /(^|\/)package\.json$/,
  /^scripts\//,
];

/**
 * Luật thuần (không chạm git) để test được tất định:
 * trả về { applies, violations } — applies=false khi nhánh ngoài namespace
 * sản xuất; violations là các đường bị chạm khi applies=true.
 */
export function evaluateChangedPaths(headBranch, changedPaths) {
  if (!PRODUCTION_BRANCH_PATTERN.test(headBranch)) {
    return { applies: false, violations: [] };
  }
  const violations = changedPaths.filter((changedPath) =>
    PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(changedPath)),
  );
  return { applies: true, violations };
}

/**
 * Danh sách file PR đổi: three-dot (từ merge-base tới head) — B6 (major
 * review lens 2): two-dot so sánh hai cây nên base tiến xa sau điểm fork làm
 * check đỏ oan (file đổi trên base bị tính cho PR) và có đường lọt khi head
 * đưa file về trùng nội dung với base mới. --no-renames để xóa/đổi tên hiện
 * đủ hai vế.
 */
export function listChangedPaths(baseSha, headSha, cwd) {
  let stdout;
  try {
    stdout = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", `${baseSha}...${headSha}`, "--"],
      { cwd, encoding: "utf8" },
    );
  } catch (error) {
    // Fail-closed với thông điệp chẩn đoán được (base bị force-push mất SHA,
    // checkout thiếu lịch sử...) thay vì stack trace thô.
    throw new Error(
      `Không diff được ${baseSha}...${headSha} (thiếu SHA trong checkout? base bị force-push?): ${error.message}`,
    );
  }
  return stdout.split("\n").filter((line) => line.length > 0);
}

export function runCheck(baseSha, headSha, headBranch, cwd = process.cwd()) {
  const changed = listChangedPaths(baseSha, headSha, cwd);
  const result = evaluateChangedPaths(headBranch, changed);
  if (!result.applies) {
    console.log(`OK: nhánh '${headBranch}' ngoài namespace sản xuất ai-prod/** — luật không áp dụng.`);
    return 0;
  }
  if (result.violations.length > 0) {
    console.error(`CHẶN: nhánh sản xuất '${headBranch}' chạm đường bảo vệ test/CI (FR-29):`);
    for (const violation of result.violations) {
      console.error(`  - ${violation}`);
    }
    return 1;
  }
  console.log(`OK: nhánh sản xuất '${headBranch}' không chạm đường bảo vệ (${changed.length} file đổi).`);
  return 0;
}

function main() {
  const [baseSha, headSha, headBranch] = process.argv.slice(2);
  if (!baseSha || !headSha || !headBranch) {
    console.error("Usage: node scripts/check-test-protection.mjs <base-sha> <head-sha> <head-branch>");
    process.exit(2);
  }
  try {
    process.exit(runCheck(baseSha, headSha, headBranch));
  } catch (error) {
    console.error(`CHẶN (fail-closed do lỗi môi trường): ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
