import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { CommandRejectedError, DOPAIOS_ERROR_CODES } from "./errors.js";

// I-5 — danh mục ERR-* tập trung: test cưỡng chế (1) mã đúng khuôn mẫu hiện
// thực số 3, (2) không trùng, (3) mọi literal "ERR-*" trong core/ có mặt
// trong danh mục — thêm mã mới mà quên ghi danh mục là test đỏ.

const coreDir = dirname(fileURLToPath(import.meta.url));

function collectCoreErrorLiterals(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(full, "utf8");
      for (const match of source.matchAll(/"(ERR-[A-Z0-9-]+)"/g)) {
        found.add(match[1]);
      }
    }
  };
  walk(coreDir);
  return found;
}

describe("dopaios core/errors — danh mục ERR-*", () => {
  test("mã đúng khuôn ERR-<DANH-MỤC>[-<CHI-TIẾT>]", () => {
    for (const code of DOPAIOS_ERROR_CODES) {
      expect(code).toMatch(/^ERR-[A-Z0-9]+(-[A-Z0-9]+)*$/);
    }
  });

  test("không có mã trùng", () => {
    expect(new Set(DOPAIOS_ERROR_CODES).size).toBe(DOPAIOS_ERROR_CODES.length);
  });

  test("mọi literal ERR-* trong core/ nằm trong danh mục", () => {
    const catalog = new Set<string>(DOPAIOS_ERROR_CODES);
    const missing = [...collectCoreErrorLiterals()].filter((code) => !catalog.has(code));
    expect(missing).toEqual([]);
  });

  test("CommandRejectedError giữ code và message", () => {
    const err = new CommandRejectedError("ERR-CONTENTION", "Xung đột ghi");
    expect(err.code).toBe("ERR-CONTENTION");
    expect(err.message).toBe("Xung đột ghi");
    expect(err.name).toBe("CommandRejectedError");
  });
});
