import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executeCommand,
  replayProjections,
  snapshotProjections,
  CommandPayloadMismatchError,
  type CommandContext,
} from "../dopaios/event-store.ts";
import {
  declareWorkItemDependency,
  transitiveDependents,
  transitiveDependencies,
  wouldCreateCycle,
} from "../dopaios/graph-repo.ts";
import { registerActor } from "../dopaios/commands.ts";

// KC-15 B1: nền đồ thị phụ thuộc dùng chung — schema 0513 + projector + lệnh
// khai cạnh + traversal qua graph-repo (QD-1/QD-2, ADR-019 phương án C).
// Đồ thị kiểm: hai nhánh độc lập + chuỗi sâu 3 mức + hợp lưu kim cương.
//
//   A1 ── A2 ── A3        (chuỗi sâu nhánh A: A3 -> A2 -> A1)
//   B1 ── B2               (nhánh B độc lập)
//   D  phụ thuộc A2 VÀ B1  (kim cương: hai đường tới D)
//
// Cạnh ghi theo chiều "hạ nguồn phụ thuộc thượng nguồn".

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-15 B1 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dopaios KC-15 B1 — đồ thị phụ thuộc dùng chung", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Chạy một truy vấn graph-repo trong transaction lệnh — traversal luôn đọc
  // cùng snapshot với guard (SFR-048/049).
  async function inCommand<T>(
    commandId: string,
    fn: (ctx: CommandContext) => Promise<T>,
  ): Promise<T> {
    let out!: T;
    await executeCommand(db, {
      commandId,
      payload: { read: commandId },
      handler: async (ctx) => {
        out = await fn(ctx);
        return { ok: true };
      },
    });
    return out;
  }

  async function seedRunWithItems(
    prefix: string,
    runId: string,
    itemIds: string[],
    runState = "RUNNING",
  ): Promise<void> {
    await executeCommand(db, {
      commandId: `${prefix}-SEED`,
      payload: { runId, itemIds, runState },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: `dopaiosSopRun-${runId}`,
          type: "TestRunRequested",
          data: {
            runId,
            definitionRef: { definitionId: `DEF-${runId}` },
            decider: "DECIDER-KC15",
            pod: "POD-KC15",
          },
          expectedVersion: -1,
        });
        if (runState !== "NOT_ACTIVATED") {
          await ctx.emit({
            streamName: `dopaiosSopRun-${runId}`,
            type: "SopRunStateChanged",
            data: { runId, state: runState },
          });
        }
        for (const itemId of itemIds) {
          await ctx.emit({
            streamName: `dopaiosWorkItem-${itemId}`,
            type: "WorkItemCreated",
            data: { workItemId: itemId, runId, state: "ACCEPTED" },
            expectedVersion: -1,
          });
        }
        return { seeded: itemIds.length };
      },
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc15-b1-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, "KC15-B1-ACTOR", {
      actorId: "ORCH-KC15",
      kind: "human",
      active: true,
      capabilities: ["orchestrator"],
    });
    await registerActor(db, "KC15-B1-ACTOR-OFF", {
      actorId: "GONE-KC15",
      kind: "human",
      active: false,
      capabilities: [],
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("khai cạnh qua lệnh: đồ thị kim cương + chuỗi sâu dựng đúng projection", async () => {
    await seedRunWithItems("KC15-B1-G", "RUN-KC15-G", [
      "WI-A1",
      "WI-A2",
      "WI-A3",
      "WI-B1",
      "WI-B2",
      "WI-D",
    ]);
    const edges: Array<[string, string]> = [
      ["WI-A2", "WI-A1"],
      ["WI-A3", "WI-A2"],
      ["WI-B2", "WI-B1"],
      ["WI-D", "WI-A2"],
      ["WI-D", "WI-B1"],
    ];
    for (const [from, to] of edges) {
      const result = await declareWorkItemDependency(db, `KC15-B1-E-${from}-${to}`, {
        workItemId: from,
        dependsOnWorkItemId: to,
        declaredBy: "ORCH-KC15",
        basis: { needsOutputOf: to },
      });
      expect(result["runId"]).toBe("RUN-KC15-G");
    }

    const rows = (await db.execute(
      sql`SELECT work_item_id, depends_on_work_item_id, run_id, declared_by
          FROM dopaios_work_item_dependencies ORDER BY work_item_id, depends_on_work_item_id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { work_item_id: "WI-A2", depends_on_work_item_id: "WI-A1", run_id: "RUN-KC15-G", declared_by: "ORCH-KC15" },
      { work_item_id: "WI-A3", depends_on_work_item_id: "WI-A2", run_id: "RUN-KC15-G", declared_by: "ORCH-KC15" },
      { work_item_id: "WI-B2", depends_on_work_item_id: "WI-B1", run_id: "RUN-KC15-G", declared_by: "ORCH-KC15" },
      { work_item_id: "WI-D", depends_on_work_item_id: "WI-A2", run_id: "RUN-KC15-G", declared_by: "ORCH-KC15" },
      { work_item_id: "WI-D", depends_on_work_item_id: "WI-B1", run_id: "RUN-KC15-G", declared_by: "ORCH-KC15" },
    ]);
  });

  it("traversal: hạ nguồn/thượng nguồn bắc cầu đúng tập, kim cương không nhân đôi", async () => {
    // Hạ nguồn của A1: chuỗi sâu A2, A3 và D (qua A2) — KHÔNG gồm nhánh B.
    const downstreamOfA1 = await inCommand("KC15-B1-Q1", (ctx) =>
      transitiveDependents(ctx, ["WI-A1"]),
    );
    expect(downstreamOfA1).toEqual(["WI-A2", "WI-A3", "WI-D"]);

    // Hạ nguồn của B1: B2 và D — KHÔNG gồm nhánh A ("không chặn thừa").
    const downstreamOfB1 = await inCommand("KC15-B1-Q2", (ctx) =>
      transitiveDependents(ctx, ["WI-B1"]),
    );
    expect(downstreamOfB1).toEqual(["WI-B2", "WI-D"]);

    // Thượng nguồn của D: cả hai đường kim cương, khử trùng lặp, sâu 2 mức.
    const upstreamOfD = await inCommand("KC15-B1-Q3", (ctx) =>
      transitiveDependencies(ctx, "WI-D"),
    );
    expect(upstreamOfD).toEqual(["WI-A1", "WI-A2", "WI-B1"]);

    // Thượng nguồn của A3: chuỗi sâu 2 mức về gốc.
    const upstreamOfA3 = await inCommand("KC15-B1-Q4", (ctx) =>
      transitiveDependencies(ctx, "WI-A3"),
    );
    expect(upstreamOfA3).toEqual(["WI-A1", "WI-A2"]);

    // Nút không có cạnh: hai chiều đều rỗng; roots rỗng trả rỗng.
    expect(await inCommand("KC15-B1-Q5", (ctx) => transitiveDependents(ctx, ["WI-A3"]))).toEqual([]);
    expect(await inCommand("KC15-B1-Q6", (ctx) => transitiveDependents(ctx, []))).toEqual([]);
  });

  it("chu trình bị từ chối fail-closed, kể cả chu trình bắc cầu", async () => {
    // A1 -> A3 tạo vòng A1 -> A3 -> A2 -> A1 (bắc cầu qua 2 cạnh).
    await expect(
      declareWorkItemDependency(db, "KC15-B1-CYCLE-1", {
        workItemId: "WI-A1",
        dependsOnWorkItemId: "WI-A3",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-CYCLE" });
    // Cạnh ngược trực tiếp của cạnh đã có cũng là chu trình.
    await expect(
      declareWorkItemDependency(db, "KC15-B1-CYCLE-2", {
        workItemId: "WI-A1",
        dependsOnWorkItemId: "WI-A2",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-CYCLE" });
    // wouldCreateCycle đọc được trực tiếp qua graph-repo.
    expect(
      await inCommand("KC15-B1-CYCLE-Q", (ctx) => wouldCreateCycle(ctx, "WI-B1", "WI-D")),
    ).toBe(true);
    // Không cạnh nào bị ghi bởi các lệnh bị từ chối.
    const count = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_work_item_dependencies`,
    )) as unknown as Array<{ n: number }>;
    expect(count[0].n).toBe(5);
  });

  it("guard hình dạng production: tự phụ thuộc, trùng cạnh, khác run, run không RUNNING, actor sai", async () => {
    await seedRunWithItems("KC15-B1-R2", "RUN-KC15-OTHER", ["WI-OTHER-1"]);
    await seedRunWithItems("KC15-B1-R3", "RUN-KC15-IDLE", ["WI-IDLE-1", "WI-IDLE-2"], "NOT_ACTIVATED");

    await expect(
      declareWorkItemDependency(db, "KC15-B1-N1", {
        workItemId: "WI-A1",
        dependsOnWorkItemId: "WI-A1",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-SELF-DEP" });

    await expect(
      declareWorkItemDependency(db, "KC15-B1-N2", {
        workItemId: "WI-D",
        dependsOnWorkItemId: "WI-A2",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-DUP-EDGE" });

    await expect(
      declareWorkItemDependency(db, "KC15-B1-N3", {
        workItemId: "WI-OTHER-1",
        dependsOnWorkItemId: "WI-A1",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-EDGE-RUN" });

    await expect(
      declareWorkItemDependency(db, "KC15-B1-N4", {
        workItemId: "WI-IDLE-2",
        dependsOnWorkItemId: "WI-IDLE-1",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "SFR-057" });

    await expect(
      declareWorkItemDependency(db, "KC15-B1-N5", {
        workItemId: "WI-B1",
        dependsOnWorkItemId: "WI-A1",
        declaredBy: "GONE-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-ACTOR" });

    await expect(
      declareWorkItemDependency(db, "KC15-B1-N6", {
        workItemId: "WI-B1",
        dependsOnWorkItemId: "WI-KHONG-TON-TAI",
        declaredBy: "ORCH-KC15",
      }),
    ).rejects.toMatchObject({ code: "ERR-TARGET" });

    // Mỗi lần chặn để lại vệt audit bất biến (executeAuditedCommand).
    const audits = (await db.execute(
      sql`SELECT count(*)::int AS n FROM message_store.messages
          WHERE type = 'CommandRejected'
            AND data->>'commandId' LIKE 'KC15-B1-N%'`,
    )) as unknown as Array<{ n: number }>;
    expect(audits[0].n).toBe(6);
  });

  it("idempotency: cùng command_id cùng payload replay, khác payload bị từ chối", async () => {
    const payload = {
      workItemId: "WI-B1",
      dependsOnWorkItemId: "WI-A1",
      declaredBy: "ORCH-KC15",
    };
    const first = await declareWorkItemDependency(db, "KC15-B1-IDEM", payload);
    expect(first["idempotentReplay"]).toBeUndefined();
    const replay = await declareWorkItemDependency(db, "KC15-B1-IDEM", payload);
    expect(replay["idempotentReplay"]).toBe(true);
    await expect(
      declareWorkItemDependency(db, "KC15-B1-IDEM", {
        ...payload,
        dependsOnWorkItemId: "WI-A2",
      }),
    ).rejects.toBeInstanceOf(CommandPayloadMismatchError);
  });

  it("replay dựng lại projection cạnh byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
    expect(Object.keys(after)).toContain("dopaios_work_item_dependencies");
    expect((after["dopaios_work_item_dependencies"] as unknown[]).length).toBe(6);
  });
});
