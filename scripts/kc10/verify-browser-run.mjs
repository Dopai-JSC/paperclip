import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const JOURNEYS = ["project-list", "project-detail", "action-inbox", "work-item", "search"];

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function verifyMeasuredSamples(samples, {
  runId,
  minimumSamples = 200,
  thresholdMs = 3_000,
} = {}) {
  if (!runId) throw new Error("independent verification runId is required");
  const journeys = Object.fromEntries(JOURNEYS.map((journey) => {
    const measured = samples.filter((sample) =>
      sample.runId === runId && sample.phase === "measure" && sample.journey === journey);
    const successful = measured.filter((sample) => sample.ok === true);
    const users = [...new Set(measured.map((sample) => sample.user))].sort((left, right) => left - right);
    const p95Ms = nearestRank(successful.map((sample) => sample.elapsedMs), 0.95);
    const failures = measured.length - successful.length;
    return [journey, {
      samples: measured.length,
      successes: successful.length,
      failures,
      users,
      p50Ms: nearestRank(successful.map((sample) => sample.elapsedMs), 0.5),
      p95Ms,
      maxMs: nearestRank(successful.map((sample) => sample.elapsedMs), 1),
      pass:
        measured.length >= minimumSamples
        && failures === 0
        && users.length === 10
        && p95Ms !== null
        && p95Ms <= thresholdMs,
    }];
  }));
  return {
    schema: "dopaios.kc10.independent-browser-verification/v1",
    runId,
    minimumSamples,
    thresholdMs,
    journeys,
    pass: Object.values(journeys).every((journey) => journey.pass),
  };
}

function main() {
  const runDir = process.argv[2];
  if (!runDir) throw new Error("usage: node verify-browser-run.mjs <run-directory>");
  const manifest = JSON.parse(readFileSync(`${runDir}/run.json`, "utf8"));
  if (manifest.phase !== "measure" || manifest.users !== 10 || manifest.durationSeconds < 1_800) {
    throw new Error("run manifest is not an official 10-user/1800-second measurement");
  }
  const samples = readFileSync(`${runDir}/samples.ndjson`, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = {
    ...verifyMeasuredSamples(samples, {
      runId: manifest.runId,
      minimumSamples: manifest.minimumSamples,
      thresholdMs: 3_000,
    }),
    sourceCommit: manifest.sourceCommit,
    datasetSha256: manifest.datasetSha256,
    browserVersion: manifest.browserVersion,
    durationSeconds: manifest.durationSeconds,
    rawSampleCount: samples.length,
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(`${runDir}/independent-verification.json`, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.pass) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
