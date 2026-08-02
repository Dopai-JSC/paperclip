import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executeCommand,
  countAllEvents,
  readStream,
  snapshotProjections,
  replayProjections,
  CommandPayloadMismatchError,
} from "../dopaios/event-store.js";
import {
  executeCutover,
  completeCutover,
  writeBootstrapState,
  appendCutoverRecord,
  type CutoverRecordInput,
} from "../dopaios/cutover.js";
import {
  setupCutoverBase,
  baseCutoverPayload,
  FX05,
  FEATURE_ID,
  BOOTSTRAP_WORKFLOW_ID,
  ORCHESTRATOR,
  SYSTEM_ACTOR,
  APPROVAL_RECORD_ID,
  PLAN_DOC,
  EFFECTIVE_AT,
} from "./helpers/dopaios-kc17.js";

// KC-17 B3 — kích hoạt hợp lệ đúng-một-lần (FX-05 C05–C08, phần completed
// của C08; phần rolled-back thuộc B4). Phép thử quyết định của AC-V1-10:
// replay lệnh kích hoạt không tạo lần kích hoạt thứ hai — kiểm bằng
// idempotent replay (kết quả cũ, tổng event không đổi), cùng key khác
// payload bị CommandPayloadMismatchError (QD-5), và key khác bị guard
// trạng thái chặn. Sau cùng: replay projection byte-identical (SQR-003).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-17 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC17-B3-${label}-${(seq += 1)}`;

const ACTIVATION_KEY = FX05.activation.activation_idempotency_key; // CUTOVER-ACT-SIM-001

