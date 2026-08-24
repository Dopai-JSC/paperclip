import { createDb } from "@paperclipai/db";
import { measureKc10RouteToActivation } from "./kc10-routing-benchmark.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const runId = process.env.KC10_RUN_ID;
if (!runId) throw new Error("KC10_RUN_ID is required");
const sampleCount = Number(process.env.KC10_SAMPLES ?? 200);
if (!Number.isInteger(sampleCount) || sampleCount < 200) {
  throw new Error("KC10_SAMPLES must be an integer of at least 200");
}

const db = createDb(databaseUrl);
const samples = [];
for (let ordinal = 1; ordinal <= sampleCount; ordinal += 1) {
  const sample = await measureKc10RouteToActivation(db, { runId, ordinal });
  samples.push(sample);
  process.stdout.write(`${JSON.stringify(sample)}\n`);
}
const sorted = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
const nearestRank = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1];
process.stdout.write(`${JSON.stringify({
  schema: "dopaios.kc10.route-to-activation-run/v1",
  runId,
  sourceCommit: "79c42d53aaef0d37532d35aa9565e0aaee346681",
  sampleCount,
  p50Ms: nearestRank(0.5),
  p95Ms: nearestRank(0.95),
  maxMs: nearestRank(1),
})}\n`);
process.exit(0);
