import { createHash } from "node:crypto";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-010 (In review) — đường RENDER/BANNER: sinh "bản diễn giải" đọc được
// từ process definition (SOP dạng mã có schema). Quyết định ADR-010: sau
// chuyển đổi, file thực thi là nguồn chân lý thực thi duy nhất; văn bản
// tương ứng phải được SINH TỰ ĐỘNG hoặc gắn banner "bản diễn giải" và được
// CI KIỂM ĐỒNG BỘ. Module này là nửa render + banner; nửa CI sync là
// contract test dopaios-process-render-sync.test.ts (so byte bản render
// commit với bản sinh lại từ file định nghĩa — lệch là CI đỏ).
//
// TRẠNG THÁI HIỆU LỰC: đây là EVIDENCE để CTO trình duyệt ADR-010, không tự
// tạo hiệu lực. Chừng nào ADR-010 còn In review, văn bản SOP hiện hành trong
// docs/sop/ của repo dopaios vẫn là nguồn chân lý nghiệp vụ (QD-02 KC-06) —
// bản render dưới đây diễn giải FILE ĐỊNH NGHĨA, không thay văn bản SOP.
//
// Renderer generic có chủ đích (QD-10 KC-06): không nhánh riêng theo SOP
// nào; render tất định từng byte — cùng input cùng output, không timestamp.

type Json = Record<string, unknown>;

function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function renderList(lines: string[], label: string, items: unknown[]): void {
  if (items.length === 0) return;
  lines.push(`- **${label}:**`);
  for (const item of items) {
    lines.push(`  - \`${typeof item === "string" ? item : JSON.stringify(item)}\``);
  }
}

export function renderProcessDefinition(definitionBytes: Buffer, sourceFileName: string): string {
  const definition = JSON.parse(definitionBytes.toString("utf8")) as Json;
  const digest = sha256Hex(definitionBytes);
  const lines: string[] = [];

  lines.push("<!-- BẢN DIỄN GIẢI — SINH TỰ ĐỘNG, KHÔNG SỬA TAY -->");
  lines.push("");
  lines.push("> **BẢN DIỄN GIẢI (ADR-010).** Tài liệu này được sinh tự động từ file");
  lines.push(`> định nghĩa \`${sourceFileName}\` (sha256 \`${digest}\`).`);
  lines.push("> File định nghĩa là nguồn chân lý THỰC THI của quy trình; muốn đổi quy");
  lines.push("> trình thì sửa file định nghĩa qua review rồi sinh lại bản này — không");
  lines.push("> sửa bản diễn giải. CI kiểm đồng bộ: bản này lệch với file định nghĩa");
  lines.push("> là build đỏ. Chừng nào ADR-010 còn In review, văn bản SOP hiện hành");
  lines.push("> (repo dopaios, docs/sop/) vẫn là nguồn chân lý NGHIỆP VỤ.");
  lines.push("");
  lines.push(`# ${String(definition["title"] ?? definition["id"])}`);
  lines.push("");
  lines.push(`- **ID:** \`${String(definition["id"])}\` — revision ${String(definition["revision"])}`);
  lines.push(`- **Schema:** \`${String(definition["schemaVersion"])}\``);
  lines.push(`- **Nguồn thẩm quyền (sourceAuthority):** \`${String(definition["sourceAuthority"])}\``);
  lines.push(`- **Trạng thái khởi đầu:** \`${String(definition["initial"])}\``);
  renderList(lines, "Input", asArray(definition["inputs"]));
  renderList(lines, "Output", asArray(definition["outputs"]));
  renderList(lines, "Runtime contract", asArray(definition["runtimeContracts"]));
  lines.push("");
  lines.push("## Các trạng thái");
  lines.push("");

  const states = (definition["states"] ?? {}) as Record<string, Json>;
  for (const [stateName, state] of Object.entries(states)) {
    lines.push(`### \`${stateName}\``);
    lines.push("");
    lines.push(`- **Loại:** \`${String(state["kind"])}\``);
    if (state["actor"] !== undefined) lines.push(`- **Actor:** \`${String(state["actor"])}\``);
    if (state["activity"] !== undefined) lines.push(`- **Hoạt động:** ${String(state["activity"])}`);
    renderList(lines, "Guard kích hoạt", asArray(state["activationGuards"]));
    renderList(lines, "Input", asArray(state["inputs"]));
    renderList(lines, "Output", asArray(state["outputs"]));
    renderList(lines, "Bằng chứng", asArray(state["evidence"]));
    if (typeof state["onCompleted"] === "string") {
      lines.push(`- **Khi hoàn tất →** \`${state["onCompleted"]}\``);
    }
    if (state["decisions"] !== undefined) {
      lines.push("- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**");
      for (const [outcome, target] of Object.entries(state["decisions"] as Json)) {
        lines.push(
          `  - \`${outcome}\` → \`${typeof target === "string" ? target : JSON.stringify(target)}\``,
        );
      }
    }
    if (state["decisionEffects"] !== undefined) {
      lines.push(`- **Hiệu ứng quyết định:** \`${JSON.stringify(state["decisionEffects"])}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

const PROCESSES_DIR_FROM_HERE = ["..", "..", "..", "..", "dopaios", "processes"];

export function processesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, ...PROCESSES_DIR_FROM_HERE);
}

export function listProcessDefinitionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /\.v\d+\.json$/.test(name))
    .sort();
}

export function renderedFileNameFor(definitionFileName: string): string {
  return definitionFileName.replace(/\.json$/, ".md");
}

// Sinh lại toàn bộ bản diễn giải vào dopaios/processes/rendered/ — chạy tay
// khi đổi file định nghĩa: pnpm --filter @paperclipai/server exec tsx
// src/dopaios/core/process-render.ts
export function regenerateAll(dir: string = processesDir()): string[] {
  const outDir = join(dir, "rendered");
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const fileName of listProcessDefinitionFiles(dir)) {
    const rendered = renderProcessDefinition(readFileSync(join(dir, fileName)), fileName);
    const outPath = join(outDir, renderedFileNameFor(fileName));
    writeFileSync(outPath, rendered + "\n", "utf8");
    written.push(outPath);
  }
  return written;
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href;
if (invokedDirectly) {
  for (const path of regenerateAll()) {
    console.log(`rendered: ${basename(path)}`);
  }
}
