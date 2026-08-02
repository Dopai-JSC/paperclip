import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 3208;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-kc07-mcp-home-"));
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "instances", "kc07-mcp", "config.json");
const OUTPUT_DIR = process.env.KC07_MCP_EVIDENCE_DIR
  ?? path.join(os.homedir(), "spike", "kc07-playwright-mcp");

process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_CONFIG = PAPERCLIP_CONFIG;
process.env.KC07_MCP_BASE_URL = BASE_URL;
process.env.KC07_MCP_EVIDENCE_DIR = OUTPUT_DIR;

export default defineConfig({
  testDir: ".",
  testMatch: "kc07-project-create-mcp.spec.ts",
  timeout: 90_000,
  retries: 0,
  workers: 1,
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
      PAPERCLIP_AGENT_JWT_SECRET: "kc07-playwright-mcp-agent-jwt-secret",
      PAPERCLIP_INSTANCE_ID: "kc07-mcp",
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
