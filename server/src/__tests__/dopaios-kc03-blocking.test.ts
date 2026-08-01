import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import {
  registerActor,
  registerApprovedArtifact,
  createSopDefinition,
  publishSopDefinition,
  requestTestRun,
  activateSopRun,
  runFixtureExecution,
  reviewFixtureExecution,
  advanceToDecision,
  pinProductBaseline,
} from "../dopaios/commands.ts";
import {
  assembleDecisionPackage,
  createGateRecord,
  pinSeparationPolicy,
  recordApprovalDecision,
  recordReviewComment,
  registerDraftArtifact,
  submitArtifactForReview,
  type RecordApprovalPayload,
} from "../dopaios/approval.ts";
import { declareSourceChanged, dispositionImpact, isApprovalEffective } from "../dopaios/conditions.ts";

// KC-03 B5: 12 ca chặn FX-03-B01…B12 map TƯỜNG MINH — mỗi ca một `it` mang
// đúng case id của fixture, kỳ vọng đúng mã lỗi/hành vi fixture ghi.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-03 B5 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "9".repeat(64);
const SHA_OTHER = "8".repeat(64);
let seq = 0;
const cmd = (label: string) => `KC03-B5-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-03 B5 — 12 ca chặn FX-03", () => {
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

  async function stage(artifactId: string, opts?: { createdBy?: string; artifactType?: string }): Promise<void> {
    await registerDraftArtifact(db, cmd("reg"), {
      artifactId, revision: 1, sha256: SHA,
      createdBy: opts?.createdBy ?? "STAFF-AUTHOR",
      artifactType: opts?.artifactType ?? "governance-doc",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("sub"), { artifactId, revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: `PKG-${artifactId}`, revision: 1,
      target: { artifactId, revision: 1, sha256: SHA },
      refs: { evidence: `ev-${artifactId}` },
      fields: {},
    });
  }

  async function expectAudited(commandId: string): Promise<void> {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE stream_name = ${"dopaiosAudit-" + commandId} AND type = 'CommandRejected'
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n, `audit for ${commandId}`).toBe(1);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc03-b5-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("a1"), {
      actorId: "STAFF-AUTHOR", kind: "human", active: true, capabilities: ["product-governance"],
    });
    await registerActor(db, cmd("a2"), {
      actorId: "STAFF-APPROVER", kind: "human", active: true, capabilities: ["governance-approver"],
    });
    await registerActor(db, cmd("a3"), {
      actorId: "CTO", kind: "human", active: true,
      capabilities: ["product-governance", "governance-approver"],
    });
    await pinSeparationPolicy(db, cmd("pol"), {
      policyId: "SEP-DOC", artifactType: "governance-doc", revision: 1,
      policy: {
        policy_id: "SEP-DOC", scope_level: "company",
        approver_capability: "governance-approver",
        effective_at: "2026-07-31T00:00:00Z", invalidation_rule: "revision-superseded",
      },
      pinnedBy: "CTO",
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("FX-03-B01: tự duyệt — actor ghi quyết định chính là Staff tạo revision → chặn + audit (SFR-013)", async () => {
    // STAFF-APPROVER tự tạo rồi tự duyệt chính revision đó.
    await stage("ART-B01", { createdBy: "STAFF-APPROVER" });
    const commandId = cmd("b01");
    await expect(
      recordApprovalDecision(db, commandId, decision({
        recordId: "REC-B01", packageId: "PKG-ART-B01",
        target: { artifactId: "ART-B01", revision: 1, sha256: SHA },
        actor: "STAFF-APPROVER",
      })),
    ).rejects.toMatchObject({ code: "SFR-013" });
    await expectAudited(commandId);
  });

  it("FX-03-B02: separation rule chưa pin hoặc không hợp lệ → fail-closed chặn MỌI lệnh của loại (SFR-014)", async () => {
    await stage("ART-B02A", { artifactType: "type-b02-unpinned" });
    await expect(
      recordApprovalDecision(db, cmd("b02a"), decision({
        recordId: "REC-B02A", packageId: "PKG-ART-B02A",
        target: { artifactId: "ART-B02A", revision: 1, sha256: SHA },
        actor: "STAFF-APPROVER",
      })),
    ).rejects.toMatchObject({ code: "SFR-014" });

    await pinSeparationPolicy(db, cmd("badpol"), {
      policyId: "SEP-B02", artifactType: "type-b02-invalid", revision: 1,
      policy: { policy_id: "SEP-B02" },
      pinnedBy: "CTO",
    });
    await stage("ART-B02B", { artifactType: "type-b02-invalid" });
    await expect(
      recordApprovalDecision(db, cmd("b02b"), decision({
        recordId: "REC-B02B", packageId: "PKG-ART-B02B",
        target: { artifactId: "ART-B02B", revision: 1, sha256: SHA },
        actor: "STAFF-APPROVER",
      })),
    ).rejects.toMatchObject({ code: "SFR-014" });
  });

  it("FX-03-B03: một người nhiều capability — enforce theo Staff tạo revision, không theo capability", async () => {
    await stage("ART-B03-OWN", { createdBy: "CTO" });
    await expect(
      recordApprovalDecision(db, cmd("b03-own"), decision({
        recordId: "REC-B03-OWN", packageId: "PKG-ART-B03-OWN",
        target: { artifactId: "ART-B03-OWN", revision: 1, sha256: SHA },
        actor: "CTO",
      })),
    ).rejects.toMatchObject({ code: "SFR-013" });

    await stage("ART-B03-OTHER", { createdBy: "STAFF-AUTHOR" });
    const approved = await recordApprovalDecision(db, cmd("b03-other"), decision({
      recordId: "REC-B03-OTHER", packageId: "PKG-ART-B03-OTHER",
      target: { artifactId: "ART-B03-OTHER", revision: 1, sha256: SHA },
      actor: "CTO",
    }));
    expect(approved).toMatchObject({ artifactState: "approved" });
  });

  it("FX-03-B04: thiếu chuỗi review độc lập → chặn trình duyệt (AC-FR-24.2)", async () => {
    await registerApprovedArtifact(db, cmd("sop"), { artifactId: "SOP-B5", revision: 1, sha256: SHA });
    await createSopDefinition(db, cmd("def"), {
      definitionId: "DEF-B5", revision: 1,
      sopPin: { artifactId: "SOP-B5", revision: 1, sha256: SHA },
    });
    await publishSopDefinition(db, cmd("pub"), {
      definitionId: "DEF-B5", definitionContentSha256: SHA, expectedSopSha256: SHA,
    });
    await requestTestRun(db, cmd("run"), {
      runId: "RUN-B5", definitionRef: { definitionId: "DEF-B5", revision: 1 },
      decider: "STAFF-APPROVER", pod: "POD-B5", fixturePackage: {},
    });
    await activateSopRun(db, cmd("act"), { runId: "RUN-B5", workItemId: "WI-B5" });
    await runFixtureExecution(db, cmd("exec"), {
      workItemId: "WI-B5", executor: "AI-BUILD", outputId: "OUT-B5",
      outputRevision: 1, contentSha256: SHA,
    });
    // Output mới SELF_CHECK — trình duyệt khi chưa kiểm độc lập bị chặn.
    const blockedId = cmd("adv-blocked");
    await expect(
      advanceToDecision(db, blockedId, {
        runId: "RUN-B5", outputId: "OUT-B5", outputRevision: 1,
        packageId: "PKG-OUT-B5", packageRevision: 1,
        refs: { evidence: "ev-out-b5" }, requestId: "REQ-B5",
      }),
    ).rejects.toMatchObject({ code: "AC-FR-24.2" });
    await reviewFixtureExecution(db, cmd("review"), {
      workItemId: "WI-B5", outputId: "OUT-B5", outputRevision: 1,
      executor: "AI-BUILD", reviewer: "AI-REVIEWER",
    });
    const advanced = await advanceToDecision(db, cmd("adv-ok"), {
      runId: "RUN-B5", outputId: "OUT-B5", outputRevision: 1,
      packageId: "PKG-OUT-B5", packageRevision: 1,
      refs: { evidence: "ev-out-b5" }, requestId: "REQ-B5",
    });
    expect(advanced).toMatchObject({ requestState: "OPEN" });
  });

  it("FX-03-B05: approval sai target — hash khác pin hoặc package dựng cho target khác → chặn + audit (SFR-007)", async () => {
    await stage("ART-B05");
    await expect(
      recordApprovalDecision(db, cmd("b05-hash"), decision({
        recordId: "REC-B05", packageId: "PKG-ART-B05",
        target: { artifactId: "ART-B05", revision: 1, sha256: SHA_OTHER },
        actor: "STAFF-APPROVER",
      })),
    ).rejects.toMatchObject({ code: "SFR-007" });

    await stage("ART-B05-X");
    await expect(
      recordApprovalDecision(db, cmd("b05-target"), decision({
        recordId: "REC-B05-X",
        packageId: "PKG-ART-B05",
        target: { artifactId: "ART-B05-X", revision: 1, sha256: SHA },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-B05" },
      })),
    ).rejects.toMatchObject({ code: "ERR-PKG-TARGET" });
  });

  it("FX-03-B06: comment không thay approval — không record, không chuyển bước", async () => {
    await stage("ART-B06");
    await recordReviewComment(db, cmd("b06"), {
      artifactId: "ART-B06", revision: 1, author: "STAFF-APPROVER",
      comment: "nhìn ổn rồi đấy, ready đi",
    });
    const artifact = (await db.execute(
      sql`SELECT artifact_state FROM dopaios_artifacts WHERE id = 'ART-B06' AND revision = 1`,
    )) as unknown as Array<{ artifact_state: string }>;
    expect(artifact[0].artifact_state).toBe("in-review");
    const records = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_approval_records WHERE target_id = 'ART-B06'`,
    )) as unknown as Array<{ n: number }>;
    expect(records[0].n).toBe(0);
  });

  it("FX-03-B07: Gate Record ngoài A/B/C bị chặn + audit (SFR-035)", async () => {
    const commandId = cmd("b07");
    await expect(
      createGateRecord(db, commandId, {
        gateRecordId: "GATE-B07", gateName: "INPUT-DISPOSITION", pointId: "INPUT-DISPOSITION",
        approvalRecordId: "REC-B03-OTHER",
      }),
    ).rejects.toMatchObject({ code: "SFR-035" });
    await expectAudited(commandId);
  });

  it("FX-03-B08: Product Baseline thiếu approval hợp lệ không có hiệu lực", async () => {
    await registerDraftArtifact(db, cmd("b08"), {
      artifactId: "ART-B08", revision: 1, sha256: SHA,
      createdBy: "STAFF-AUTHOR", artifactType: "governance-doc", hasRegionSchema: false,
    });
    await expect(
      pinProductBaseline(db, cmd("b08-pin"), {
        baselineId: "BASE-B08", revision: 1, pinnedBy: "CTO",
        items: [{ artifactId: "ART-B08", revision: 1, sha256: SHA }],
      }),
    ).rejects.toMatchObject({ code: "ERR-BASELINE-ITEM" });
  });

  it("FX-03-B09: AWC với non-waivable blocker hoặc condition blocks_next_step → từ chối + audit (SFR-022)", async () => {
    await stage("ART-B09");
    const base = {
      packageId: "PKG-ART-B09",
      target: { artifactId: "ART-B09", revision: 1, sha256: SHA },
      actor: "STAFF-APPROVER",
      outcome: "approve-with-conditions" as const,
    };
    await expect(
      recordApprovalDecision(db, cmd("b09-blocker"), decision({
        ...base, recordId: "REC-B09A",
        nonWaivableBlockers: [{ id: "BLK" }],
        conditions: [{
          conditionId: "CND-B09A", scope: {}, risk: "r", owner: "STAFF-AUTHOR",
          deadline: "2027-01-01T00:00:00Z", closureCriteria: "c", blocksNextStep: false,
        }],
      })),
    ).rejects.toMatchObject({ code: "SFR-022" });
    await expect(
      recordApprovalDecision(db, cmd("b09-blocking-cond"), decision({
        ...base, recordId: "REC-B09B",
        conditions: [{
          conditionId: "CND-B09B", scope: {}, risk: "r", owner: "STAFF-AUTHOR",
          deadline: "2027-01-01T00:00:00Z", closureCriteria: "c", blocksNextStep: true,
        }],
      })),
    ).rejects.toMatchObject({ code: "SFR-022" });
  });

  it("FX-03-B10: approve scope không phủ toàn revision → từ chối kèm hướng dẫn (SFR-026)", async () => {
    await expect(
      recordApprovalDecision(db, cmd("b10"), decision({
        recordId: "REC-B10", packageId: "PKG-ART-B09",
        target: { artifactId: "ART-B09", revision: 1, sha256: SHA },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-B09" },
        approvedScope: { kind: "regions", regions: ["muc-1"] },
      })),
    ).rejects.toMatchObject({ code: "ERR-004" });
  });

  it("FX-03-B11: quyết định nhắm revision lịch sử → từ chối + audit (SFR-027)", async () => {
    await stage("ART-B11");
    await registerDraftArtifact(db, cmd("b11-r2"), {
      artifactId: "ART-B11", revision: 2, sha256: SHA_OTHER,
      createdBy: "STAFF-AUTHOR", artifactType: "governance-doc", hasRegionSchema: false,
    });
    const commandId = cmd("b11");
    await expect(
      recordApprovalDecision(db, commandId, decision({
        recordId: "REC-B11", packageId: "PKG-ART-B11",
        target: { artifactId: "ART-B11", revision: 1, sha256: SHA },
        actor: "STAFF-APPROVER",
      })),
    ).rejects.toMatchObject({ code: "SFR-027" });
    await expectAudited(commandId);
  });

  it("FX-03-B12: target đổi sau approval → hết hiệu lực theo impact set, impact_status theo luật gộp SFR-029", async () => {
    await stage("ART-B12");
    await recordApprovalDecision(db, cmd("b12-appr"), decision({
      recordId: "REC-B12", packageId: "PKG-ART-B12",
      target: { artifactId: "ART-B12", revision: 1, sha256: SHA },
      actor: "STAFF-APPROVER",
    }));
    expect(await isApprovalEffective(db, "REC-B12")).toBe(true);
    await declareSourceChanged(db, cmd("b12-change"), {
      impactId: "IMP-B12", artifactId: "ART-B12", artifactRevision: 1,
      sourceRef: "nguồn thượng nguồn đổi nghĩa",
    });
    expect(await isApprovalEffective(db, "REC-B12")).toBe(false);
    const mustFix = await dispositionImpact(db, cmd("b12-disp"), {
      impactId: "IMP-B12", conclusion: "must-fix", actor: "STAFF-APPROVER",
      basis: "đổi nghĩa chạm phạm vi đã duyệt",
    });
    expect(mustFix).toMatchObject({ impactStatus: "rework-required" });
    expect(await isApprovalEffective(db, "REC-B12")).toBe(false);
  });

  it("replay dựng lại toàn bộ trạng thái các ca chặn byte-identical", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
