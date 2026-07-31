import { DBOS } from "@dbos-inc/dbos-sdk";
import pg from "pg";

// KC-02 B9 (tuy chon): DBOS Transact pin 4.24.16 song hanh voi event store
// message-db tren CUNG database dopaios_kc02. Tieu chi duy nhat: khong xung
// dot — DBOS launch + chay workflow doc/ghi binh thuong, khong dung schema
// message_store hay cac bang dopaios_*.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

// DBOS 4.x chỉ cần system database; trỏ THẲNG vào dopaios_kc02 để schema
// `dbos` nằm cạnh message_store + các bảng dopaios_* — bài kiểm coexistence
// mạnh nhất có thể.
DBOS.setConfig({ name: "b9dbos", systemDatabaseUrl: url });

const probe = DBOS.registerWorkflow(
  async (runId) => {
    const events = await DBOS.runStep(
      async () => {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        const r = await c.query("SELECT count(*)::int AS n FROM message_store.messages");
        await c.end();
        return r.rows[0].n;
      },
      { name: "read-event-count" },
    );
    const probeRows = await DBOS.runStep(
      async () => {
        const c = new pg.Client({ connectionString: url });
        await c.connect();
        await c.query("CREATE TABLE IF NOT EXISTS dopaios_b9_probe (id text PRIMARY KEY, note text)");
        await c.query(
          "INSERT INTO dopaios_b9_probe VALUES ($1,$2) ON CONFLICT (id) DO NOTHING",
          [runId, "dbos-coexist"],
        );
        const r = await c.query("SELECT count(*)::int AS n FROM dopaios_b9_probe");
        await c.end();
        return r.rows[0].n;
      },
      { name: "write-probe" },
    );
    return { events, probeRows };
  },
  { name: "b9-probe" },
);

await DBOS.launch();

const result = await probe(`B9-${Date.now()}`);
console.log("B9-WORKFLOW-RESULT " + JSON.stringify(result));

const c = new pg.Client({ connectionString: url });
await c.connect();
const schemas = await c.query(
  "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY 1",
);
console.log("APPDB-SCHEMAS=" + schemas.rows.map((r) => r.nspname).join(","));
const dbs = await c.query(
  "SELECT datname FROM pg_database WHERE datname LIKE '%dbos%' OR datname LIKE '%b9%' ORDER BY 1",
);
console.log("DBOS-DATABASES=" + dbs.rows.map((r) => r.datname).join(","));
await c.end();

await DBOS.shutdown();
console.log("B9-DONE");
process.exit(0);
