import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { PostgresSessionStore } from "../dopaios/session-store/PostgresSessionStore.js";
import { DopaiosSessionStore } from "../dopaios/session-store/DopaiosSessionStore.js";
import { runSessionStoreConformance } from "../dopaios/session-store/conformance.js";

// KC-02 B4: adapter mẫu SessionStore -> Postgres của Agent SDK 0.3.220
// (bản chép verbatim, pin 71c804dc8) + lớp cứng hóa Dopai dedupe theo
// entry.uuid, cùng chạy bộ conformance 13 check của SDK trên Postgres nhúng.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-02 session-store tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dopaios KC-02 SessionStore -> Postgres", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pool!: pg.Pool;
  let tableCounter = 0;
  const created: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc02-store-");
    pool = new pg.Pool({ connectionString: tempDb.connectionString });
  }, 60_000);

  afterAll(async () => {
    for (const table of created) {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await pool.end();
    await tempDb?.cleanup();
  });

  function freshTableName(prefix: string): string {
    tableCounter += 1;
    const table = `${prefix}_${tableCounter}`;
    created.push(table);
    return table;
  }

  describe("verbatim PostgresSessionStore (reference)", () => {
    runSessionStoreConformance(async () => {
      const store = new PostgresSessionStore({ pool, tableName: freshTableName("ref") });
      await store.ensureSchema();
      return store;
    });
  });

  describe("DopaiosSessionStore (dedupe hardening)", () => {
    runSessionStoreConformance(async () => {
      const store = new DopaiosSessionStore({ pool, tableName: freshTableName("dop") });
      await store.ensureSchema();
      return store;
    });

    it("deduplicates retried appends by entry.uuid (SDK retries up to 3x)", async () => {
      const store = new DopaiosSessionStore({ pool, tableName: freshTableName("dedupe") });
      await store.ensureSchema();
      const key = { projectKey: "proj", sessionId: "sess" };
      const batch = [
        { type: "user", uuid: "u-1", text: "hello" },
        { type: "assistant", uuid: "u-2", text: "world" },
      ];
      await store.append(key, batch);
      await store.append(key, batch); // retry 1
      await store.append(key, [batch[1]]); // retry 2, một phần
      const loaded = await store.load(key);
      expect(loaded).toHaveLength(2);
      expect(loaded?.map((e) => (e as { uuid: string }).uuid)).toEqual(["u-1", "u-2"]);
    });

    it("reference store duplicates the same retry — documenting why hardening exists", async () => {
      const store = new PostgresSessionStore({ pool, tableName: freshTableName("refdup") });
      await store.ensureSchema();
      const key = { projectKey: "proj", sessionId: "sess" };
      const batch = [{ type: "user", uuid: "u-1", text: "hello" }];
      await store.append(key, batch);
      await store.append(key, batch);
      const loaded = await store.load(key);
      expect(loaded).toHaveLength(2);
    });
  });
});
