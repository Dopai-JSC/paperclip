import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Bốn file drill KC-16 viết bằng node:test (chạy qua harness recovery —
    // docs/deploy/dopaios-kc16-recovery-runbook.md), không phải suite vitest:
    // vitest import chúng thì node:test tự chạy (9/9 pass) rồi vitest báo
    // "No test suite found" — loại khỏi vòng vitest, KHÔNG tắt nội dung test.
    exclude: [
      "**/node_modules/**",
      "src/__tests__/dopaios-kc16-observability.test.ts",
      "src/__tests__/dopaios-kc16-operator.test.ts",
      "src/__tests__/dopaios-kc16-probes.test.ts",
      "src/__tests__/dopaios-kc16-recovery.test.ts",
    ],
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    hookTimeout: 60_000,
    pool: "forks",
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
