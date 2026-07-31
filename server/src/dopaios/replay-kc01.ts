import { createDb } from "@paperclipai/db";
import { countAllEvents, replayProjections, snapshotProjections } from "./event-store.js";

// KC-01 reconciliation runner: rebuilds every projection from the event log,
// then reports row counts so the operator can compare against the
// pre-replay snapshot before reopening reads (SQR-003 / đối soát nguồn).
// Usage: DATABASE_URL=postgres://... pnpm exec tsx server/src/dopaios/replay-kc01.ts

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

console.log(`events in log: ${await countAllEvents(db)}`);
await replayProjections(db);
const snapshot = await snapshotProjections(db);
for (const [table, rows] of Object.entries(snapshot)) {
  console.log(`${table}: ${rows.length} rows`);
}
process.exit(0);
