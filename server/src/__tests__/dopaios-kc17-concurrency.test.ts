import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { countAllEvents, CommandRejectedError } from "../dopaios/event-store.js";
import { executeCutover } from "../dopaios/cutover.js";
import { setupCutoverBase, baseCutoverPayload } from "./helpers/dopaios-kc17.js";

// KC-17 B5 — đúng-một-lần dưới tương tranh thật (AC-V1-10 + KC-01
// SERIALIZABLE/SSI): hai lệnh kích hoạt đua nhau chỉ một bên thắng; replay
// đồng thời không tạo lần kích hoạt thứ hai. Bên thua thua bằng rejection
// sạch (guard trạng thái sau retry SSI) — không phải lỗi PG thô.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-17 B5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC17-B5-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-17 B5 — đúng-một-lần dưới tương tranh", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let winnerKey = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc17-b5-");
    db = createDb(tempDb.connectionString);
    await setupCutoverBase(db, cmd);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("hai lệnh kích hoạt đua nhau (key khác nhau): đúng một bên thắng, một snapshot, một record", async () => {
    const keyA = "KC17-RACE-A";
    const keyB = "KC17-RACE-B";
    const [resultA, resultB] = await Promise.allSettled([
      executeCutover(
        db,
        keyA,
        baseCutoverPayload(keyA, { snapshotId: "RAS-RACE-A", cutoverRecordId: "CUTOVER-REC-RACE-A" }),
      ),
      executeCutover(
        db,
        keyB,
        baseCutoverPayload(keyB, { snapshotId: "RAS-RACE-B", cutoverRecordId: "CUTOVER-REC-RACE-B" }),
      ),
    ]);
    const outcomes = [
      { key: keyA, result: resultA },
      { key: keyB, result: resultB },
    ];
    const winners = outcomes.filter((o) => o.result.status === "fulfilled");
    const losers = outcomes.filter((o) => o.result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    winnerKey = winners[0].key;

    // Bên thua nhận rejection sạch: guard trạng thái (ERR-STATE) sau retry
    // SSI, hoặc ERR-CONTENTION nếu cạn lượt retry — cả hai đều là
    // CommandRejectedError, không phải lỗi PG thô.
    const loserError = (losers[0].result as PromiseRejectedResult).reason as Error;
    expect(loserError).toBeInstanceOf(CommandRejectedError);
    expect(["ERR-STATE", "ERR-CONTENTION"]).toContain((loserError as CommandRejectedError).code);

    const snapshots = (await db.execute(
      sql`SELECT id FROM dopaios_runtime_activation_snapshots`,
    )) as unknown as unknown[];
    const records = (await db.execute(sql`SELECT id FROM dopaios_cutover_records`)) as unknown as unknown[];
    expect(snapshots).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it("replay đồng thời 5 lệnh cùng key: không lần kích hoạt thứ hai, tổng event không đổi (AC-V1-10)", async () => {
    const winnerPayload = baseCutoverPayload(winnerKey, {
      snapshotId: winnerKey === "KC17-RACE-A" ? "RAS-RACE-A" : "RAS-RACE-B",
      cutoverRecordId: winnerKey === "KC17-RACE-A" ? "CUTOVER-REC-RACE-A" : "CUTOVER-REC-RACE-B",
    });
    const eventsBefore = await countAllEvents(db);
    const replays = await Promise.all(
      Array.from({ length: 5 }, () => executeCutover(db, winnerKey, winnerPayload)),
    );
    for (const replay of replays) {
      expect(replay["activated"]).toBe(true);
      expect(replay["idempotentReplay"]).toBe(true);
    }
    const eventsAfter = await countAllEvents(db);
    expect(eventsAfter).toBe(eventsBefore);
    const snapshots = (await db.execute(
      sql`SELECT id FROM dopaios_runtime_activation_snapshots`,
    )) as unknown as unknown[];
    expect(snapshots).toHaveLength(1);
  });
});
