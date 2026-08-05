// KC-11: snapshot quota thuê bao Anthropic qua đúng endpoint mà adapter
// claude-local dùng (packages/adapters/claude-local/src/server/quota.ts).
// Token đọc từ file (KC11_TOKEN_FILE) — không nhận token qua argv, không in
// token; stdout chỉ chứa utilization/resets_at.
//
// Cách chạy:  KC11_TOKEN_FILE=/path/to/token node scripts/kc11/quota-snapshot.mjs

import { readFileSync } from "node:fs";

const tokenFile = process.env.KC11_TOKEN_FILE;
if (!tokenFile) {
  console.error("KC11_TOKEN_FILE is required");
  process.exit(2);
}
const token = readFileSync(tokenFile, "utf8").trim();

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);
let resp;
try {
  resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: controller.signal,
  });
} finally {
  clearTimeout(timer);
}

if (!resp.ok) {
  console.error(`anthropic usage api returned ${resp.status}`);
  process.exit(1);
}
const body = await resp.json();

const pick = (window) =>
  window == null
    ? null
    : { utilization: window.utilization ?? null, resets_at: window.resets_at ?? null };

const snapshot = {
  capturedAt: new Date().toISOString(),
  five_hour: pick(body.five_hour),
  seven_day: pick(body.seven_day),
  seven_day_sonnet: pick(body.seven_day_sonnet),
  seven_day_opus: pick(body.seven_day_opus),
  extra_usage:
    body.extra_usage == null
      ? null
      : {
          is_enabled: body.extra_usage.is_enabled ?? null,
          utilization: body.extra_usage.utilization ?? null,
          monthly_limit: body.extra_usage.monthly_limit ?? null,
          used_credits: body.extra_usage.used_credits ?? null,
        },
};
console.log(JSON.stringify(snapshot, null, 2));
