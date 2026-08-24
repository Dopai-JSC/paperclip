import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listProcessDefinitionFiles,
  processesDir,
  renderProcessDefinition,
  renderedFileNameFor,
} from "../dopaios/core/process-render.ts";

// ADR-010 — nửa CI SYNC của đường render/banner: bản diễn giải đã commit
// phải bằng ĐÚNG TỪNG BYTE bản sinh lại từ file định nghĩa hiện hành. Sửa
// file định nghĩa mà không sinh lại bản diễn giải (hoặc sửa tay bản diễn
// giải) là CI đỏ — đây là cơ chế "văn bản được sinh tự động + CI kiểm đồng
// bộ" mà ADR-010 yêu cầu làm evidence trước khi trình duyệt.

const dir = processesDir();

describe("dopaios ADR-010 — đồng bộ bản diễn giải với file định nghĩa", () => {
  const definitionFiles = listProcessDefinitionFiles(dir);

  it("có ít nhất một process definition để kiểm", () => {
    expect(definitionFiles.length).toBeGreaterThan(0);
  });

  for (const fileName of definitionFiles) {
    it(`bản diễn giải của ${fileName} tồn tại, đúng banner và đúng từng byte`, () => {
      const renderedPath = join(dir, "rendered", renderedFileNameFor(fileName));
      expect(
        existsSync(renderedPath),
        `Thiếu bản diễn giải ${renderedFileNameFor(fileName)} — chạy: pnpm --filter @paperclipai/server exec tsx src/dopaios/core/process-render.ts`,
      ).toBe(true);

      const committed = readFileSync(renderedPath, "utf8");
      const regenerated = renderProcessDefinition(readFileSync(join(dir, fileName)), fileName) + "\n";
      expect(
        committed,
        `Bản diễn giải ${renderedFileNameFor(fileName)} lệch với file định nghĩa — sinh lại rồi commit cùng nhau`,
      ).toBe(regenerated);

      expect(committed.startsWith("<!-- BẢN DIỄN GIẢI — SINH TỰ ĐỘNG, KHÔNG SỬA TAY -->")).toBe(true);
      expect(committed).toContain("BẢN DIỄN GIẢI (ADR-010)");
      expect(committed).toContain("nguồn chân lý THỰC THI");
    });
  }

  it("render tất định: hai lần sinh cùng input cho cùng output", () => {
    for (const fileName of definitionFiles) {
      const bytes = readFileSync(join(dir, fileName));
      expect(renderProcessDefinition(bytes, fileName)).toBe(renderProcessDefinition(bytes, fileName));
    }
  });
});
