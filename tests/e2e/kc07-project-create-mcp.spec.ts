import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type TestInfo } from "@playwright/test";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { Client: PgClient } = requireFromServer("pg") as typeof import("pg");

const TARGET_REVISION = "4a56a0c9781b35e53386b2be7bcd74443f4a8bc5";
const DESCRIPTION = "KC-07 deterministic live-product evaluator project.";
const COMPANY_NAME = "KC07 Evaluator Company";
const HOME = os.homedir();
const BASE_URL = process.env.KC07_MCP_BASE_URL ?? "http://127.0.0.1:3208";
const MCP_EVIDENCE_DIR = process.env.KC07_MCP_EVIDENCE_DIR
  ?? path.join(HOME, "spike", "kc07-playwright-mcp");
const MCP_BIN = process.env.KC07_MCP_BIN
  ?? path.join(HOME, "spike", "kc07-tools", "node_modules", ".bin", "playwright-mcp");
const MCP_SDK_ROOT = process.env.KC07_MCP_SDK_ROOT
  ?? path.join(
    HOME,
    "spike",
    "kc07-mcp-client-tools",
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
  );
const BROWSER_EXECUTABLE = process.env.KC07_BROWSER_EXECUTABLE
  ?? path.join(
    HOME,
    ".cache",
    "ms-playwright",
    "chromium_headless_shell-1208",
    "chrome-headless-shell-linux64",
    "chrome-headless-shell",
  );
const RUNS = Number.parseInt(process.env.KC07_MCP_RUNS ?? "10", 10);

type McpContent = { type: string; text?: string; data?: string; mimeType?: string };
type McpResult = { content?: McpContent[]; isError?: boolean; [key: string]: unknown };
type TranscriptEntry = {
  tool: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  content: Array<Record<string, unknown>>;
};

function textContent(result: McpResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function snapshotContent(result: McpResult, attemptDir: string): string {
  const text = textContent(result);
  const snapshotLink = text.match(/\[Snapshot\]\(([^)]+\.yml)\)/)?.[1];
  if (!snapshotLink) return text;
  const snapshotPath = path.join(attemptDir, path.basename(snapshotLink));
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`MCP snapshot link did not resolve inside the attempt evidence directory: ${snapshotPath}`);
  }
  return `${text}\n${fs.readFileSync(snapshotPath, "utf8")}`;
}

function sanitizeContent(content: McpContent[] | undefined): Array<Record<string, unknown>> {
  return (content ?? []).map((item) => {
    if (item.type !== "image" || !item.data) return item;
    return {
      type: item.type,
      mimeType: item.mimeType,
      bytes: Buffer.byteLength(item.data, "base64"),
      sha256: createHash("sha256").update(item.data, "base64").digest("hex"),
    };
  });
}

