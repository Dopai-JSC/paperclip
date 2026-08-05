import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  PINNED_BROWSER_PACKAGES,
  assertPinnedBrowserEvidence,
  allRecordedFocusVisible,
  staffCapabilityUrl,
  standardPermissionPayload,
} from "./kc10-lib.mjs";

const companyId = "2c3d90b5-2d57-58d4-a12c-0bb5ae7c2f10";
const baseUrl = process.env.KC10_BASE_URL ?? "http://172.26.14.51:3100";
const browserId = process.env.KC10_BROWSER_ID;
const browserPath = process.env.KC10_BROWSER_PATH;
const runId = process.env.KC10_RUN_ID;
const credentialPath = process.env.KC10_CREDENTIALS_PATH ?? "/opt/dopaios-kc10/secrets/runtime-seed.json";
const outputRoot = process.env.KC10_OUTPUT_ROOT ?? "/opt/dopaios-kc10/evidence";
const axePath = process.env.KC10_AXE_PATH ?? "node_modules/.pnpm/axe-core@4.12.0/node_modules/axe-core/axe.min.js";

if (!browserId) throw new Error("KC10_BROWSER_ID is required");
if (!browserPath) throw new Error("KC10_BROWSER_PATH is required");
if (!runId) throw new Error("KC10_RUN_ID is required");
const browserVersion = execFileSync(browserPath, ["--version"], { encoding: "utf8" }).trim();
const browserProductVersion = execFileSync(browserPath, ["--product-version"], { encoding: "utf8" }).trim();
assertPinnedBrowserEvidence({ id: browserId, version: browserVersion, productVersion: browserProductVersion });

const seed = JSON.parse(readFileSync(credentialPath, "utf8"));
if (!Array.isArray(seed.credentials) || seed.credentials.length !== 10) {
  throw new Error("KC-10 runtime seed must contain exactly 10 credentials");
}
const outputDir = `${outputRoot}/${runId}`;
mkdirSync(outputRoot, { recursive: true });
mkdirSync(outputDir, { recursive: false });

const checks = [];
const focusLog = [];
const failures = [];
let createdProject = null;

