import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// KC-11: bảng giá LiteLLM vendored theo Phụ lục A (loại F — file nhập theo
// commit + checksum). Nguồn giá là file JSON đã pin trong repo; module này
// fail-closed: sai checksum hoặc model không có giá thì từ chối, không đoán.

export const LITELLM_PRICE_COMMIT = "e926097fecc79e58cee0937cd54bf67f445a0c45";
export const LITELLM_PRICE_SHA256 =
  "64c1cd8e97ecf9801c8cf66c66f16552168b08535230b8e0a5304fdee31a08b5";
export const LITELLM_PRICING_DATE = "2026-08-05";
export const PRICE_SOURCE = `litellm@${LITELLM_PRICE_COMMIT.slice(0, 8)}`;

export type ModelPrice = {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
};

export type StepTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
};

export class PriceResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PriceResolutionError";
  }
}

let priceTable: Record<string, Record<string, unknown>> | null = null;

function loadPriceTable(): Record<string, Record<string, unknown>> {
  if (priceTable) return priceTable;
  const here = dirname(fileURLToPath(import.meta.url));
  const pricePath = join(
    here,
    "..",
    "..",
    "..",
    "dopaios",
    "pricing",
    "model_prices_and_context_window.json",
  );
  const raw = readFileSync(pricePath);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== LITELLM_PRICE_SHA256) {
    throw new PriceResolutionError(
      "ERR-PRICE-INTEGRITY",
      `LiteLLM price file checksum ${digest} != pinned ${LITELLM_PRICE_SHA256}`,
    );
  }
  priceTable = JSON.parse(raw.toString("utf8")) as Record<string, Record<string, unknown>>;
  return priceTable;
}

// Tra giá theo tên model CLI trả về: thử key đúng nguyên văn trước, sau đó
// một biến thể có tiền tố provider phổ biến. Không khớp thì fail-closed.
export function resolveModelPrice(model: string): ModelPrice {
  const table = loadPriceTable();
  const candidates = [model, `anthropic/${model}`, `openai/${model}`];
  for (const key of candidates) {
    const entry = table[key];
    if (!entry) continue;
    const input = entry["input_cost_per_token"];
    const output = entry["output_cost_per_token"];
    if (typeof input !== "number" || typeof output !== "number") continue;
    const cacheRead = entry["cache_read_input_token_cost"];
    const cacheCreation = entry["cache_creation_input_token_cost"];
    return {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: typeof cacheRead === "number" ? cacheRead : input,
      cacheCreationCostPerToken: typeof cacheCreation === "number" ? cacheCreation : input,
    };
  }
  throw new PriceResolutionError(
    "ERR-PRICE-UNKNOWN-MODEL",
    `No pinned price for model "${model}" (source ${PRICE_SOURCE})`,
  );
}

// Chi phí API-tương-đương = token × bảng giá pin, quantize 8 chữ số thập phân
// và trả về CHUỖI để event/projection replay byte-identical (không tái tính,
// không trôi float).
export function computeCostUsd(model: string, usage: StepTokenUsage): string {
  if (
    !Number.isInteger(usage.inputTokens) ||
    !Number.isInteger(usage.cachedInputTokens) ||
    !Number.isInteger(usage.cacheCreationInputTokens) ||
    !Number.isInteger(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.cachedInputTokens < 0 ||
    usage.cacheCreationInputTokens < 0 ||
    usage.outputTokens < 0
  ) {
    throw new PriceResolutionError("ERR-PRICE-USAGE", "Token counts must be non-negative integers");
  }
  const price = resolveModelPrice(model);
  const cost =
    usage.inputTokens * price.inputCostPerToken +
    usage.cachedInputTokens * price.cacheReadCostPerToken +
    usage.cacheCreationInputTokens * price.cacheCreationCostPerToken +
    usage.outputTokens * price.outputCostPerToken;
  return cost.toFixed(8);
}

// Chuẩn hóa chuỗi cost 8 chữ số thập phân (dùng cho giá trị adapter tự báo).
export function normalizeCostUsdString(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PriceResolutionError("ERR-PRICE-USAGE", `Invalid reported costUsd: ${String(value)}`);
  }
  return parsed.toFixed(8);
}
