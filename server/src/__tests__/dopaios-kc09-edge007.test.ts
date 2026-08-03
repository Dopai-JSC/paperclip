import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { registerActor } from "../dopaios/commands.js";
import { assessBreakGlassReadiness } from "../services/authorization.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("dopaios KC-09 EDGE-007 break-glass boundary", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc09-edge007-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => tempDb?.cleanup());

  it("reports EDGE-007 and never auto-elevates when every administrative authority is lost", async () => {
    const before = (await db.execute(sql`SELECT count(*)::int AS n FROM dopaios_actors`)) as unknown as Array<{
      n: number;
    }>;
    const result = await assessBreakGlassReadiness(db);
    const after = (await db.execute(sql`SELECT count(*)::int AS n FROM dopaios_actors`)) as unknown as Array<{
      n: number;
    }>;
    expect(result).toEqual({
      state: "blocked-edge-007",
      activeAdministratorCount: 0,
      automaticRecovery: false,
      requiredAuthority: "DS-4-controlled-break-glass-or-delegation",
    });
    expect(after).toEqual(before);
  });

  it("recognizes an existing administrator only as a DS-4 delegation source", async () => {
    await registerActor(db, "KC09-EDGE007-ADMIN", {
      actorId: "PLATFORM-ADMIN-KC09",
      kind: "human",
      active: true,
      capabilities: ["platform-admin"],
    });
    await expect(assessBreakGlassReadiness(db)).resolves.toEqual({
      state: "delegation-source-available",
      activeAdministratorCount: 1,
      automaticRecovery: false,
      requiredAuthority: "DS-4-controlled-break-glass-or-delegation",
    });
    await db.execute(sql`UPDATE dopaios_actors SET active = false WHERE id = 'PLATFORM-ADMIN-KC09'`);
    await expect(assessBreakGlassReadiness(db)).resolves.toMatchObject({
      state: "blocked-edge-007",
      activeAdministratorCount: 0,
      automaticRecovery: false,
    });
  });
});
