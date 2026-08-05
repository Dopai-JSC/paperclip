import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { buildKc10Dataset } from "../dopaios/kc10-dataset.js";
import {
  KC10_COMPANY_ID,
  seedKc10ControlPlane,
  seedKc10OperationalProjection,
} from "../dopaios/kc10-seed.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("KC-10 projection seed", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc10-seed-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("loads the complete FR-62 projection atomically and idempotently", async () => {
    const companyId = randomUUID();
    const dataset = buildKc10Dataset({
      seed: "KC10-20260805-v1",
      anchorTime: "2026-08-05T00:00:00.000Z",
      sourceCommit: "79c42d53aaef0d37532d35aa9565e0aaee346681",
    });

    const first = await seedKc10OperationalProjection(db, companyId, dataset);
    const second = await seedKc10OperationalProjection(db, companyId, dataset);

    expect(first).toEqual({ objects: 14440, aclEntries: 200, projectionState: "complete" });
    expect(second).toEqual(first);
    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM dopaios_kc10_objects WHERE company_id = ${companyId}) AS objects,
        (SELECT count(*)::int FROM dopaios_kc10_project_acl WHERE company_id = ${companyId}) AS acl_entries,
        (SELECT projection_state FROM dopaios_kc10_dataset_runs
          WHERE company_id = ${companyId} ORDER BY generated_at DESC LIMIT 1) AS projection_state
    `) as unknown as Array<{ objects: number; acl_entries: number; projection_state: string }>;
    expect(counts[0]).toEqual({ objects: 14440, acl_entries: 200, projection_state: "complete" });
  }, 30_000);

  it("loads the same deterministic identities into the native and Dopaios control planes", async () => {
    const dataset = buildKc10Dataset({
      seed: "KC10-20260805-v1",
      anchorTime: "2026-08-05T00:00:00.000Z",
      sourceCommit: "79c42d53aaef0d37532d35aa9565e0aaee346681",
    });

    const first = await seedKc10ControlPlane(db, dataset);
    const second = await seedKc10ControlPlane(db, dataset);
    expect(second).toEqual(first);
    expect(first).toEqual({
      companyId: KC10_COMPANY_ID,
      users: 10,
      agents: 40,
      projects: 20,
      issues: 5000,
      sopRuns: 200,
      workItems: 5000,
      aiSessions: 4210,
      signals: 33680,
      checkpoints: 8420,
      graphEdges: 6400,
    });

    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM projects WHERE company_id = ${KC10_COMPANY_ID}) AS projects,
        (SELECT count(*)::int FROM issues WHERE company_id = ${KC10_COMPANY_ID}) AS issues,
        (SELECT count(*)::int FROM dopaios_ai_sessions WHERE id::text LIKE '%') AS ai_sessions,
        (SELECT count(*)::int FROM dopaios_kc10_session_signals
          WHERE dataset_id = ${dataset.manifest.sha256}) AS signals,
        (SELECT count(*)::int FROM dopaios_kc10_checkpoints
          WHERE dataset_id = ${dataset.manifest.sha256}) AS checkpoints,
        (SELECT count(*)::int FROM dopaios_work_item_dependencies
          WHERE declared_by = ${dataset.manifest.sha256}) AS graph_edges
    `) as unknown as Array<Record<string, number>>;
    expect(counts[0]).toEqual({
      projects: 20,
      issues: 5000,
      ai_sessions: 4210,
      signals: 33680,
      checkpoints: 8420,
      graph_edges: 6400,
    });
  }, 60_000);
});
