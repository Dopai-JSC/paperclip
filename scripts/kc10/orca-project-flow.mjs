import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { allRecordedFocusVisible, assertPinnedBrowserEvidence } from "./kc10-lib.mjs";

const companyId = "2c3d90b5-2d57-58d4-a12c-0bb5ae7c2f10";
const baseUrl = process.env.KC10_BASE_URL ?? "http://172.26.14.51:3100";
const browserId = process.env.KC10_BROWSER_ID ?? "chrome-150";
const browserPath = process.env.KC10_BROWSER_PATH;
const runId = process.env.KC10_RUN_ID;
const outputDir = process.env.KC10_OUTPUT_DIR;
const credentialPath = process.env.KC10_CREDENTIALS_PATH ?? "/opt/dopaios-kc10/secrets/runtime-seed.json";

if (!browserPath || !runId || !outputDir) {
  throw new Error("KC10_BROWSER_PATH, KC10_RUN_ID, and KC10_OUTPUT_DIR are required");
}

const browserVersion = execFileSync(browserPath, ["--version"], { encoding: "utf8" }).trim();
const browserProductVersion = execFileSync(browserPath, ["--product-version"], { encoding: "utf8" }).trim();
assertPinnedBrowserEvidence({ id: browserId, version: browserVersion, productVersion: browserProductVersion });
const orcaVersion = execFileSync("orca", ["--version"], { encoding: "utf8" }).trim();
const seed = JSON.parse(readFileSync(credentialPath, "utf8"));
const credential = seed.credentials?.[0];
if (!credential?.token || !credential?.sessionCookie) throw new Error("KC-10 credential 0 is incomplete");

function writeJson(name, value) {
  writeFileSync(`${outputDir}/${name}`, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

async function activeControl(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement) || element === document.body) return null;
    const labels = "labels" in element && element.labels
      ? Array.from(element.labels).map((label) => label.textContent?.trim() ?? "").filter(Boolean)
      : [];
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      name: element.getAttribute("aria-label")
        || labels.join(" ")
        || element.getAttribute("placeholder")
        || element.innerText?.trim()
        || element.textContent?.trim()
        || "",
      focusVisible: element.matches(":focus-visible")
        || Boolean(element.closest("[data-focus-visible-container]")?.matches(":focus-within")),
    };
  });
}

async function tabTo(page, pattern, log, screen, maxTabs = 160) {
  for (let press = 1; press <= maxTabs; press += 1) {
    osKey("Tab");
    await page.waitForTimeout(500);
    const active = await activeControl(page);
    log.push({ screen, press, active });
    if (active && pattern.test(active.name)) {
      if (!active.focusVisible) throw new Error(`${active.name} is not :focus-visible`);
      return active;
    }
  }
  throw new Error(`keyboard focus did not reach ${pattern}`);
}

const startedAt = new Date().toISOString();
const focusLog = [];
let createdProject = null;
let browserWindowId = null;

function osKey(key) {
  if (!browserWindowId) throw new Error("browser X11 window is not focused");
  execFileSync("xdotool", ["key", "--window", browserWindowId, "--clearmodifiers", key]);
}

function osType(value) {
  if (!browserWindowId) throw new Error("browser X11 window is not focused");
  execFileSync("xdotool", [
    "type",
    "--window",
    browserWindowId,
    "--clearmodifiers",
    "--delay",
    "20",
    value,
  ]);
}
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: false,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--force-renderer-accessibility",
  ],
});
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
  secure: false,
  sameSite: "Lax",
}]);

try {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/KC10/projects`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Add Project" }).first().waitFor({ state: "visible" });
  await page.screenshot({ path: `${outputDir}/01-project-list.png`, fullPage: true });
  await page.bringToFront();
  browserWindowId = execFileSync("xdotool", ["search", "--name", "Paperclip"], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .at(-1);
  if (!browserWindowId) throw new Error("could not resolve the Chrome X11 window");
  execFileSync("xdotool", ["windowfocus", "--sync", browserWindowId]);
  await page.waitForTimeout(1_500);

  await tabTo(page, /Add Project/i, focusLog, "project-list");
  osKey("Return");
  const nameInput = page.getByPlaceholder("Project name");
  await nameInput.waitFor({ state: "visible" });
  await page.waitForTimeout(800);
  const dialogFocus = await activeControl(page);
  focusLog.push({ screen: "project-dialog-autofocus", press: 0, active: dialogFocus });
  if (!dialogFocus?.focusVisible || !/Project name/i.test(dialogFocus.name)) {
    throw new Error("Project name did not receive visible dialog autofocus");
  }
  await page.screenshot({ path: `${outputDir}/02-project-dialog.png`, fullPage: true });

  const projectName = `KC10-ORCA-${Date.now()}`;
  osType(projectName);
  osKey("Tab");
  await page.waitForTimeout(800);
  const editorFocus = await activeControl(page);
  focusLog.push({ screen: "project-description", press: 1, active: editorFocus });
  if (!editorFocus?.focusVisible) throw new Error("Project description focus is not visible");
  osType("Real Orca screen-reader rehearsal for the KC-10 Project flow.");
  await tabTo(page, /Create project/i, focusLog, "project-dialog");

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().includes(`/api/companies/${companyId}/projects`));
  osKey("Return");
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`create-project returned ${response.status()}`);
  createdProject = await response.json();
  await page.getByText(projectName, { exact: true }).waitFor({ state: "visible" });
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${outputDir}/03-project-created.png`, fullPage: true });

  writeJson("operator-flow.json", {
    schema: "dopaios.kc10.orca-project-flow/v1",
    runId,
    operatorMode: "AI-assisted real-screen-reader keyboard rehearsal",
    manualHumanSignoff: false,
    policy: "POL-NFR6-BROWSER-A11Y-001@1",
    browserId,
    browserVersion,
    browserProductVersion,
    browserBinarySha256: execFileSync("sha256sum", [browserPath], { encoding: "utf8" }).split(/\s+/)[0],
    orcaVersion,
    startedAt,
    completedAt: new Date().toISOString(),
    createdProjectObserved: Boolean(createdProject?.id),
    keyboardOnly: true,
    focusVisibleAtEveryRecordedControl: allRecordedFocusVisible(focusLog),
    humanManualDisposition: "pending-human-signoff",
  });
  writeJson("keyboard-focus.json", focusLog);
} finally {
  if (createdProject?.id) {
    const cleanup = await context.request.delete(
      `${baseUrl}/api/projects/${createdProject.id}?companyId=${companyId}`,
    );
    if (!cleanup.ok()) throw new Error(`project cleanup returned ${cleanup.status()}`);
  }
  await context.close();
  await browser.close();
}
