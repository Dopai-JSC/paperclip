import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand, replayProjections, snapshotProjections } from "../dopaios/event-store.ts";

// KC-14 B1: schema 0512 + projector — hai bảng mới (Hợp đồng chất lượng,
// bước của run) và các cột hai-vòng-đời trên phiên bản đầu ra / work-item /
// approval record / yêu cầu dựng được thuần từ event log, replay
// byte-identical (SQR-003), TRƯỚC khi tầng lệnh với guard (B2+) vào.
// Bài kiểm nền, chưa kiểm luật transition.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-14 B1 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

describeEmbeddedPostgres("dopaios KC-14 B1 — schema 0512 + projector", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc14-b1-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("projects every new KC-14 event type from the log", async () => {
    await executeCommand(db, {
      commandId: "KC14-B1-SEED",
      payload: { batch: "B1" },
      handler: async (ctx) => {
        // Hợp đồng chất lượng: nội dung theo (id, revision).
        await ctx.emit({
          streamName: "dopaiosQualityContract-QC-CODE",
          type: "QualityContractRegistered",
          data: {
            contractId: "QC-CODE",
            revision: 1,
            outputType: "code-change",
            requiredChecks: ["self-check", "independent-review"],
            sha256: SHA,
            registeredBy: "ORCH-1",
          },
          expectedVersion: -1,
        });
        // Phiên bản đầu ra rev2 mang pin hợp đồng + quan hệ thay thế rev1.
        await ctx.emit({
          streamName: "dopaiosOutput-OUT-KC14-1",
          type: "OutputVersionRecorded",
          data: {
            outputId: "OUT-KC14-1",
            revision: 2,
            workItemId: "WI-KC14-1",
            state: "SUBMITTED",
            contentSha256: SHA2,
            qualityContractRef: { id: "QC-CODE", revision: 1, sha256: SHA },
            replacesRevision: 1,
          },
          expectedVersion: -1,
        });
        // Hai bằng chứng kiểm gắn tuần tự — merge jsonb theo thứ tự log.
        await ctx.emit({
          streamName: "dopaiosOutput-OUT-KC14-1",
          type: "OutputVersionCheckEvidenceAdded",
          data: {
            outputId: "OUT-KC14-1",
            revision: 2,
            checkKey: "self-check",
            evidence: { ref: "SC-1", sha256: SHA, by: "AI-STAFF-BUILD" },
          },
        });
        await ctx.emit({
          streamName: "dopaiosOutput-OUT-KC14-1",
          type: "OutputVersionCheckEvidenceAdded",
          data: {
            outputId: "OUT-KC14-1",
            revision: 2,
            checkKey: "independent-review",
            evidence: { ref: "RE-1", sha256: SHA2, by: "AI-STAFF-REV" },
          },
        });
        // Work-item rework mang liên kết bản trước (SFR-022).
        await ctx.emit({
          streamName: "dopaiosWorkItem-WI-KC14-RW",
          type: "WorkItemCreated",
          data: {
            workItemId: "WI-KC14-RW",
            runId: "RUN-KC14-1",
            state: "PROPOSED",
            reworkOfWorkItemId: "WI-KC14-1",
            reworkOfOutputRef: { outputId: "OUT-KC14-1", revision: 1 },
          },
          expectedVersion: -1,
        });
        // Approval + vô hiệu (SFR-031/034): lifecycle không đổi, record mang
        // invalidated_at/invalidation_reason.
        await ctx.emit({
          streamName: "dopaiosApprovalRecord-AR-KC14-1",
          type: "ApprovalRecorded",
          data: {
            recordId: "AR-KC14-1",
            packageId: "PKG-KC14-1",
            packageRevision: 1,
            outcome: "approve",
            pinnedRefs: { output: { id: "OUT-KC14-1", revision: 1, sha256: SHA } },
            actor: "DECIDER-1",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosApprovalRecord-AR-KC14-1",
          type: "ApprovalInvalidated",
          data: { recordId: "AR-KC14-1", reason: "target-changed: OUT-KC14-1@2 vào trục (SFR-031)" },
        });
        // Yêu cầu liên kết gói vô hiệu → SUPERSEDED-TARGET-CHANGED (DEV-009).
        await ctx.emit({
          streamName: "dopaiosActionRequest-REQ-KC14-1",
          type: "ActionRequestCreated",
          data: { requestId: "REQ-KC14-1", kind: "decision", runId: "RUN-KC14-1" },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosActionRequest-REQ-KC14-1",
          type: "ActionRequestInvalidated",
          data: {
            requestId: "REQ-KC14-1",
            invalidation: { reason: "target-changed", sourceEvent: "OUT-KC14-1@2" },
          },
        });
        // Bước mở theo approval rồi bị tái chặn (SFR-029/050), rồi mở lại.
        await ctx.emit({
          streamName: "dopaiosRunStep-RUN-KC14-1-T3",
          type: "RunStepOpened",
          data: { runId: "RUN-KC14-1", stepId: "T3", recordId: "AR-KC14-1" },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosRunStep-RUN-KC14-1-T3",
          type: "RunStepReblocked",
          data: { runId: "RUN-KC14-1", stepId: "T3" },
        });
        await ctx.emit({
          streamName: "dopaiosRunStep-RUN-KC14-1-T3",
          type: "RunStepOpened",
          data: { runId: "RUN-KC14-1", stepId: "T3", recordId: "AR-KC14-2" },
        });
        return { seeded: true };
      },
    });

    const contracts = (await db.execute(
      sql`SELECT id, revision, output_type, required_checks, sha256 FROM dopaios_quality_contracts`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(contracts).toEqual([
      {
        id: "QC-CODE",
        revision: 1,
        output_type: "code-change",
        required_checks: ["self-check", "independent-review"],
        sha256: SHA,
      },
    ]);

    const outputs = (await db.execute(
      sql`SELECT id, revision, state, quality_contract_ref, check_evidence, replaces_revision
          FROM dopaios_output_versions WHERE id = 'OUT-KC14-1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(outputs).toEqual([
      {
        id: "OUT-KC14-1",
        revision: 2,
        state: "SUBMITTED",
        quality_contract_ref: { id: "QC-CODE", revision: 1, sha256: SHA },
        check_evidence: {
          "self-check": { ref: "SC-1", sha256: SHA, by: "AI-STAFF-BUILD" },
          "independent-review": { ref: "RE-1", sha256: SHA2, by: "AI-STAFF-REV" },
        },
        replaces_revision: 1,
      },
    ]);

    const rework = (await db.execute(
      sql`SELECT id, state, rework_of_work_item_id, rework_of_output_ref
          FROM dopaios_work_items WHERE id = 'WI-KC14-RW'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rework).toEqual([
      {
        id: "WI-KC14-RW",
        state: "PROPOSED",
        rework_of_work_item_id: "WI-KC14-1",
        rework_of_output_ref: { outputId: "OUT-KC14-1", revision: 1 },
      },
    ]);

    const records = (await db.execute(
      sql`SELECT id, outcome, (invalidated_at IS NOT NULL) AS invalidated, invalidation_reason
          FROM dopaios_approval_records WHERE id = 'AR-KC14-1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(records).toEqual([
      {
        id: "AR-KC14-1",
        outcome: "approve",
        invalidated: true,
        invalidation_reason: "target-changed: OUT-KC14-1@2 vào trục (SFR-031)",
      },
    ]);

    const requests = (await db.execute(
      sql`SELECT id, state, invalidation FROM dopaios_action_requests WHERE id = 'REQ-KC14-1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(requests).toEqual([
      {
        id: "REQ-KC14-1",
        state: "SUPERSEDED-TARGET-CHANGED",
        invalidation: { reason: "target-changed", sourceEvent: "OUT-KC14-1@2" },
      },
    ]);

    const steps = (await db.execute(
      sql`SELECT run_id, step_id, state, opened_by_record_id FROM dopaios_run_steps`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(steps).toEqual([
      { run_id: "RUN-KC14-1", step_id: "T3", state: "open", opened_by_record_id: "AR-KC14-2" },
    ]);
  });

  it("keeps KC-01 shaped events projecting with null KC-14 columns", async () => {
    await executeCommand(db, {
      commandId: "KC14-B1-OLD-SHAPE",
      payload: { batch: "B1" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosOutput-OUT-KC14-OLD",
          type: "OutputVersionRecorded",
          data: {
            outputId: "OUT-KC14-OLD",
            revision: 1,
            workItemId: "WI-KC14-1",
            state: "SELF_CHECK",
            contentSha256: SHA,
          },
          expectedVersion: -1,
        });
        return { seeded: true };
      },
    });

    const rows = (await db.execute(
      sql`SELECT id, revision, state, quality_contract_ref, check_evidence, replaces_revision
          FROM dopaios_output_versions WHERE id = 'OUT-KC14-OLD'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      {
        id: "OUT-KC14-OLD",
        revision: 1,
        state: "SELF_CHECK",
        quality_contract_ref: null,
        check_evidence: null,
        replaces_revision: null,
      },
    ]);
  });

  it("replay rebuilds KC-14 projections byte-identical (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
    expect(Object.keys(after)).toContain("dopaios_quality_contracts");
    expect(Object.keys(after)).toContain("dopaios_run_steps");
  });
});
