import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import { registerActor, registerApprovedArtifact, createProjectShell } from "../dopaios/commands.ts";
import {
  assembleDecisionPackage,
  createGateRecord,
  pinSeparationPolicy,
  recordApprovalDecision,
  registerDraftArtifact,
  submitArtifactForReview,
  type RecordApprovalPayload,
} from "../dopaios/approval.ts";

// KC-03 B2: tầng lệnh approval engine — bốn outcome, guard fail-closed
// SFR-013/014/021/022/025/026/027 + ERR-001…004, supersede nguyên tử
// (SFR-028 FS-002), gói quyết định revision/supersede (SFR-047), Gate Record
// chỉ A/B/C (SFR-035), và vệt audit bất biến cho lệnh bị chặn (SQR-001).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-03 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

let seq = 0;
const cmd = (label: string) => `KC03-B2-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-03 B2 — approval engine", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Đưa một artifact tới in-review kèm gói quyết định mở — đường chuẩn của
  // mọi ca kiểm.
  async function stageArtifact(input: {
    artifactId: string;
    sha: string;
    createdBy: string;
    artifactType?: string;
    hasRegionSchema?: boolean;
    revision?: number;
    packageId?: string;
  }): Promise<void> {
    const revision = input.revision ?? 1;
    await registerDraftArtifact(db, cmd("reg"), {
      artifactId: input.artifactId,
      revision,
      sha256: input.sha,
      createdBy: input.createdBy,
      artifactType: input.artifactType ?? "governance-doc",
      hasRegionSchema: input.hasRegionSchema ?? false,
    });
    await submitArtifactForReview(db, cmd("sub"), { artifactId: input.artifactId, revision });
    if (input.packageId) {
      await assembleDecisionPackage(db, cmd("pkg"), {
        packageId: input.packageId,
        revision: 1,
        target: { artifactId: input.artifactId, revision, sha256: input.sha },
        refs: { evidence: `ev-${input.artifactId}` },
        fields: { decisionAsk: `Duyệt ${input.artifactId}?` },
      });
    }
  }

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
      openedStep: "B1",
      reEntryPoint: "B0",
      ...overrides,
    };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc03-b2-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("actor"), {
      actorId: "STAFF-AUTHOR",
      kind: "human",
      active: true,
      capabilities: ["product-governance"],
    });
    await registerActor(db, cmd("actor"), {
      actorId: "STAFF-APPROVER",
      kind: "human",
      active: true,
      capabilities: ["governance-approver"],
    });
    // Điểm nóng kế hoạch: v1 CTO giữ ĐỒNG THỜI product-governance và
    // governance-approver.
    await registerActor(db, cmd("actor"), {
      actorId: "CTO",
      kind: "human",
      active: true,
      capabilities: ["product-governance", "governance-approver"],
    });
    await pinSeparationPolicy(db, cmd("pol"), {
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
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("approve đủ guard: approved + supersede nguyên tử revision cũ (SFR-028)", async () => {
    await stageArtifact({ artifactId: "ART-A", sha: SHA_A, createdBy: "STAFF-AUTHOR", packageId: "PKG-A1" });
    const first = await recordApprovalDecision(db, cmd("ok"), decision({
      recordId: "REC-A1",
      packageId: "PKG-A1",
      target: { artifactId: "ART-A", revision: 1, sha256: SHA_A },
      actor: "STAFF-APPROVER",
    }));
    expect(first).toMatchObject({ outcome: "approve", artifactState: "approved" });

    // Revision 2 được duyệt → revision 1 superseded trong CÙNG lệnh.
    await registerDraftArtifact(db, cmd("reg2"), {
      artifactId: "ART-A",
      revision: 2,
      sha256: SHA_B,
      createdBy: "STAFF-AUTHOR",
      artifactType: "governance-doc",
      hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("sub2"), { artifactId: "ART-A", revision: 2 });
    await assembleDecisionPackage(db, cmd("pkg2"), {
      packageId: "PKG-A2",
      revision: 1,
      target: { artifactId: "ART-A", revision: 2, sha256: SHA_B },
      refs: { evidence: "ev-ART-A-2" },
      fields: { decisionAsk: "Duyệt rev 2?" },
    });
    await recordApprovalDecision(db, cmd("ok2"), decision({
      recordId: "REC-A2",
      packageId: "PKG-A2",
      target: { artifactId: "ART-A", revision: 2, sha256: SHA_B },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-A-2" },
    }));
    const states = (await db.execute(
      sql`SELECT revision, artifact_state FROM dopaios_artifacts WHERE id = 'ART-A' ORDER BY revision`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(states).toEqual([
      { revision: 1, artifact_state: "superseded" },
      { revision: 2, artifact_state: "approved" },
    ]);
    const record = (await db.execute(
      sql`SELECT requested_by, target_sha256 FROM dopaios_approval_records WHERE id = 'REC-A2'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(record[0]).toEqual({ requested_by: "STAFF-AUTHOR", target_sha256: SHA_B });
  });

  it("điểm nóng: CTO hai capability bị chặn tự duyệt (SFR-013) nhưng duyệt việc người khác thì được", async () => {
    await stageArtifact({ artifactId: "ART-CTO", sha: SHA_A, createdBy: "CTO", packageId: "PKG-CTO" });
    await expect(
      recordApprovalDecision(db, cmd("self"), decision({
        recordId: "REC-SELF",
        packageId: "PKG-CTO",
        target: { artifactId: "ART-CTO", revision: 1, sha256: SHA_A },
        actor: "CTO",
      })),
    ).rejects.toMatchObject({ name: "CommandRejectedError", code: "SFR-013" });

    // Staff khác đủ capability duyệt được artifact của CTO (US5-AC1)…
    await recordApprovalDecision(db, cmd("other"), decision({
      recordId: "REC-CTO-OK",
      packageId: "PKG-CTO",
      target: { artifactId: "ART-CTO", revision: 1, sha256: SHA_A },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-CTO" },
    }));
    // …và CTO duyệt được artifact do NGƯỜI KHÁC tạo — nhiều capability không
    // phải là lý do chặn.
    await stageArtifact({ artifactId: "ART-B", sha: SHA_B, createdBy: "STAFF-AUTHOR", packageId: "PKG-B" });
    const byCto = await recordApprovalDecision(db, cmd("cto-ok"), decision({
      recordId: "REC-BY-CTO",
      packageId: "PKG-B",
      target: { artifactId: "ART-B", revision: 1, sha256: SHA_B },
      actor: "CTO",
      pinnedRefs: { evidence: "ev-ART-B" },
    }));
    expect(byCto).toMatchObject({ artifactState: "approved" });
  });

  it("SFR-014 fail-closed: thiếu policy hoặc policy thiếu trường chặn MỌI lệnh phê duyệt của loại", async () => {
    await stageArtifact({
      artifactId: "ART-NOPOL",
      sha: SHA_C,
      createdBy: "STAFF-AUTHOR",
      artifactType: "type-without-policy",
      packageId: "PKG-NOPOL",
    });
    await expect(
      recordApprovalDecision(db, cmd("nopol"), decision({
        recordId: "REC-NOPOL",
        packageId: "PKG-NOPOL",
        target: { artifactId: "ART-NOPOL", revision: 1, sha256: SHA_C },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-NOPOL" },
      })),
    ).rejects.toMatchObject({ code: "SFR-014" });

    await pinSeparationPolicy(db, cmd("halfpol"), {
      policyId: "SEP-HALF",
      artifactType: "type-half-policy",
      revision: 1,
      policy: { policy_id: "SEP-HALF", scope_level: "company" },
      pinnedBy: "CTO",
    });
    await stageArtifact({
      artifactId: "ART-HALF",
      sha: SHA_C,
      createdBy: "STAFF-AUTHOR",
      artifactType: "type-half-policy",
      packageId: "PKG-HALF",
    });
    await expect(
      recordApprovalDecision(db, cmd("half"), decision({
        recordId: "REC-HALF",
        packageId: "PKG-HALF",
        target: { artifactId: "ART-HALF", revision: 1, sha256: SHA_C },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-HALF" },
      })),
    ).rejects.toMatchObject({ code: "SFR-014" });
  });

  it("bốn luật outcome: blocker chặn approve/AWC, condition blocks_next_step chặn AWC, scope hụt chặn approve (ERR-004), condition thiếu trường chặn (SFR-033)", async () => {
    await stageArtifact({ artifactId: "ART-OUT", sha: SHA_A, createdBy: "STAFF-AUTHOR", packageId: "PKG-OUT" });
    const base = {
      packageId: "PKG-OUT",
      target: { artifactId: "ART-OUT", revision: 1, sha256: SHA_A },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-OUT" },
    } as const;
    await expect(
      recordApprovalDecision(db, cmd("blk"), decision({
        ...base, recordId: "REC-BLK",
        nonWaivableBlockers: [{ id: "BLK-1" }],
      })),
    ).rejects.toMatchObject({ code: "ERR-BLOCKER" });
    await expect(
      recordApprovalDecision(db, cmd("awcblk"), decision({
        ...base, recordId: "REC-AWC-BLK",
        outcome: "approve-with-conditions",
        nonWaivableBlockers: [{ id: "BLK-1" }],
        conditions: [{
          conditionId: "CND-X", scope: {}, risk: "r", owner: "STAFF-AUTHOR",
          deadline: "2026-08-15T00:00:00Z", closureCriteria: "c", blocksNextStep: false,
        }],
      })),
    ).rejects.toMatchObject({ code: "SFR-022" });
    await expect(
      recordApprovalDecision(db, cmd("awcstop"), decision({
        ...base, recordId: "REC-AWC-STOP",
        outcome: "approve-with-conditions",
        conditions: [{
          conditionId: "CND-STOP", scope: {}, risk: "r", owner: "STAFF-AUTHOR",
          deadline: "2026-08-15T00:00:00Z", closureCriteria: "c", blocksNextStep: true,
        }],
      })),
    ).rejects.toMatchObject({ code: "SFR-022" });
    await expect(
      recordApprovalDecision(db, cmd("scope"), decision({
        ...base, recordId: "REC-SCOPE",
        approvedScope: { kind: "regions", regions: ["muc-1"] },
      })),
    ).rejects.toMatchObject({ code: "ERR-004" });
    await expect(
      recordApprovalDecision(db, cmd("cnd-missing"), decision({
        ...base, recordId: "REC-CND-MISS",
        outcome: "approve-with-conditions",
        conditions: [{
          conditionId: "CND-MISS", scope: {}, risk: "r",
          deadline: "2026-08-15T00:00:00Z", closureCriteria: "c", blocksNextStep: false,
        } as never],
      })),
    ).rejects.toMatchObject({ code: "SFR-033" });
  });

  it("AWC hợp lệ: full-revision → approved + condition mở; theo vùng chỉ trên loại có schema region (SFR-024/025)", async () => {
    await stageArtifact({ artifactId: "ART-AWC", sha: SHA_B, createdBy: "STAFF-AUTHOR", packageId: "PKG-AWC" });
    const awc = await recordApprovalDecision(db, cmd("awc"), decision({
      recordId: "REC-AWC",
      packageId: "PKG-AWC",
      target: { artifactId: "ART-AWC", revision: 1, sha256: SHA_B },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-AWC" },
      outcome: "approve-with-conditions",
      conditions: [{
        conditionId: "CND-AWC", scope: { section: "phu-luc" }, risk: "vi du thieu",
        owner: "STAFF-AUTHOR", deadline: "2026-08-15T00:00:00Z",
        closureCriteria: "bo sung vi du", blocksNextStep: false,
      }],
    }));
    expect(awc).toMatchObject({ artifactState: "approved", conditionsOpened: 1 });
    const cnd = (await db.execute(
      sql`SELECT state, owner FROM dopaios_conditions WHERE id = 'CND-AWC'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(cnd[0]).toEqual({ state: "open", owner: "STAFF-AUTHOR" });

    // Theo vùng trên loại KHÔNG có schema region → SFR-025.
    await stageArtifact({ artifactId: "ART-NOREG", sha: SHA_C, createdBy: "STAFF-AUTHOR", packageId: "PKG-NOREG" });
    await expect(
      recordApprovalDecision(db, cmd("noreg"), decision({
        recordId: "REC-NOREG",
        packageId: "PKG-NOREG",
        target: { artifactId: "ART-NOREG", revision: 1, sha256: SHA_C },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-NOREG" },
        outcome: "approve-with-conditions",
        approvedScope: { kind: "regions", regions: ["muc-2"] },
        conditions: [{
          conditionId: "CND-NOREG", scope: {}, risk: "r", owner: "STAFF-AUTHOR",
          deadline: "2026-08-15T00:00:00Z", closureCriteria: "c", blocksNextStep: false,
        }],
      })),
    ).rejects.toMatchObject({ code: "SFR-025" });

    // Theo vùng trên loại CÓ schema region → hợp lệ, artifact GIỮ in-review.
    await stageArtifact({
      artifactId: "ART-REG", sha: SHA_A, createdBy: "STAFF-AUTHOR",
      hasRegionSchema: true, packageId: "PKG-REG",
    });
    const regional = await recordApprovalDecision(db, cmd("reg"), decision({
      recordId: "REC-REG",
      packageId: "PKG-REG",
      target: { artifactId: "ART-REG", revision: 1, sha256: SHA_A },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-REG" },
      outcome: "approve-with-conditions",
      approvedScope: { kind: "regions", regions: ["muc-3"] },
      conditions: [{
        conditionId: "CND-REG", scope: { region: "muc-3" }, risk: "r", owner: "STAFF-AUTHOR",
        deadline: "2026-08-15T00:00:00Z", closureCriteria: "c", blocksNextStep: false,
      }],
    }));
    expect(regional).toMatchObject({ artifactState: "in-review" });
  });

  it("reject về draft; RMI giữ in-review, gói AWAITING_INFO rồi revision mới supersede (SFR-047); gói cũ không nhận quyết định", async () => {
    await stageArtifact({ artifactId: "ART-RMI", sha: SHA_A, createdBy: "STAFF-AUTHOR", packageId: "PKG-RMI" });
    const rmi = await recordApprovalDecision(db, cmd("rmi"), decision({
      recordId: "REC-RMI",
      packageId: "PKG-RMI",
      target: { artifactId: "ART-RMI", revision: 1, sha256: SHA_A },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-RMI" },
      outcome: "request-more-information",
    }));
    expect(rmi).toMatchObject({ outcome: "request-more-information", artifactState: "in-review" });
    const pkgState = (await db.execute(
      sql`SELECT state FROM dopaios_decision_packages WHERE id = 'PKG-RMI' AND revision = 1`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(pkgState[0]).toEqual({ state: "AWAITING_INFO" });

    // Câu trả lời bổ sung → gói revision 2 supersede revision 1 + 1 Yêu cầu.
    await assembleDecisionPackage(db, cmd("rmi2"), {
      packageId: "PKG-RMI",
      revision: 2,
      target: { artifactId: "ART-RMI", revision: 1, sha256: SHA_A },
      refs: { evidence: "ev-ART-RMI-r2" },
      fields: { decisionAsk: "Duyệt sau bổ sung?" },
      requestId: "REQ-RMI-2",
    });
    const revs = (await db.execute(
      sql`SELECT revision, state FROM dopaios_decision_packages WHERE id = 'PKG-RMI' ORDER BY revision`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(revs).toEqual([
      { revision: 1, state: "SUPERSEDED" },
      { revision: 2, state: "OPEN" },
    ]);
    // Quyết định trên gói revision cũ bị chặn.
    await expect(
      recordApprovalDecision(db, cmd("old-pkg"), decision({
        recordId: "REC-OLD-PKG",
        packageId: "PKG-RMI",
        packageRevision: 1,
        target: { artifactId: "ART-RMI", revision: 1, sha256: SHA_A },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-RMI" },
      })),
    ).rejects.toMatchObject({ code: "SFR-047" });
    // Reject trên gói mới → artifact quay về draft, nội dung bất biến.
    const rejected = await recordApprovalDecision(db, cmd("rej"), decision({
      recordId: "REC-REJ",
      packageId: "PKG-RMI",
      packageRevision: 2,
      target: { artifactId: "ART-RMI", revision: 1, sha256: SHA_A },
      actor: "STAFF-APPROVER",
      pinnedRefs: { evidence: "ev-ART-RMI-r2" },
      outcome: "reject",
    }));
    expect(rejected).toMatchObject({ artifactState: "draft" });
  });

  it("guard nền: ERR-001 ngoài in-review, SFR-027 revision cũ, SFR-007 sai hash, ERR-002 thiếu trường, SFR-021 target Project", async () => {
    await registerDraftArtifact(db, cmd("draft"), {
      artifactId: "ART-DRAFT", revision: 1, sha256: SHA_A,
      createdBy: "STAFF-AUTHOR", artifactType: "governance-doc", hasRegionSchema: false,
    });
    await expect(
      recordApprovalDecision(db, cmd("e001"), decision({
        recordId: "REC-E001", packageId: "PKG-NONE",
        target: { artifactId: "ART-DRAFT", revision: 1, sha256: SHA_A },
        actor: "STAFF-APPROVER",
      })),
    ).rejects.toMatchObject({ code: "ERR-001" });

    await stageArtifact({ artifactId: "ART-OLDREV", sha: SHA_A, createdBy: "STAFF-AUTHOR", packageId: "PKG-OLDREV" });
    await registerDraftArtifact(db, cmd("newer"), {
      artifactId: "ART-OLDREV", revision: 2, sha256: SHA_B,
      createdBy: "STAFF-AUTHOR", artifactType: "governance-doc", hasRegionSchema: false,
    });
    await expect(
      recordApprovalDecision(db, cmd("oldrev"), decision({
        recordId: "REC-OLDREV", packageId: "PKG-OLDREV",
        target: { artifactId: "ART-OLDREV", revision: 1, sha256: SHA_A },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-OLDREV" },
      })),
    ).rejects.toMatchObject({ code: "SFR-027" });

    await stageArtifact({ artifactId: "ART-HASH", sha: SHA_A, createdBy: "STAFF-AUTHOR", packageId: "PKG-HASH" });
    await expect(
      recordApprovalDecision(db, cmd("hash"), decision({
        recordId: "REC-HASH", packageId: "PKG-HASH",
        target: { artifactId: "ART-HASH", revision: 1, sha256: SHA_C },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-HASH" },
      })),
    ).rejects.toMatchObject({ code: "SFR-007" });

    await expect(
      recordApprovalDecision(db, cmd("missing"), {
        recordId: "REC-MISSING", packageId: "PKG-HASH", packageRevision: 1,
        target: { artifactId: "ART-HASH", revision: 1, sha256: SHA_A },
        outcome: "approve", approvedScope: { kind: "full-revision" },
        nonWaivableBlockers: [], impactSet: [], downstreamChecked: [],
        pinnedRefs: { evidence: "ev-ART-HASH" }, actor: "STAFF-APPROVER",
      } as never),
    ).rejects.toMatchObject({ code: "ERR-002" });

    await registerApprovedArtifact(db, cmd("tpl"), { artifactId: "TPL-1", revision: 1, sha256: SHA_A });
    await registerActor(db, cmd("orch"), {
      actorId: "ORCH", kind: "human", active: true, capabilities: ["project-creator", "orchestrator"],
    });
    await createProjectShell(db, cmd("proj"), {
      projectId: "PROJ-1",
      actor: "ORCH",
      templateRef: { template_id: "TPL-1", revision: 1, sha256: SHA_A },
      expectedTemplateSha256: SHA_A,
      orchestrator: "ORCH",
    });
    await expect(
      recordApprovalDecision(db, cmd("proj-target"), decision({
        recordId: "REC-PROJ", packageId: "PKG-HASH",
        target: { artifactId: "PROJ-1", revision: 1, sha256: SHA_A },
        actor: "STAFF-APPROVER",
        pinnedRefs: { evidence: "ev-ART-HASH" },
      })),
    ).rejects.toMatchObject({ code: "SFR-021" });
  });

  it("lệnh bị chặn để lại vệt audit bất biến (SQR-001) và không để lại bản ghi dở dang (REC-001)", async () => {
    const audits = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE type = 'CommandRejected' AND stream_name LIKE 'dopaiosAudit-%'
    `)) as unknown as Array<{ n: number }>;
    expect(audits[0].n).toBeGreaterThan(0);
    // Không có approval record nào của các lệnh bị chặn.
    const strays = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_approval_records
      WHERE id IN ('REC-SELF','REC-NOPOL','REC-HALF','REC-BLK','REC-SCOPE','REC-E001','REC-OLDREV','REC-HASH','REC-PROJ')
    `)) as unknown as Array<{ n: number }>;
    expect(strays[0].n).toBe(0);
  });

  it("Gate Record chỉ cho Cổng A/B/C (SFR-035)", async () => {
    await createGateRecord(db, cmd("gate-a"), {
      gateRecordId: "GATE-A-1", gateName: "Cổng A", pointId: "B0-12",
      runId: "RUN-1", approvalRecordId: "REC-A2",
    });
    const gate = (await db.execute(
      sql`SELECT gate_name FROM dopaios_gate_records WHERE id = 'GATE-A-1'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(gate[0]).toEqual({ gate_name: "Cổng A" });
    await expect(
      createGateRecord(db, cmd("gate-bad"), {
        gateRecordId: "GATE-BAD", gateName: "P1-10", pointId: "P1-10",
        approvalRecordId: "REC-A2",
      }),
    ).rejects.toMatchObject({ code: "SFR-035" });
    await expect(
      createGateRecord(db, cmd("gate-mismatch"), {
        gateRecordId: "GATE-MIS", gateName: "Cổng A", pointId: "B1-08",
        approvalRecordId: "REC-A2",
      }),
    ).rejects.toMatchObject({ code: "SFR-035" });
  });

  it("replay dựng lại toàn bộ trạng thái approval engine byte-identical", async () => {
    const before = await snapshotProjections(db);
    expect(before["dopaios_approval_records"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_conditions"]!.length).toBeGreaterThan(0);
    expect(before["dopaios_gate_records"]!.length).toBeGreaterThan(0);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
