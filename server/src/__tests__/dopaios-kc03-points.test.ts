import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import { registerActor, registerApprovedArtifact, createProjectShell, pinProductBaseline } from "../dopaios/commands.ts";
import {
  assembleDecisionPackage,
  createGateRecord,
  pinSeparationPolicy,
  recordApprovalDecision,
  registerDraftArtifact,
  submitArtifactForReview,
  type RecordApprovalPayload,
} from "../dopaios/approval.ts";

// KC-03 B4: 14 điểm phê duyệt theo fixture FX-03 (AC-FR-24.3 + P0-01 theo
// AC-FR-24.2), tự dựng guard production trên fork — đúng ranh ASM-001 (không
// suy từ run test). Chỉ ba Cổng B0-12/B1-08/B2-06 có Gate Record (SFR-035);
// P0-01 là hành động trực tiếp có kiểm quyền, không có Gói quyết định;
// P1-10 nối vào pinProductBaseline (ca chặn B08); INPUT-DISPOSITION là
// approve theo vùng trên loại có schema region.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-03 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "f".repeat(64);
let seq = 0;
const cmd = (label: string) => `KC03-B4-${label}-${(seq += 1)}`;

// 13 điểm dạng Gói quyết định của FX-03 (P0-01 xử riêng — direct action).
// re_entry lấy từ when_not_approved của fixture.
const PACKAGE_POINTS: Array<{
  pointId: string;
  reEntry: string;
  gateName?: string;
  regionScoped?: boolean;
}> = [
  { pointId: "P0-05", reEntry: "P0-01" },
  { pointId: "P1-10", reEntry: "P1-dau-tien-sai" },
  { pointId: "INPUT-DISPOSITION", reEntry: "region-reviewing", regionScoped: true },
  { pointId: "PILOT-CUTOVER", reEntry: "bootstrap" },
  { pointId: "B0-12", reEntry: "B0", gateName: "Cổng A" },
  { pointId: "B1-08", reEntry: "B1", gateName: "Cổng B" },
  { pointId: "B2-06", reEntry: "B2", gateName: "Cổng C" },
  { pointId: "B3-04", reEntry: "B3-01" },
  { pointId: "R-03", reEntry: "artifact-dau-tien-sai" },
  { pointId: "ROLLBACK-CONDITIONAL", reEntry: "giu-chan-bao-toan-evidence" },
  { pointId: "T-03", reEntry: "T-01" },
  { pointId: "P3-06", reEntry: "P3" },
  { pointId: "P4-03", reEntry: "P4-01" },
];

const artifactIdOf = (pointId: string) => `ART-${pointId}`;