function writeJson(name, value) {
  writeFileSync(`${outputDir}/${name}`, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function newAuthenticatedContext(browser, credential) {
  const context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${credential.token}` },
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await context.addCookies([{
    name: credential.sessionCookie.name,
    value: credential.sessionCookie.value,
    url: baseUrl,
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    sameSite: "Lax",
  }]);
  return context;
}

async function activeElementInfo(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    if (element === document.body) {
      return { tag: "body", role: null, name: "", focusVisible: false, disabled: false };
    }
    const labels = "labels" in element && element.labels
      ? Array.from(element.labels).map((label) => label.textContent?.trim() ?? "").filter(Boolean)
      : [];
    const name = element.getAttribute("aria-label")
      || labels.join(" ")
      || element.getAttribute("placeholder")
      || element.getAttribute("title")
      || element.innerText?.trim()
      || element.textContent?.trim()
      || "";
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name,
      focusVisible: element.matches(":focus-visible")
        || Boolean(element.closest("[data-focus-visible-container]")?.matches(":focus-within")),
      disabled: "disabled" in element ? Boolean(element.disabled) : false,
    };
  });
}

async function focusByAccessibleName(page, screen, pattern, maxTabs = 180) {
  for (let press = 1; press <= maxTabs; press += 1) {
    await page.keyboard.press("Tab");
    const active = await activeElementInfo(page);
    focusLog.push({ screen, press, active });
    if (active && pattern.test(active.name)) {
      if (!active.focusVisible) throw new Error(`${screen}: ${active.name} is not :focus-visible`);
      return active;
    }
  }
  throw new Error(`${screen}: keyboard focus never reached ${pattern}`);
}

async function captureAx(page, screen) {
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send("Accessibility.getFullAXTree");
    writeJson(`${screen}-ax-tree.json`, tree);
  } finally {
    await session.detach();
  }
}

async function auditScreen(page, screen) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => globalThis.axe.run(document, {
    runOnly: {
      type: "tag",
      values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
    },
  }));
  const violations = result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: violation.tags,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary,
    })),
  }));
  checks.push({ screen, violationCount: violations.length, violations });
  await page.screenshot({ path: `${outputDir}/${screen}.png`, fullPage: true });
  await captureAx(page, screen);
}

async function runCreateProjectFlow(browser) {
  const context = await newAuthenticatedContext(browser, seed.credentials[0]);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/KC10/projects`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Project" }).first().waitFor({ state: "visible" });
    await auditScreen(page, "create-project-01-list");
    await focusByAccessibleName(page, "create-project-list", /Add Project/i);
    await page.keyboard.press("Enter");
    const nameInput = page.getByPlaceholder("Project name");
    await nameInput.waitFor({ state: "visible" });
    const dialogFocus = await activeElementInfo(page);
    focusLog.push({ screen: "create-project-dialog-autofocus", press: 0, active: dialogFocus });
    if (!dialogFocus?.focusVisible || !/Project name/i.test(dialogFocus.name)) {
      throw new Error("create-project dialog did not visibly autofocus Project name");
    }
    await auditScreen(page, "create-project-02-dialog");
    const projectName = `KC10-A11Y-${browserId}-${Date.now()}`;
    await page.keyboard.type(projectName);
    await page.keyboard.press("Tab");
    const editorFocus = await activeElementInfo(page);
    focusLog.push({ screen: "create-project-description", press: 1, active: editorFocus });
    if (!editorFocus?.focusVisible) throw new Error("create-project description focus is not visible");
    await page.keyboard.type("Keyboard-only WCAG 2.2 AA verification project.");
    await focusByAccessibleName(page, "create-project-dialog", /Create project/i);
    const responsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/companies/${companyId}/projects`));
    await page.keyboard.press("Enter");
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`create-project returned ${response.status()}`);
    createdProject = await response.json();
    await page.getByText(projectName, { exact: true }).waitFor({ state: "visible" });
    await auditScreen(page, "create-project-03-created");
  } finally {
    if (createdProject?.id) {
      const cleanup = await context.request.delete(
        `${baseUrl}/api/projects/${createdProject.id}?companyId=${companyId}`,
      );
      if (!cleanup.ok()) failures.push(`project cleanup returned ${cleanup.status()}`);
    }
    await context.close();
  }
}

async function runBlockedAuthorityFlow(browser) {
  const context = await newAuthenticatedContext(browser, seed.credentials[1]);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/KC10/company/settings/members`, { waitUntil: "domcontentloaded" });
    await page.getByText("You do not have permission to manage company members.", { exact: true })
      .waitFor({ state: "visible" });
    const message = await page.getByText("You do not have permission to manage company members.", { exact: true })
      .textContent();
    if (!message?.includes("permission")) throw new Error("blocked authority state has no textual explanation");
    await focusByAccessibleName(page, "blocked-authority", /Projects|Agents|Dashboard/i);
    await auditScreen(page, "blocked-authority-01-denied");
  } finally {
    await context.close();
  }
}

