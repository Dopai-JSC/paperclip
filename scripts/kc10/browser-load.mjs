import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import {
  JOURNEYS,
  PINNED_BROWSER_PACKAGES,
  assertPinnedBrowserEvidence,
  assertOfficialWorkload,
  extractPrimaryJsAsset,
  summarizeOfficialSamples,
} from "./kc10-lib.mjs";

const companyId = "2c3d90b5-2d57-58d4-a12c-0bb5ae7c2f10";
const companyPrefix = "KC10";
const baseUrl = process.env.KC10_BASE_URL ?? "http://172.26.14.51:3100";
const phase = process.env.KC10_PHASE ?? "smoke";
const durationSeconds = Number(process.env.KC10_DURATION_SECONDS ?? (phase === "measure" ? 1_800 : phase === "warmup" ? 300 : 30));
const users = Number(process.env.KC10_USERS ?? 10);
const minimumSamples = Number(process.env.KC10_MINIMUM_SAMPLES ?? 200);
const browserPath = process.env.KC10_BROWSER_PATH;
const browserId = process.env.KC10_BROWSER_ID ?? "chrome-150";
const credentialPath = process.env.KC10_CREDENTIALS_PATH ?? "/opt/dopaios-kc10/secrets/runtime-seed.json";
const runId = process.env.KC10_RUN_ID ?? `kc10-${phase}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
const outputRoot = process.env.KC10_OUTPUT_ROOT ?? "/opt/dopaios-kc10/evidence";
const outputDir = `${outputRoot}/${runId}`;

if (!browserPath) throw new Error("KC10_BROWSER_PATH is required");
if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("KC10_DURATION_SECONDS must be positive");
if (phase === "measure") assertOfficialWorkload({ users, durationSeconds, minimumSamples });
if (users !== 10) throw new Error("KC-10 harness always requires exactly 10 concurrent user sessions");

const seed = JSON.parse(readFileSync(credentialPath, "utf8"));
if (!Array.isArray(seed.credentials) || seed.credentials.length !== 10) {
  throw new Error("KC-10 runtime seed must contain exactly 10 credentials");
}
if (seed.credentials.some((credential) =>
  typeof credential.sessionCookie?.name !== "string" ||
  typeof credential.sessionCookie?.value !== "string")) {
  throw new Error("KC-10 runtime seed credentials must contain Better Auth session cookies");
}
mkdirSync(outputRoot, { recursive: true });
mkdirSync(outputDir, { recursive: false });
const raw = createWriteStream(`${outputDir}/samples.ndjson`, { flags: "wx", mode: 0o600 });
const samples = [];
const failures = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fetchApplicationArtifact() {
  const indexResponse = await fetch(baseUrl);
  if (!indexResponse.ok) throw new Error(`application index returned ${indexResponse.status}`);
  const indexBytes = Buffer.from(await indexResponse.arrayBuffer());
  const primaryJsPath = extractPrimaryJsAsset(indexBytes.toString("utf8"));
  const primaryJsResponse = await fetch(new URL(primaryJsPath, baseUrl));
  if (!primaryJsResponse.ok) throw new Error(`application asset returned ${primaryJsResponse.status}`);
  const primaryJsBytes = Buffer.from(await primaryJsResponse.arrayBuffer());
  return {
    indexSha256: sha256(indexBytes),
    primaryJsPath,
    primaryJsSha256: sha256(primaryJsBytes),
  };
}

function prefixedSourceHref(sourceHref) {
  const url = new URL(sourceHref, baseUrl);
  url.pathname = `/${companyPrefix}${url.pathname}`;
  return url.toString();
}

async function getObject(context, kind) {
  const url = `${baseUrl}/api/companies/${companyId}/kc10/objects?kind=${encodeURIComponent(kind)}&limit=1&offset=0`;
  const response = await context.request.get(url);
  if (!response.ok()) throw new Error(`fixture lookup ${kind} failed with ${response.status()}`);
  const body = await response.json();
  if (body.indexState !== "complete" || body.items.length !== 1) {
    throw new Error(`fixture lookup ${kind} did not return one complete item`);
  }
  return body.items[0];
}

async function targetsFor(context) {
  const [project, workItem] = await Promise.all([
    getObject(context, "project"),
    getObject(context, "work_item"),
  ]);
  return {
    "project-list": `${baseUrl}/${companyPrefix}/projects?kc10=1`,
    "project-detail": prefixedSourceHref(project.sourceHref),
    "action-inbox": `${baseUrl}/${companyPrefix}/inbox/mine?kc10=1`,
    "work-item": prefixedSourceHref(workItem.sourceHref),
    search: `${baseUrl}/${companyPrefix}/search?kc10=1&q=WI-KC10&kind=work_item`,
  };
}

async function runUser(browser, credential, ordinal, deadlineMs) {
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
  const page = await context.newPage();
  const targets = await targetsFor(context);
  let sequence = 0;
  try {
    while (Date.now() < deadlineMs) {
      const journey = JOURNEYS[sequence % JOURNEYS.length];
      const startedAt = performance.now();
      const wallStartedAt = new Date().toISOString();
      let sample;
      try {
        const response = await page.goto(targets[journey], { waitUntil: "domcontentloaded", timeout: 15_000 });
        if (!response?.ok()) throw new Error(`document status ${response?.status() ?? "none"}`);
        await page.locator(`main[data-kc10-journey="${journey}"][data-kc10-ready="true"]`).waitFor({
          state: "visible",
          timeout: 15_000,
        });
        const semanticE2eMs = await page.evaluate((name) => {
          const entries = performance.getEntriesByName(name);
          return entries.length > 0 ? entries.at(-1).duration : null;
        }, `kc10:${journey}:e2e`);
        sample = {
          schema: "dopaios.kc10.browser-sample/v1",
          runId, phase, user: ordinal + 1, sequence, journey,
          startedAt: wallStartedAt,
          elapsedMs: performance.now() - startedAt,
          semanticE2eMs,
          ok: true,
        };
      } catch (error) {
        sample = {
          schema: "dopaios.kc10.browser-sample/v1",
          runId, phase, user: ordinal + 1, sequence, journey,
          startedAt: wallStartedAt,
          elapsedMs: performance.now() - startedAt,
          semanticE2eMs: null,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        failures.push(sample);
      }
      samples.push(sample);
      raw.write(`${JSON.stringify(sample)}\n`);
      sequence += 1;
    }
  } finally {
    await context.close();
  }
}

const browserVersion = execFileSync(browserPath, ["--version"], { encoding: "utf8" }).trim();
const browserProductVersion = execFileSync(browserPath, ["--product-version"], { encoding: "utf8" }).trim();
assertPinnedBrowserEvidence({ id: browserId, version: browserVersion, productVersion: browserProductVersion });
const applicationArtifact = await fetchApplicationArtifact();
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const startedAt = new Date().toISOString();
const deadlineMs = Date.now() + durationSeconds * 1_000;
try {
  await Promise.all(seed.credentials.map((credential, ordinal) =>
    runUser(browser, credential, ordinal, deadlineMs)));
} finally {
  await browser.close();
  await new Promise((resolve) => raw.end(resolve));
}
const completedAt = new Date().toISOString();
const summary = phase === "measure"
  ? summarizeOfficialSamples(samples, { minimumSamples, thresholdMs: 3_000 })
  : null;
const manifest = {
  schema: "dopaios.kc10.browser-run/v1",
  runId,
  phase,
  sourceCommit: seed.dataset.sourceCommit,
  datasetSha256: seed.dataset.sha256,
  applicationArtifact,
  browserId,
  browserPath,
  browserVersion,
  browserProductVersion,
  browserPackageSource: PINNED_BROWSER_PACKAGES[browserId],
  browserBinarySha256: execFileSync("sha256sum", [browserPath], { encoding: "utf8" }).split(/\s+/)[0],
  users,
  durationSeconds,
  minimumSamples,
  startedAt,
  completedAt,
  sampleCount: samples.length,
  failureCount: failures.length,
  journeyCounts: Object.fromEntries(JOURNEYS.map((journey) => [journey, samples.filter((sample) => sample.journey === journey).length])),
  summary,
};
writeFileSync(`${outputDir}/run.json`, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify(manifest)}\n`);
if (failures.length > 0 || (summary && Object.values(summary).some((journey) => !journey.pass))) process.exitCode = 2;