describeEmbeddedPostgres("dopaios KC-03 B4 — 14 điểm phê duyệt FX-03", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function decision(overrides: Partial<RecordApprovalPayload> & Pick<RecordApprovalPayload, "recordId" | "packageId" | "target" | "actor">): RecordApprovalPayload {
    return {
      packageRevision: 1,
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs: { evidence: `ev-${overrides.target.artifactId}` },
      ...overrides,
    };
  }

  async function stagePoint(point: { pointId: string; regionScoped?: boolean }): Promise<void> {
    const artifactId = artifactIdOf(point.pointId);
    await registerDraftArtifact(db, cmd("reg"), {
      artifactId,
      revision: 1,
      sha256: SHA,
      createdBy: "AI-LEAD",
      artifactType: point.regionScoped ? "input-source" : "sop-point-artifact",
      hasRegionSchema: point.regionScoped ?? false,
    });
    await submitArtifactForReview(db, cmd("sub"), { artifactId, revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: `PKG-${point.pointId}`,
      revision: 1,
      target: { artifactId, revision: 1, sha256: SHA },
      refs: { evidence: `ev-${artifactId}` },
      fields: { pointId: point.pointId, decisionAsk: `Quyết định tại ${point.pointId}?` },
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc03-b4-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("lead"), {
      actorId: "AI-LEAD", kind: "ai", active: true, capabilities: ["product-governance"],
    });
    await registerActor(db, cmd("orch"), {
      actorId: "ORCHESTRATOR", kind: "human", active: true,
      capabilities: ["governance-approver", "project-creator", "orchestrator"],
    });
    await registerActor(db, cmd("junior"), {
      actorId: "JUNIOR", kind: "human", active: true, capabilities: [],
    });
    for (const [policyId, artifactType] of [
      ["SEP-POINT", "sop-point-artifact"],
      ["SEP-INPUT", "input-source"],
    ] as const) {
      await pinSeparationPolicy(db, cmd("pol"), {
        policyId, artifactType, revision: 1,
        policy: {
          policy_id: policyId, scope_level: "company",
          approver_capability: "governance-approver",
          effective_at: "2026-07-31T00:00:00Z", invalidation_rule: "revision-superseded",
        },
        pinnedBy: "ORCHESTRATOR",
      });
    }
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("13 điểm dạng Gói quyết định chạy trọn approve với record đủ trường; INPUT-DISPOSITION theo vùng giữ in-review", async () => {
    for (const point of PACKAGE_POINTS) {
      await stagePoint(point);
      const payload = decision({
        recordId: `REC-${point.pointId}`,
        packageId: `PKG-${point.pointId}`,
        target: { artifactId: artifactIdOf(point.pointId), revision: 1, sha256: SHA },
        actor: "ORCHESTRATOR",
        openedStep: point.pointId,
        reEntryPoint: point.reEntry,
        ...(point.regionScoped
          ? {
              outcome: "approve-with-conditions" as const,
              approvedScope: { kind: "regions" as const, regions: ["region-accepted-1"] },
              conditions: [{
                conditionId: `CND-${point.pointId}`, scope: { region: "region-accepted-1" },
                risk: "vung con lai chua duyet", owner: "AI-LEAD",
                deadline: "2027-01-01T00:00:00Z",
                closureCriteria: "cac vung con lai co disposition", blocksNextStep: false,
              }],
            }
          : {}),
      });
      const result = await recordApprovalDecision(db, cmd(`ok-${point.pointId}`), payload);
      expect(result, point.pointId).toMatchObject({
        artifactState: point.regionScoped ? "in-review" : "approved",
      });
    }
    const records = (await db.execute(sql`
      SELECT id, opened_step, re_entry_point FROM dopaios_approval_records
      WHERE id LIKE 'REC-%' ORDER BY id
    `)) as unknown as Array<{ id: string; opened_step: string; re_entry_point: string }>;
    expect(records.length).toBe(PACKAGE_POINTS.length);
    for (const point of PACKAGE_POINTS) {
      const record = records.find((r) => r.id === `REC-${point.pointId}`);
      expect(record, point.pointId).toMatchObject({
        opened_step: point.pointId,
        re_entry_point: point.reEntry,
      });
    }
  });

  it("chỉ ba Cổng A/B/C có Gate Record — điểm khác bị chặn kèm audit (SFR-035)", async () => {
    for (const point of PACKAGE_POINTS.filter((p) => p.gateName)) {
      await createGateRecord(db, cmd(`gate-${point.pointId}`), {
        gateRecordId: `GATE-${point.pointId}`,
        gateName: point.gateName!,
        pointId: point.pointId,
        runId: "RUN-B4",
        approvalRecordId: `REC-${point.pointId}`,
      });
    }
    for (const pointId of ["P0-05", "B3-04"]) {
      await expect(
        createGateRecord(db, cmd(`gate-bad-${pointId}`), {
          gateRecordId: `GATE-BAD-${pointId}`,
          gateName: pointId,
          pointId,
          approvalRecordId: `REC-${pointId}`,
        }),
      ).rejects.toMatchObject({ code: "SFR-035" });
    }
    const gates = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_gate_records`,
    )) as unknown as Array<{ n: number }>;
    expect(gates[0].n).toBe(3);
  });

  it("P0-01 là hành động trực tiếp của Orchestrator: kiểm quyền trước khi ghi, không có Gói quyết định", async () => {
    await registerApprovedArtifact(db, cmd("tpl"), { artifactId: "TPL-B4", revision: 1, sha256: SHA });
    await expect(
      createProjectShell(db, cmd("p001-bad"), {
        projectId: "PROJ-B4-BAD",
        actor: "JUNIOR",
        templateRef: { template_id: "TPL-B4", revision: 1, sha256: SHA },
        expectedTemplateSha256: SHA,
        orchestrator: "ORCHESTRATOR",
      }),
    ).rejects.toMatchObject({ name: "CommandRejectedError" });
    const created = await createProjectShell(db, cmd("p001-ok"), {
      projectId: "PROJ-B4",
      actor: "ORCHESTRATOR",
      templateRef: { template_id: "TPL-B4", revision: 1, sha256: SHA },
      expectedTemplateSha256: SHA,
      orchestrator: "ORCHESTRATOR",
    });
    expect(created).toMatchObject({ state: "PREPARING" });
    const packages = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_decision_packages WHERE id LIKE '%PROJ-B4%'`,
    )) as unknown as Array<{ n: number }>;
    expect(packages[0].n).toBe(0);
  });

  it("P1-10: Product Baseline chỉ pin được từ artifact đã duyệt đúng hash (ca chặn B08)", async () => {
    await registerDraftArtifact(db, cmd("prd"), {
      artifactId: "ART-PRD-B4", revision: 1, sha256: SHA,
      createdBy: "AI-LEAD", artifactType: "sop-point-artifact", hasRegionSchema: false,
    });
    // Chưa duyệt → baseline không có hiệu lực, bị chặn.
    await expect(
      pinProductBaseline(db, cmd("pin-bad"), {
        baselineId: "BASE-B4", revision: 1, pinnedBy: "ORCHESTRATOR",
        items: [{ artifactId: "ART-PRD-B4", revision: 1, sha256: SHA }],
      }),
    ).rejects.toMatchObject({ code: "ERR-BASELINE-ITEM" });
    await submitArtifactForReview(db, cmd("prd-sub"), { artifactId: "ART-PRD-B4", revision: 1 });
    await assembleDecisionPackage(db, cmd("prd-pkg"), {
      packageId: "PKG-PRD-B4", revision: 1,
      target: { artifactId: "ART-PRD-B4", revision: 1, sha256: SHA },
      refs: { evidence: "ev-prd-b4" }, fields: { pointId: "P1-10" },
    });
    await recordApprovalDecision(db, cmd("prd-ok"), decision({
      recordId: "REC-PRD-B4", packageId: "PKG-PRD-B4",
      target: { artifactId: "ART-PRD-B4", revision: 1, sha256: SHA },
      actor: "ORCHESTRATOR",
      pinnedRefs: { evidence: "ev-prd-b4" },
      openedStep: "P1-10", reEntryPoint: "P1-dau-tien-sai",
    }));
    const pinned = await pinProductBaseline(db, cmd("pin-ok"), {
      baselineId: "BASE-B4", revision: 1, pinnedBy: "ORCHESTRATOR",
      items: [{ artifactId: "ART-PRD-B4", revision: 1, sha256: SHA }],
    });
    expect(pinned).toMatchObject({ itemCount: 1 });
  });

  it("reject ghi điểm tái nhập (SOP d.908); request-more-information luôn khả dụng", async () => {
    await stagePoint({ pointId: "P0-05-REJ" });
    const rejected = await recordApprovalDecision(db, cmd("rej"), decision({
      recordId: "REC-P0-05-REJ", packageId: "PKG-P0-05-REJ",
      target: { artifactId: "ART-P0-05-REJ", revision: 1, sha256: SHA },
      actor: "ORCHESTRATOR",
      outcome: "reject",
      openedStep: "P0-05", reEntryPoint: "P0-01",
    }));
    expect(rejected).toMatchObject({ outcome: "reject", artifactState: "draft" });
    const record = (await db.execute(
      sql`SELECT re_entry_point FROM dopaios_approval_records WHERE id = 'REC-P0-05-REJ'`,
    )) as unknown as Array<{ re_entry_point: string }>;
    expect(record[0].re_entry_point).toBe("P0-01");

    await stagePoint({ pointId: "R-03-RMI" });
    const rmi = await recordApprovalDecision(db, cmd("rmi"), decision({
      recordId: "REC-R-03-RMI", packageId: "PKG-R-03-RMI",
      target: { artifactId: "ART-R-03-RMI", revision: 1, sha256: SHA },
      actor: "ORCHESTRATOR",
      outcome: "request-more-information",
      openedStep: "R-03", reEntryPoint: "artifact-dau-tien-sai",
    }));
    expect(rmi).toMatchObject({ outcome: "request-more-information", artifactState: "in-review" });
  });

  it("replay dựng lại toàn bộ 14 điểm byte-identical", async () => {
    const before = await snapshotProjections(db);
    expect(before["dopaios_approval_records"]!.length).toBeGreaterThanOrEqual(15);
    expect(before["dopaios_gate_records"]!.length).toBe(3);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
