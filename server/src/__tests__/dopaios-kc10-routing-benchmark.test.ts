import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { measureKc10RouteToActivation } from "../dopaios/kc10-routing-benchmark.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("KC-10 routing to activation benchmark", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc10-routing-benchmark-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("measures the real WorkItemRouted event through the queued activation projection", async () => {
    const sample = await measureKc10RouteToActivation(db, {
      runId: randomUUID(),
      ordinal: 1,
    });

    expect(sample.elapsedMs).toBeGreaterThan(0);
    expect(sample.activationState).toBe("QUEUED");
    await expect(db.execute(sql`
      SELECT routed_to FROM dopaios_work_items WHERE id = ${sample.workItemId}
    `)).resolves.toMatchObject([{ routed_to: sample.agentId }]);
  });
});
