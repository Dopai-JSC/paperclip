import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3207;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-kc07-home-"));
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "instances", "kc07", "config.json");
const OUTPUT_DIR = process.env.KC07_EVIDENCE_DIR ?? path.join(os.homedir(), "spike", "kc07-playwright-api");
const BROWSER_EXECUTABLE = process.env.KC07_BROWSER_EXECUTABLE ?? path.join(
  os.homedir(),
  ".cache",
  "ms-playwright",
  "chromium_headless_shell-1208",
  "chrome-headless-shell-linux64",
  "chrome-headless-shell",
);

process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_CONFIG = PAPERCLIP_CONFIG;
process.env.KC07_BROWSER_EXECUTABLE = BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: ".",
  testMatch: "kc07-project-create.spec.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    browserName: "chromium",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 720 },
    screenshot: "off",
    trace: "on",
    launchOptions: {
      executablePath: BROWSER_EXECUTABLE,
    },
  },
  webServer: {
    command: "pnpm paperclipai onboard --yes --run",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_CONFIG,
      PAPERCLIP_AGENT_JWT_SECRET: "kc07-playwright-agent-jwt-secret",
      PAPERCLIP_INSTANCE_ID: "kc07",
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: path.join(OUTPUT_DIR, "test-results"),
  reporter: [
    ["line"],
    ["json", { outputFile: path.join(OUTPUT_DIR, "report.json") }],
    ["html", { open: "never", outputFolder: path.join(OUTPUT_DIR, "html-report") }],
  ],
});
