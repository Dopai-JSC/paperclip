import { performance } from "node:perf_hooks";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { buildKc10Dataset } from "./kc10-dataset.js";
import { KC10_COMPANY_ID, seedKc10OperationalProjection } from "./kc10-seed.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const runId = process.env.KC10_RUN_ID;
if (!runId) throw new Error("KC10_RUN_ID is required");

const dataset = buildKc10Dataset({
  seed: "KC10-20260805-v1",
  anchorTime: "2026-08-05T00:00:00.000Z",
  sourceCommit: "79c42d53aaef0d37532d35aa9565e0aaee346681",
});
const db = createDb(databaseUrl);
const startedAt = new Date().toISOString();
const started = performance.now();
const projection = await seedKc10OperationalProjection(db, KC10_COMPANY_ID, dataset);
const elapsedMs = performance.now() - started;
const counts = await db.execute(sql`
  SELECT
    (SELECT count(*)::int FROM dopaios_kc10_objects WHERE company_id = ${KC10_COMPANY_ID}) AS objects,
    (SELECT count(*)::int FROM dopaios_kc10_project_acl WHERE company_id = ${KC10_COMPANY_ID}) AS acl_entries,
    (SELECT projection_state FROM dopaios_kc10_dataset_runs
      WHERE company_id = ${KC10_COMPANY_ID}
      ORDER BY generated_at DESC, dataset_id DESC LIMIT 1) AS projection_state
`) as unknown as Array<{ objects: number; acl_entries: number; projection_state: string }>;

if (
  counts[0]?.objects !== projection.objects ||
  counts[0]?.acl_entries !== projection.aclEntries ||
  counts[0]?.projection_state !== "complete"
) {
  throw new Error(`KC-10 replay verification failed: ${JSON.stringify(counts[0] ?? null)}`);
}

process.stdout.write(`${JSON.stringify({
  schema: "dopaios.kc10.full-replay-run/v1",
  runId,
  sourceCommit: dataset.manifest.sourceCommit,
  datasetSha256: dataset.manifest.sha256,
  startedAt,
  completedAt: new Date().toISOString(),
  elapsedMs,
  projection,
  verifiedCounts: counts[0],
})}\n`);
process.exit(0);
