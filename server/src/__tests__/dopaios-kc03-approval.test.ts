import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand, replayProjections, snapshotProjections } from "../dopaios/event-store.ts";

// KC-03 B1: schema 0507 + projector — bốn bảng approval engine mới và các cột
// mở rộng dựng được thuần từ event log, replay byte-identical (SQR-003),
// TRƯỚC khi tầng lệnh với guard (B2) vào. Đây là bài kiểm nền, chưa kiểm luật.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-03 B1 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "d".repeat(64);

describeEmbeddedPostgres("dopaios KC-03 B1 — schema 0507 + projector", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc03-b1-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("projects every new KC-03 event type from the log", async () => {
    await executeCommand(db, {
      commandId: "KC03-B1-SEED",
      payload: { batch: "B1" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosSeparationPolicy-SEP-DOC",
          type: "SeparationPolicyPinned",
          data: {
            policyId: "SEP-DOC",
            artifactType: "governance-doc",
            revision: 1,
            policy: {
              policy_id: "SEP-DOC",
              scope_level: "company",
              approver_capability: "governance-approver",
              effective_at: "2026-07-31T00:00:00Z",
              invalidation_rule: "revision-superseded",
            },
            pinnedBy: "CTO",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosArtifact-ART-B1",
          type: "ArtifactRegistered",
          data: {
            artifactId: "ART-B1",
            revision: 1,
            sha256: SHA,
            artifactState: "in-review",
            impactStatus: "clear",
            createdBy: "STAFF-AUTHOR",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosDecisionPackage-PKG-B1",
          type: "DecisionPackageAssembled",
          data: {
            packageId: "PKG-B1",
            revision: 1,
            refs: { evidence: "ev-1" },
            target: { artifactId: "ART-B1", revision: 1, sha256: SHA },
            fields: { decisionAsk: "Duyệt ART-B1 rev 1?", openFindings: [] },
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosDecisionPackage-PKG-B1",
          type: "DecisionPackageRevisionStateChanged",
          data: { packageId: "PKG-B1", revision: 1, state: "DECIDED" },
        });
        await ctx.emit({
          streamName: "dopaiosApproval-REC-B1",
          type: "ApprovalRecorded",
          data: {
            recordId: "REC-B1",
            packageId: "PKG-B1",
            packageRevision: 1,
            outcome: "approve-with-conditions",
            pinnedRefs: { evidence: "ev-1" },
            actor: "STAFF-APPROVER",
            targetId: "ART-B1",
            targetRevision: 1,
            targetSha256: SHA,
            approvedScope: { kind: "full-revision" },
            findings: [],
            nonWaivableBlockers: [],
            impactSet: [],
            downstreamChecked: [],
            openedStep: "B1",
            reEntryPoint: "B0",
            expiry: { rule: "target-change" },
            requestedBy: "STAFF-AUTHOR",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosCondition-CND-B1",
          type: "ConditionOpened",
          data: {
            conditionId: "CND-B1",
            recordId: "REC-B1",
            scope: { section: "phu-luc-A" },
            risk: "thieu vi du",
            owner: "STAFF-AUTHOR",
            deadline: "2026-08-15T00:00:00Z",
            closureCriteria: "bo sung vi du va duoc owner xac nhan",
            blocksNextStep: false,
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosGateRecord-GATE-B1",
          type: "GateRecordCreated",
          data: {
            gateRecordId: "GATE-B1",
            gateName: "Cổng A",
            pointId: "B0-12",
            runId: "RUN-KC03",
            approvalRecordId: "REC-B1",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosImpact-IMP-B1",
          type: "ImpactRecordOpened",
          data: {
            impactId: "IMP-B1",
            artifactId: "ART-B1",
            artifactRevision: 1,
            source: "condition-overdue",
            sourceRef: "CND-B1",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosImpact-IMP-B1",
          type: "ImpactRecordDispositioned",
          data: {
            impactId: "IMP-B1",
            conclusion: "keep-value",
            dispositionedBy: "STAFF-APPROVER",
            basis: "vi du da bo sung truoc han",
          },
        });
        await ctx.emit({
          streamName: "dopaiosCondition-CND-B1",
          type: "ConditionClosed",
          data: {
            conditionId: "CND-B1",
            closedBy: "STAFF-APPROVER",
            closureEvidence: "commit abc123 bo sung phu luc",
          },
        });
        return { seeded: true };
      },
    });

    const policy = (await db.execute(
      sql`SELECT artifact_type, revision, pinned_by FROM dopaios_separation_policies WHERE id = 'SEP-DOC'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(policy[0]).toEqual({ artifact_type: "governance-doc", revision: 1, pinned_by: "CTO" });

    const artifact = (await db.execute(
      sql`SELECT artifact_state, created_by FROM dopaios_artifacts WHERE id = 'ART-B1' AND revision = 1`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(artifact[0]).toEqual({ artifact_state: "in-review", created_by: "STAFF-AUTHOR" });

    const pkg = (await db.execute(
      sql`SELECT state, target->>'artifactId' AS t FROM dopaios_decision_packages WHERE id = 'PKG-B1' AND revision = 1`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(pkg[0]).toEqual({ state: "DECIDED", t: "ART-B1" });

    const record = (await db.execute(
      sql`SELECT outcome, target_id, target_revision, requested_by, re_entry_point
          FROM dopaios_approval_records WHERE id = 'REC-B1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(record[0]).toEqual({
      outcome: "approve-with-conditions",
      target_id: "ART-B1",
      target_revision: 1,
      requested_by: "STAFF-AUTHOR",
      re_entry_point: "B0",
    });

    const condition = (await db.execute(
      sql`SELECT state, closed_by, closure_evidence FROM dopaios_conditions WHERE id = 'CND-B1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(condition[0]).toEqual({
      state: "closed",
      closed_by: "STAFF-APPROVER",
      closure_evidence: "commit abc123 bo sung phu luc",
    });

    const gate = (await db.execute(
      sql`SELECT gate_name, point_id, approval_record_id FROM dopaios_gate_records WHERE id = 'GATE-B1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(gate[0]).toEqual({ gate_name: "Cổng A", point_id: "B0-12", approval_record_id: "REC-B1" });

    const impact = (await db.execute(
      sql`SELECT state, conclusion, dispositioned_by FROM dopaios_impact_records WHERE id = 'IMP-B1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(impact[0]).toEqual({
      state: "dispositioned",
      conclusion: "keep-value",
      dispositioned_by: "STAFF-APPROVER",
    });
  });

  it("replay rebuilds all KC-03 projections byte-identically", async () => {
    const before = await snapshotProjections(db);
    expect(before["dopaios_separation_policies"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_conditions"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_impact_records"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_gate_records"]!.length).toBeGreaterThan(0);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