async function rowsOf<T>(db: ReturnType<typeof createDb>, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

describeEmbeddedPostgres("dopaios KC-17 B3 — kích hoạt đúng-một-lần", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let snapshotSha = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc17-b3-");
    db = createDb(tempDb.connectionString);
    await setupCutoverBase(db, cmd);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("trước cutover: đường ghi bootstrap còn hợp lệ", async () => {
    const result = await writeBootstrapState(db, cmd("write-before"), {
      workflowId: BOOTSTRAP_WORKFLOW_ID,
      entry: { stateId: "OPEN-STATE-A", note: "cập nhật bootstrap trước cutover" },
      actor: ORCHESTRATOR,
    });
    expect(result["accepted"]).toBe(true);
  });

  it("FX-05-C05: kích hoạt hợp lệ — snapshot đủ nội dung, record effective đủ trường, bootstrap tắt", async () => {
    const result = await executeCutover(db, ACTIVATION_KEY, baseCutoverPayload(ACTIVATION_KEY));
    expect(result["activated"]).toBe(true);
    expect(result["firstWorkItemRef"]).toBe(PLAN_DOC.first_runtime_work_item_ref); // WI-SIM-001
    snapshotSha = (result["snapshot"] as { sha256: string }).sha256;

    // Runtime Activation Snapshot đủ tám nhóm nội dung (PRD d.318).
    const snapshots = await rowsOf<Record<string, unknown>>(
      db,
      sql`SELECT * FROM dopaios_runtime_activation_snapshots`,
    );
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0];
    expect(snapshot["id"]).toBe("RAS-SIM-001");
    expect(snapshot["sha256"]).toBe(snapshotSha);
    expect(snapshot["plan_ref"]).toMatchObject({ artifactId: "CUTOVER-PLAN-SIM-001", revision: 1 });
    expect(snapshot["approval_ref"]).toMatchObject({ recordId: APPROVAL_RECORD_ID });
    expect(snapshot["authority_actor"]).toBe(ORCHESTRATOR);
    expect(snapshot["system_actor"]).toBe(SYSTEM_ACTOR);
    expect(snapshot["activation_key"]).toBe(ACTIVATION_KEY);
    expect(snapshot["bootstrap_disabled"]).toBe(true);
    expect(snapshot["runtime_workflow_ref"]).toBe("runtime-workflow-sim-001");
    expect(snapshot["first_work_item_ref"]).toBe("WI-SIM-001");
    const results = snapshot["source_state_results"] as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results.find((r) => r["stateId"] === "OPEN-STATE-A")).toMatchObject({
      disposition: "imported",
      result: { workItemRef: "WI-SIM-001" },
    });
    expect(results.find((r) => r["stateId"] === "OPEN-STATE-B")).toMatchObject({
      disposition: "closed",
    });
    expect(
      (results.find((r) => r["stateId"] === "OPEN-STATE-B")?.["result"] as Record<string, unknown>)["evidence"],
    ).toBeTruthy();
    expect(results.find((r) => r["stateId"] === "OPEN-STATE-C")).toMatchObject({
      disposition: "deferred",
      result: { owner: "STAFF-HUMAN-DECIDER-001", due: "2026-08-15T17:00:00+07:00" },
    });

    // Cutover Record `effective` đủ trường theo PRD d.318.
    const records = await rowsOf<Record<string, unknown>>(db, sql`SELECT * FROM dopaios_cutover_records`);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record["id"]).toBe("CUTOVER-REC-SIM-001");
    expect(record["revision"]).toBe(1);
    expect(record["state"]).toBe("effective");
    expect(record["effective_at"]).not.toBeNull();
    expect(record["authority_actor"]).toBe(ORCHESTRATOR);
    expect(record["execution_actor"]).toBe(SYSTEM_ACTOR);
    expect(record["approval_record_ref"]).toMatchObject({ recordId: APPROVAL_RECORD_ID });
    expect(record["first_runtime_work_item_ref"]).toBe("WI-SIM-001");
    expect(record["runtime_activation_snapshot_ref"]).toMatchObject({
      snapshotId: "RAS-SIM-001",
      revision: 1,
      sha256: snapshotSha,
    });
    expect(record["reconciliation_ref"]).toBeNull();

    // Chỉ record effective hợp lệ mới kết thúc bootstrap (PRD d.318).
    const workflows = await rowsOf<Record<string, unknown>>(db, sql`SELECT * FROM dopaios_bootstrap_workflows`);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]["state"]).toBe("DISABLED");
    expect(workflows[0]["disabled_by_ref"]).toMatchObject({ recordId: "CUTOVER-REC-SIM-001", revision: 1 });
  });

  it("FX-05-C05 (đường ghi song song): sau effective, lệnh ghi bootstrap bị từ chối", async () => {
    await expect(
      writeBootstrapState(db, cmd("write-after"), {
        workflowId: BOOTSTRAP_WORKFLOW_ID,
        entry: { stateId: "OPEN-STATE-A", note: "ghi song song sau cutover" },
        actor: ORCHESTRATOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-PARALLEL-WRITE",
      message: expect.stringContaining("không còn đường ghi trạng thái song song"),
    });
  });

  it("FX-05-C06: replay lệnh kích hoạt không tạo lần kích hoạt thứ hai (AC-V1-10)", async () => {
    const eventsBefore = await countAllEvents(db);
    const replay = await executeCutover(db, ACTIVATION_KEY, baseCutoverPayload(ACTIVATION_KEY));
    expect(replay["idempotentReplay"]).toBe(true);
    expect(replay["activated"]).toBe(true);
    expect((replay["snapshot"] as { sha256: string }).sha256).toBe(snapshotSha);
    const eventsAfter = await countAllEvents(db);
    expect(eventsAfter).toBe(eventsBefore);
    const snapshots = await rowsOf(db, sql`SELECT id FROM dopaios_runtime_activation_snapshots`);
    const records = await rowsOf(db, sql`SELECT id FROM dopaios_cutover_records`);
    expect(snapshots).toHaveLength(1);
    expect(records).toHaveLength(1);
  });

  it("QD-5: cùng activation key nhưng payload khác bị CommandPayloadMismatchError", async () => {
    await expect(
      executeCutover(
        db,
        ACTIVATION_KEY,
        baseCutoverPayload(ACTIVATION_KEY, { runtimeWorkflowRef: "runtime-workflow-khac" }),
      ),
    ).rejects.toBeInstanceOf(CommandPayloadMismatchError);
  });

  it("kích hoạt lần thứ hai bằng key khác bị guard trạng thái chặn", async () => {
    const key = "KC17-ACT-SECOND";
    // Guard bootstrap-đã-DISABLED đứng trước guard record-effective — cả hai
    // cùng chặn lần kích hoạt thứ hai; assert cụm chung của hai thông điệp.
    await expect(executeCutover(db, key, baseCutoverPayload(key))).rejects.toMatchObject({
      code: "ERR-STATE",
      message: expect.stringContaining("kích hoạt lần thứ hai"),
    });
  });

  it("FX-05-C07: record thiếu hoặc sai từng ref/actor bị từ chối đích danh", async () => {
    const validBase: CutoverRecordInput = {
      recordId: "CUTOVER-REC-C07",
      revision: 1,
      featureId: FEATURE_ID,
      state: "effective",
      effectiveAt: EFFECTIVE_AT,
      authorityActor: ORCHESTRATOR,
      executionActor: SYSTEM_ACTOR,
      approvalRecordRef: { recordId: APPROVAL_RECORD_ID },
      firstRuntimeWorkItemRef: "WI-SIM-001",
      runtimeActivationSnapshotRef: { snapshotId: "RAS-SIM-001", revision: 1, sha256: snapshotSha },
      reconciliationRef: null,
    };
    const variants: Array<{ label: string; patch: Partial<CutoverRecordInput>; fragment: string }> = [
      { label: "thieu-effective-at", patch: { effectiveAt: null }, fragment: "thiếu effective_at" },
      { label: "thieu-authority", patch: { authorityActor: "" }, fragment: "thiếu authority actor" },
      { label: "thieu-executor", patch: { executionActor: "" }, fragment: "thiếu execution actor" },
      {
        label: "thieu-approval-ref",
        patch: { approvalRecordRef: {} },
        fragment: "thiếu tham chiếu Approval Record",
      },
      {
        label: "approval-ref-khong-ton-tai",
        patch: { approvalRecordRef: { recordId: "APR-MA" } },
        fragment: "không tồn tại",
      },
      {
        label: "thieu-first-ref",
        patch: { firstRuntimeWorkItemRef: "" },
        fragment: "thiếu first_runtime_work_item_ref",
      },
      {
        label: "thieu-snapshot-ref",
        patch: { runtimeActivationSnapshotRef: undefined as unknown as CutoverRecordInput["runtimeActivationSnapshotRef"] },
        fragment: "thiếu runtime_activation_snapshot_ref",
      },
      {
        label: "snapshot-sai-revision",
        patch: { runtimeActivationSnapshotRef: { snapshotId: "RAS-SIM-001", revision: 9, sha256: snapshotSha } },
        fragment: "không tồn tại",
      },
      {
        label: "snapshot-sai-hash",
        patch: { runtimeActivationSnapshotRef: { snapshotId: "RAS-SIM-001", revision: 1, sha256: "f".repeat(64) } },
        fragment: "sai hash",
      },
      { label: "state-khong-hop-le", patch: { state: "activated" as CutoverRecordInput["state"] }, fragment: "state không hợp lệ" },
      { label: "revision-khong-noi-tiep", patch: { revision: 5 }, fragment: "không nối tiếp" },
    ];
    for (const variant of variants) {
      await expect(
        executeCommand(db, {
          commandId: cmd(`c07-${variant.label}`),
          payload: { variant: variant.label },
          handler: async (ctx) => {
            await appendCutoverRecord(ctx, { ...validBase, ...variant.patch });
            return { unreachable: true };
          },
        }),
      ).rejects.toMatchObject({
        code: "ERR-CUTOVER-RECORD",
        message: expect.stringContaining(variant.fragment),
      });
    }
    const strayRecords = await rowsOf(
      db,
      sql`SELECT id FROM dopaios_cutover_records WHERE id = ${"CUTOVER-REC-C07"}`,
    );
    expect(strayRecords).toHaveLength(0);
  });

  it("FX-05-C08 (completed): record completed không kết thúc bootstrap; lịch sử không xóa", async () => {
    const disabledEventsBefore = (await readStream(db, `dopaiosBootstrapWorkflow-${BOOTSTRAP_WORKFLOW_ID}`))
      .filter((event) => event.type === "BootstrapWorkflowDisabled");
    expect(disabledEventsBefore).toHaveLength(1);

    const completed = await completeCutover(db, cmd("complete"), {
      recordId: "CUTOVER-REC-SIM-001",
      executionActor: SYSTEM_ACTOR,
    });
    expect(completed).toMatchObject({ revision: 2, state: "completed" });

    // Lịch sử không xóa: revision 1 effective vẫn nguyên, revision 2 completed thêm vào.
    const records = await rowsOf<Record<string, unknown>>(
      db,
      sql`SELECT revision, state FROM dopaios_cutover_records WHERE id = ${"CUTOVER-REC-SIM-001"} ORDER BY revision`,
    );
    expect(records).toEqual([
      expect.objectContaining({ revision: 1, state: "effective" }),
      expect.objectContaining({ revision: 2, state: "completed" }),
    ]);

    // Record completed KHÔNG phát thêm BootstrapWorkflowDisabled; dấu kết thúc
    // bootstrap vẫn pin đúng revision effective (PRD d.318).
    const disabledEventsAfter = (await readStream(db, `dopaiosBootstrapWorkflow-${BOOTSTRAP_WORKFLOW_ID}`))
      .filter((event) => event.type === "BootstrapWorkflowDisabled");
    expect(disabledEventsAfter).toHaveLength(1);
    const workflows = await rowsOf<Record<string, unknown>>(db, sql`SELECT * FROM dopaios_bootstrap_workflows`);
    expect(workflows[0]["state"]).toBe("DISABLED");
    expect(workflows[0]["disabled_by_ref"]).toMatchObject({ recordId: "CUTOVER-REC-SIM-001", revision: 1 });

    // Đã completed thì không hoàn tất lần nữa.
    await expect(
      completeCutover(db, cmd("complete-again"), {
        recordId: "CUTOVER-REC-SIM-001",
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({ code: "ERR-STATE" });
  });

  it("SQR-003: replay projection từ event log cho kết quả byte-identical", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
