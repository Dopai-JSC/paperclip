import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getKc10OperationalObject,
  listKc10OperationalObjects,
} from "../dopaios/kc10-operations.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("KC-10 operational projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const allowedProjectId = randomUUID();
  const deniedProjectId = randomUUID();
  const userId = "kc10-user-01";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc10-operations-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`
      INSERT INTO dopaios_kc10_dataset_runs
        (dataset_id, company_id, manifest_sha256, projection_state, generated_at)
      VALUES
        ('KC10-TEST', ${companyId}, ${"a".repeat(64)}, 'complete', '2026-08-05T00:00:00Z')
    `);
    await db.execute(sql`
      INSERT INTO dopaios_kc10_project_acl (company_id, user_id, project_id, decision)
      VALUES
        (${companyId}, ${userId}, ${allowedProjectId}, 'allow'),
        (${companyId}, ${userId}, ${deniedProjectId}, 'deny')
    `);
    await db.execute(sql`
      INSERT INTO dopaios_kc10_objects
        (company_id, object_id, stable_id, kind, project_id, title, state, owner_id,
         occurred_at, source_href, metadata)
      VALUES
        (${companyId}, ${allowedProjectId}, 'PROJECT-ALLOW', 'project', ${allowedProjectId},
         'Allowed project alpha', 'P0', 'STAFF-01', '2026-08-04T00:00:00Z',
         ${`/projects/${allowedProjectId}`}, '{"risk":"low"}'::jsonb),
        (${companyId}, ${deniedProjectId}, 'PROJECT-DENY', 'project', ${deniedProjectId},
         'Denied project secret', 'P0', 'STAFF-02', '2026-08-04T00:00:00Z',
         ${`/projects/${deniedProjectId}`}, '{"risk":"critical"}'::jsonb),
        (${companyId}, ${randomUUID()}, 'ACTION-ALLOW', 'action_request', ${allowedProjectId},
         'Approve alpha output', 'open', 'STAFF-01', '2026-08-05T00:00:00Z',
         '/inbox/mine', '{"risk":"high"}'::jsonb)
    `);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns only explicitly allowed project data", async () => {
    const result = await listKc10OperationalObjects(db, { companyId, userId });

    expect(result.indexState).toBe("complete");
    expect(result.items.map((item) => item.stableId)).toEqual(["ACTION-ALLOW", "PROJECT-ALLOW"]);
    expect(result.items.some((item) => item.title.includes("secret"))).toBe(false);
  });

  it("fails closed for direct lookup in a denied project", async () => {
    await expect(getKc10OperationalObject(db, {
      companyId,
      userId,
      objectId: deniedProjectId,
    })).resolves.toBeNull();
  });

  it("combines full-text, kind, state, owner and time filters", async () => {
    const result = await listKc10OperationalObjects(db, {
      companyId,
      userId,
      query: "approve alpha",
      kinds: ["action_request"],
      state: "open",
      ownerId: "STAFF-01",
      from: "2026-08-04T12:00:00Z",
      to: "2026-08-05T12:00:00Z",
    });

    expect(result.items.map((item) => item.stableId)).toEqual(["ACTION-ALLOW"]);
    expect(result.items[0]?.sourceHref).toBe("/inbox/mine");
  });

  it("caps a page at fifty and exposes partial index state", async () => {
    const rows = Array.from({ length: 60 }, (_, ordinal) => sql`(
      ${companyId}, ${randomUUID()}, ${`WI-${ordinal}`}, 'work_item', ${allowedProjectId},
      ${`Work item ${ordinal}`}, 'ready', 'STAFF-01', '2026-08-05T00:00:00Z',
      ${`/issues/${ordinal}`}, '{}'::jsonb
    )`);
    await db.execute(sql`
      INSERT INTO dopaios_kc10_objects
        (company_id, object_id, stable_id, kind, project_id, title, state, owner_id,
         occurred_at, source_href, metadata)
      VALUES ${sql.join(rows, sql`, `)}
    `);
    await db.execute(sql`
      UPDATE dopaios_kc10_dataset_runs
      SET projection_state = 'partial'
      WHERE dataset_id = 'KC10-TEST'
    `);

    const result = await listKc10OperationalObjects(db, {
      companyId,
      userId,
      kinds: ["work_item"],
      limit: 500,
    });
    expect(result.indexState).toBe("partial");
    expect(result.items).toHaveLength(50);
    expect(result.hasMore).toBe(true);
  });
});