async function runStaffCapabilityFlow(browser) {
  const context = await newAuthenticatedContext(browser, seed.credentials[0]);
  const page = await context.newPage();
  let agentId = null;
  let baselinePermissions = null;
  try {
    const agentsResponse = await context.request.get(`${baseUrl}/api/companies/${companyId}/agents`);
    if (!agentsResponse.ok()) throw new Error(`agent fixture lookup returned ${agentsResponse.status()}`);
    const agents = await agentsResponse.json();
    if (!Array.isArray(agents) || agents.length === 0) throw new Error("agent fixture lookup returned no agents");
    agentId = agents[0].id;
    const permissionsUrl = `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/permissions?companyId=${companyId}`;
    const detailResponse = await context.request.get(
      `${baseUrl}/api/agents/${encodeURIComponent(agentId)}?companyId=${companyId}`,
    );
    if (!detailResponse.ok()) throw new Error(`agent fixture detail returned ${detailResponse.status()}`);
    baselinePermissions = standardPermissionPayload(await detailResponse.json());
    const resetResponse = await context.request.patch(permissionsUrl, { data: baselinePermissions });
    if (!resetResponse.ok()) throw new Error(`agent fixture baseline reset returned ${resetResponse.status()}`);

    await page.goto(staffCapabilityUrl(baseUrl, "KC10", agentId), { waitUntil: "domcontentloaded" });
    await page.getByText("Trust", { exact: true }).waitFor({ state: "visible" });
    await auditScreen(page, "staff-capability-01-detail");
    await focusByAccessibleName(page, "staff-capability-detail", /Trust preset/i);
    const select = page.getByLabel("Trust preset");
    const originalValue = await select.inputValue();
    if (originalValue !== "standard") throw new Error(`agent fixture reset left Trust preset at ${originalValue}`);
    const updateResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && response.url().includes(`/agents/${agentId}/permissions`));
    await page.keyboard.press("ArrowDown");
    const updateResponse = await updateResponsePromise;
    if (!updateResponse.ok()) throw new Error(`Trust preset update returned ${updateResponse.status()}`);
    await page.waitForFunction(() =>
      document.querySelector('select[aria-label="Trust preset"]')?.value === "low_trust_review");
    await auditScreen(page, "staff-capability-02-changed");
  } finally {
    if (agentId && baselinePermissions) {
      const cleanup = await context.request.patch(
        `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/permissions?companyId=${companyId}`,
        { data: baselinePermissions },
      );
      if (!cleanup.ok()) failures.push(`staff permission cleanup returned ${cleanup.status()}`);
    }
    await context.close();
  }
}

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const startedAt = new Date().toISOString();
for (const [name, flow] of [
  ["create-project", runCreateProjectFlow],
  ["blocked-authority", runBlockedAuthorityFlow],
  ["staff-capability", runStaffCapabilityFlow],
]) {
  try {
    await flow(browser);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
await browser.close();

const manifest = {
  schema: "dopaios.kc10.browser-a11y-run/v1",
  runId,
  policy: {
    id: "POL-NFR6-BROWSER-A11Y-001@1",
    blob: "74ce5de2fbebb18fdb10c72d0c130ff789144ffb",
    pinnedDate: "2026-07-28",
  },
  sourceCommit: seed.dataset.sourceCommit,
  datasetSha256: seed.dataset.sha256,
  browserId,
  browserPath,
  browserVersion,
  browserProductVersion,
  packageSource: PINNED_BROWSER_PACKAGES[browserId],
  browserBinarySha256: execFileSync("sha256sum", [browserPath], { encoding: "utf8" }).split(/\s+/)[0],
  startedAt,
  completedAt: new Date().toISOString(),
  automatedScreens: checks.length,
  axeViolationCount: checks.reduce((sum, check) => sum + check.violationCount, 0),
  keyboardFocusEvents: focusLog.length,
  keyboardFocusFailures: focusLog.filter((entry) => entry.active?.focusVisible !== true).length,
  screenReaderEvidence: "Chrome DevTools full accessibility tree; policy-required manual screen-reader check remains human-only",
  failures,
  passAutomatedAndKeyboard: failures.length === 0
    && checks.every((check) => check.violationCount === 0)
    && allRecordedFocusVisible(focusLog),
  manualScreenReaderDisposition: "pending-human-check",
};
writeJson("axe-results.json", checks);
writeJson("keyboard-focus.json", focusLog);
writeJson("run.json", manifest);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
if (!manifest.passAutomatedAndKeyboard) process.exitCode = 2;