function findRef(snapshot: string, pattern: RegExp, description: string): string {
  const match = snapshot.match(pattern);
  if (!match?.[1]) throw new Error(`Could not locate ${description} in MCP snapshot.`);
  return match[1];
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${url}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}`);
  return await response.json() as T;
}

async function createMcpClient(attemptDir: string): Promise<{ client: any; toolNames: string[] }> {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(path.join(MCP_SDK_ROOT, "client", "index.js")).href),
    import(pathToFileURL(path.join(MCP_SDK_ROOT, "client", "stdio.js")).href),
  ]);
  const transport = new StdioClientTransport({
    command: MCP_BIN,
    args: [
      "--headless",
      "--isolated",
      "--caps", "devtools",
      "--save-session",
      "--output-dir", attemptDir,
      "--output-mode", "file",
      "--executable-path", BROWSER_EXECUTABLE,
      "--viewport-size", "1280x720",
      "--console-level", "error",
      "--timeout-action", "10000",
      "--timeout-navigation", "60000",
    ],
  });
  const client = new Client({ name: "kc07-playwright-mcp-evaluator", version: "1.0.0" });
  await client.connect(transport);
  const catalog = await client.listTools();
  return { client, toolNames: catalog.tools.map((tool: { name: string }) => tool.name).sort() };
}

test.describe.serial("KC-07 Playwright MCP — create Project", () => {
  for (let attempt = 1; attempt <= RUNS; attempt += 1) {
    const ordinal = String(attempt).padStart(2, "0");
    const attemptId = `A${ordinal}`;
    const projectName = `KC07-EVAL-${attemptId}`;

    test(`${attemptId} creates, verifies, and removes a Project through MCP`, async ({}, testInfo: TestInfo) => {
      const attemptDir = path.join(MCP_EVIDENCE_DIR, "sessions", attemptId);
      fs.mkdirSync(attemptDir, { recursive: true });
      const transcript: TranscriptEntry[] = [];
      let createdId: string | undefined;
      let companyId: string | undefined;
      let client: any;

      try {
        const connected = await createMcpClient(attemptDir);
        client = connected.client;
        const requiredTools = [
          "browser_click",
          "browser_console_messages",
          "browser_navigate",
          "browser_snapshot",
          "browser_start_tracing",
          "browser_stop_tracing",
          "browser_take_screenshot",
          "browser_type",
          "browser_wait_for",
        ];
        expect(requiredTools.every((name) => connected.toolNames.includes(name))).toBe(true);

        const call = async (tool: string, args: Record<string, unknown>): Promise<McpResult> => {
          const result = await client.callTool({ name: tool, arguments: args }) as McpResult;
          transcript.push({
            tool,
            arguments: args,
            isError: result.isError === true,
            content: sanitizeContent(result.content),
          });
          if (result.isError) throw new Error(`${tool} failed: ${textContent(result)}`);
          return result;
        };

        await call("browser_start_tracing", {});

        const companies = await apiJson<Array<{ id: string; name: string }>>("/api/companies");
        let company = companies.find((candidate) => candidate.name === COMPANY_NAME);
        if (!company) {
          company = await apiJson<{ id: string; name: string }>("/api/companies", {
            method: "POST",
            body: JSON.stringify({
              name: COMPANY_NAME,
              description: "Deterministic company fixture for KC-07 evaluator runs.",
            }),
          });
        }
        companyId = company.id;

        const beforeProjects = await apiJson<Array<{ id: string; name: string }>>(
          `/api/companies/${company.id}/projects`,
        );
        for (const stale of beforeProjects.filter((project) => project.name === projectName)) {
          await apiJson(`/api/projects/${stale.id}?companyId=${company.id}`, { method: "DELETE" });
        }

        const navigate = await call("browser_navigate", { url: `${BASE_URL}/projects` });
        let snapshot = snapshotContent(navigate, attemptDir);
        if (!snapshot.includes("Add Project")) {
          snapshot = snapshotContent(await call("browser_wait_for", { text: "Add Project" }), attemptDir);
        }
        const addProjectRef = findRef(snapshot, /button "Add Project" \[ref=(e\d+)\]/, "Add Project button");

        await call("browser_take_screenshot", {
          type: "png",
          scale: "css",
          filename: path.join(attemptDir, `${attemptId}-before-create.png`),
          fullPage: true,
        });
        const openForm = await call("browser_click", {
          element: "Add Project button",
          target: addProjectRef,
        });
        snapshot = snapshotContent(openForm, attemptDir);
        if (!snapshot.includes("Project name")) {
          snapshot = snapshotContent(await call("browser_snapshot", {}), attemptDir);
        }

        const nameRef = findRef(snapshot, /textbox "Project name"[^\n]*\[ref=(e\d+)\]/, "Project name textbox");
        const descriptionRef = findRef(
          snapshot,
          /textbox "editable markdown"[^\n]*\[ref=(e\d+)\]/,
          "project description textbox",
        );
        await call("browser_type", { element: "Project name", target: nameRef, text: projectName });
        const descriptionResult = await call("browser_type", {
          element: "Project description",
          target: descriptionRef,
          text: DESCRIPTION,
        });
        snapshot = snapshotContent(descriptionResult, attemptDir);
        if (!/button "Create project"[^\n]*\[ref=e\d+\]/.test(snapshot)) {
          snapshot = snapshotContent(await call("browser_snapshot", {}), attemptDir);
        }
        const createRef = findRef(
          snapshot,
          /button "Create project"[^\n]*\[ref=(e\d+)\]/,
          "Create project button",
        );
        const createResult = await call("browser_click", {
          element: "Create project button",
          target: createRef,
        });
        snapshot = snapshotContent(createResult, attemptDir);
        if (!snapshot.includes(projectName)) {
          snapshot = snapshotContent(await call("browser_snapshot", {}), attemptDir);
        }
        expect(snapshot).toContain(projectName);

        const projects = await apiJson<Array<{
          id: string;
          companyId: string;
          name: string;
          description: string | null;
          status: string;
        }>>(`/api/companies/${company.id}/projects`);
        const created = projects.find((project) => project.name === projectName);
        expect(created).toBeDefined();
        createdId = created!.id;
        expect(created).toMatchObject({
          companyId: company.id,
          name: projectName,
          description: DESCRIPTION,
          status: "planned",
        });

        const db = new PgClient({ connectionString: process.env.DATABASE_URL });
        await db.connect();
        const dbResult = await db.query(
          "select id, company_id, name, description, status from projects where id = $1",
          [createdId],
        );
        await db.end();
        expect(dbResult.rows).toEqual([{
          id: createdId,
          company_id: company.id,
          name: projectName,
          description: DESCRIPTION,
          status: "planned",
        }]);

        await call("browser_take_screenshot", {
          type: "png",
          scale: "css",
          filename: path.join(attemptDir, `${attemptId}-after-create.png`),
          fullPage: true,
        });
        const consoleErrors = textContent(await call("browser_console_messages", { level: "error", all: true }));
        expect(consoleErrors).not.toMatch(/\[error\]/i);

        await apiJson(`/api/projects/${createdId}?companyId=${company.id}`, { method: "DELETE" });
        const verifyDb = new PgClient({ connectionString: process.env.DATABASE_URL });
        await verifyDb.connect();
        const afterDelete = await verifyDb.query(
          "select count(*)::int as count from projects where id = $1",
          [createdId],
        );
        await verifyDb.end();
        expect(afterDelete.rows[0].count).toBe(0);
        createdId = undefined;

        await call("browser_stop_tracing", {});

        const oraclePath = testInfo.outputPath("oracle.json");
        fs.writeFileSync(oraclePath, `${JSON.stringify({
          adapter: "playwright-mcp",
          attempt: attemptId,
          targetRevision: TARGET_REVISION,
          mcpVersion: "0.0.78",
          sdkVersion: "1.30.0",
          browserExecutable: BROWSER_EXECUTABLE,
          toolCatalog: connected.toolNames,
          project: created,
          uiVisible: true,
          dbMatched: true,
          cleanupVerified: true,
          consoleErrors,
        }, null, 2)}\n`, "utf8");
        await testInfo.attach("oracle", { path: oraclePath, contentType: "application/json" });
      } finally {
        if (createdId && companyId) {
          await fetch(`${BASE_URL}/api/projects/${createdId}?companyId=${companyId}`, { method: "DELETE" });
        }
        if (client) await client.close();
        const transcriptPath = testInfo.outputPath("mcp-transcript.json");
        fs.writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
        await testInfo.attach("mcp-transcript", {
          path: transcriptPath,
          contentType: "application/json",
        });
      }
    });
  }
});
