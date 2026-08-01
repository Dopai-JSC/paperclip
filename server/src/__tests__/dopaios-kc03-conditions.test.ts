import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import { registerActor } from "../dopaios/commands.ts";
import {
  assembleDecisionPackage,
  pinSeparationPolicy,
  recordApprovalDecision,
  registerDraftArtifact,
  submitArtifactForReview,
} from "../dopaios/approval.ts";
import {
  closeCondition,
  decideException,
  declareSourceChanged,
  detectOverdueConditions,
  dispositionImpact,
  isApprovalEffective,
} from "../dopaios/conditions.ts";

// KC-03 B3: vòng đời condition/EXCEPTION và luật gộp impact — SFR-055 đóng
// kèm bằng chứng; SFR-016/034 quá hạn → mất hiệu lực + Gói EXCEPTION + một
// Yêu cầu; approve exception bắt buộc disposition cùng transaction; reject
// chấm dứt hiệu lực qua must-fix; SFR-029 chỉ rời impact-pending khi mọi
// record mở có disposition (ca chặn FX-03-B12 ở dạng nguồn-đổi).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-03 B3 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA = "e".repeat(64);
const NOW_MS = new Date("2026-09-01T00:00:00Z").getTime();
const PAST_DEADLINE = "2026-08-01T00:00:00Z";
const FUTURE_DEADLINE = "2027-01-01T00:00:00Z";

let seq = 0;
const cmd = (label: string) => `KC03-B3-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-03 B3 — condition/EXCEPTION/impact", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function approveWithCondition(input: {
    artifactId: string;
    conditionId: string;
    deadline: string;
    recordId: string;
  }): Promise<void> {
    await registerDraftArtifact(db, cmd("reg"), {
      artifactId: input.artifactId, revision: 1, sha256: SHA,
      createdBy: "STAFF-AUTHOR", artifactType: "governance-doc", hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("sub"), { artifactId: input.artifactId, revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: `PKG-${input.artifactId}`, revision: 1,
      target: { artifactId: input.artifactId, revision: 1, sha256: SHA },
      refs: { evidence: `ev-${input.artifactId}` },
      fields: { decisionAsk: "?" },
    });
    await recordApprovalDecision(db, cmd("awc"), {
      recordId: input.recordId,
      packageId: `PKG-${input.artifactId}`,
      packageRevision: 1,
      target: { artifactId: input.artifactId, revision: 1, sha256: SHA },
      outcome: "approve-with-conditions",
      approvedScope: { kind: "full-revision" },
      findings: [], nonWaivableBlockers: [], impactSet: [], downstreamChecked: [],
      conditions: [{
        conditionId: input.conditionId, scope: { section: "A" }, risk: "r",
        owner: "STAFF-AUTHOR", deadline: input.deadline,
        closureCriteria: "bo sung xong", blocksNextStep: false,
      }],
      pinnedRefs: { evidence: `ev-${input.artifactId}` },
      actor: "STAFF-APPROVER",
    });
  }

  async function impactStatus(artifactId: string): Promise<string> {
    const rows = (await db.execute(
      sql`SELECT impact_status FROM dopaios_artifacts WHERE id = ${artifactId} AND revision = 1`,
    )) as unknown as Array<{ impact_status: string }>;
    return rows[0]!.impact_status;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc03-b3-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("a1"), {
      actorId: "STAFF-AUTHOR", kind: "human", active: true, capabilities: ["product-governance"],
    });
    await registerActor(db, cmd("a2"), {
      actorId: "STAFF-APPROVER", kind: "human", active: true, capabilities: ["governance-approver"],
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

  it("SFR-055: đúng decider đóng condition kèm bằng chứng; sai người hoặc đóng lại bị chặn", async () => {
    await approveWithCondition({
      artifactId: "ART-CLOSE", conditionId: "CND-CLOSE",
      deadline: FUTURE_DEADLINE, recordId: "REC-CLOSE",
    });
    await expect(
      closeCondition(db, cmd("wrong"), {
        conditionId: "CND-CLOSE", actor: "STAFF-AUTHOR", closureEvidence: "x",
      }),
    ).rejects.toMatchObject({ code: "ERR-DECIDER" });
    await closeCondition(db, cmd("ok"), {
      conditionId: "CND-CLOSE", actor: "STAFF-APPROVER", closureEvidence: "commit abc — vi du da bo sung",
    });
    await expect(
      closeCondition(db, cmd("again"), {
        conditionId: "CND-CLOSE", actor: "STAFF-APPROVER", closureEvidence: "y",
      }),
    ).rejects.toMatchObject({ code: "ERR-CONDITION-STATE" });
    expect(await isApprovalEffective(db, "REC-CLOSE")).toBe(true);
  });

  it("SFR-016/034: quá hạn → overdue + impact-pending + Gói EXCEPTION + một Yêu cầu; tick lặp không bắn đôi", async () => {
    await approveWithCondition({
      artifactId: "ART-OVER", conditionId: "CND-OVER",
      deadline: PAST_DEADLINE, recordId: "REC-OVER",
    });
    expect(await isApprovalEffective(db, "REC-OVER")).toBe(true);
    const declared = await detectOverdueConditions(db, { nowMs: NOW_MS });
    expect(declared).toEqual([{ conditionId: "CND-OVER", exceptionPackageId: "EXC-CND-OVER" }]);
    expect(await impactStatus("ART-OVER")).toBe("impact-pending");
    expect(await isApprovalEffective(db, "REC-OVER")).toBe(false);

    const pkg = (await db.execute(
      sql`SELECT state, refs->>'kind' AS kind FROM dopaios_decision_packages WHERE id = 'EXC-CND-OVER'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(pkg[0]).toEqual({ state: "OPEN", kind: "EXCEPTION" });
    const request = (await db.execute(
      sql`SELECT kind, state FROM dopaios_action_requests WHERE id = 'REQ-EXC-CND-OVER'`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(request[0]).toEqual({ kind: "exception", state: "OPEN" });

    // Tick lặp: idempotent theo command id condition+deadline — không nhân đôi.
    await detectOverdueConditions(db, { nowMs: NOW_MS + 60_000 });
    const impacts = (await db.execute(
      sql`SELECT count(*)::int AS n FROM dopaios_impact_records WHERE artifact_id = 'ART-OVER'`,
    )) as unknown as Array<{ n: number }>;
    expect(impacts[0].n).toBe(1);
  });

  it("exception approve: bắt buộc disposition cùng transaction; đóng có căn cứ → reaffirmed, hiệu lực trở lại", async () => {
    await expect(
      decideException(db, cmd("nodisp"), {
        packageId: "EXC-CND-OVER", outcome: "approve", actor: "STAFF-APPROVER",
        conditionId: "CND-OVER",
      }),
    ).rejects.toMatchObject({ code: "SFR-034" });
    const decided = await decideException(db, cmd("appr"), {
      packageId: "EXC-CND-OVER", outcome: "approve", actor: "STAFF-APPROVER",
      conditionId: "CND-OVER",
      disposition: { kind: "close", basis: "nghia vu da hoan thanh ngoai bang" },
    });
    expect(decided).toMatchObject({ outcome: "approve", impactStatus: "reaffirmed" });
    expect(await impactStatus("ART-OVER")).toBe("reaffirmed");
    expect(await isApprovalEffective(db, "REC-OVER")).toBe(true);
    const condition = (await db.execute(
      sql`SELECT state FROM dopaios_conditions WHERE id = 'CND-OVER'`,
    )) as unknown as Array<{ state: string }>;
    expect(condition[0].state).toBe("closed");
  });

  it("exception approve bằng condition thay thế đủ trường (owner + hạn mới)", async () => {
    await approveWithCondition({
      artifactId: "ART-REPL", conditionId: "CND-REPL",
      deadline: PAST_DEADLINE, recordId: "REC-REPL",
    });
    await detectOverdueConditions(db, { nowMs: NOW_MS });
    const decided = await decideException(db, cmd("repl"), {
      packageId: "EXC-CND-REPL", outcome: "approve", actor: "STAFF-APPROVER",
      conditionId: "CND-REPL",
      disposition: {
        kind: "replace",
        condition: {
          conditionId: "CND-REPL-2", scope: { section: "A" }, risk: "r",
          owner: "STAFF-AUTHOR", deadline: FUTURE_DEADLINE,
          closureCriteria: "bo sung xong dot 2", blocksNextStep: false,
        },
      },
    });
    expect(decided).toMatchObject({ impactStatus: "reaffirmed" });
    const states = (await db.execute(
      sql`SELECT id, state FROM dopaios_conditions WHERE id IN ('CND-REPL','CND-REPL-2') ORDER BY id`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(states).toEqual([
      { id: "CND-REPL", state: "closed" },
      { id: "CND-REPL-2", state: "open" },
    ]);
    expect(await isApprovalEffective(db, "REC-REPL")).toBe(true);
  });

  it("exception reject: must-fix → rework-required, hiệu lực chấm dứt, phiên bản không viết lại lifecycle", async () => {
    await approveWithCondition({
      artifactId: "ART-REJ", conditionId: "CND-REJ",
      deadline: PAST_DEADLINE, recordId: "REC-REJ",
    });
    await detectOverdueConditions(db, { nowMs: NOW_MS });
    const decided = await decideException(db, cmd("rej"), {
      packageId: "EXC-CND-REJ", outcome: "reject", actor: "STAFF-APPROVER",
      conditionId: "CND-REJ",
    });
    expect(decided).toMatchObject({ outcome: "reject", impactStatus: "rework-required" });
    expect(await isApprovalEffective(db, "REC-REJ")).toBe(false);
    const artifact = (await db.execute(
      sql`SELECT artifact_state FROM dopaios_artifacts WHERE id = 'ART-REJ' AND revision = 1`,
    )) as unknown as Array<{ artifact_state: string }>;
    expect(artifact[0].artifact_state).toBe("approved");
  });

  it("luật gộp SFR-029 + ca B12: nguồn đổi sau approval treo hiệu lực; chỉ rời impact-pending khi MỌI record mở có disposition", async () => {
    await registerDraftArtifact(db, cmd("reg"), {
      artifactId: "ART-AGG", revision: 1, sha256: SHA,
      createdBy: "STAFF-AUTHOR", artifactType: "governance-doc", hasRegionSchema: false,
    });
    await submitArtifactForReview(db, cmd("sub"), { artifactId: "ART-AGG", revision: 1 });
    await assembleDecisionPackage(db, cmd("pkg"), {
      packageId: "PKG-AGG", revision: 1,
      target: { artifactId: "ART-AGG", revision: 1, sha256: SHA },
      refs: { evidence: "ev-agg" }, fields: {},
    });
    await recordApprovalDecision(db, cmd("appr"), {
      recordId: "REC-AGG", packageId: "PKG-AGG", packageRevision: 1,
      target: { artifactId: "ART-AGG", revision: 1, sha256: SHA },
      outcome: "approve", approvedScope: { kind: "full-revision" },
      findings: [], nonWaivableBlockers: [], impactSet: [], downstreamChecked: [],
      pinnedRefs: { evidence: "ev-agg" }, actor: "STAFF-APPROVER",
    });
    expect(await isApprovalEffective(db, "REC-AGG")).toBe(true);

    await declareSourceChanged(db, cmd("s1"), {
      impactId: "IMP-AGG-1", artifactId: "ART-AGG", artifactRevision: 1, sourceRef: "PRD đổi mục 3",
    });
    await declareSourceChanged(db, cmd("s2"), {
      impactId: "IMP-AGG-2", artifactId: "ART-AGG", artifactRevision: 1, sourceRef: "SOP đổi bước 2",
    });
    expect(await impactStatus("ART-AGG")).toBe("impact-pending");
    expect(await isApprovalEffective(db, "REC-AGG")).toBe(false);

    const first = await dispositionImpact(db, cmd("d1"), {
      impactId: "IMP-AGG-1", conclusion: "keep-value", actor: "STAFF-APPROVER", basis: "khong cham muc nay",
    });
    expect(first).toMatchObject({ impactStatus: "impact-pending" });
    const second = await dispositionImpact(db, cmd("d2"), {
      impactId: "IMP-AGG-2", conclusion: "keep-value", actor: "STAFF-APPROVER", basis: "buoc 2 khong dung",
    });
    expect(second).toMatchObject({ impactStatus: "reaffirmed" });
    expect(await isApprovalEffective(db, "REC-AGG")).toBe(true);

    // Impact mới chồng lên → pending lại; kết luận must-fix → rework-required.
    await declareSourceChanged(db, cmd("s3"), {
      impactId: "IMP-AGG-3", artifactId: "ART-AGG", artifactRevision: 1, sourceRef: "FS đổi hợp đồng",
    });
    expect(await impactStatus("ART-AGG")).toBe("impact-pending");
    const third = await dispositionImpact(db, cmd("d3"), {
      impactId: "IMP-AGG-3", conclusion: "must-fix", actor: "STAFF-APPROVER", basis: "hop dong doi that",
    });
    expect(third).toMatchObject({ impactStatus: "rework-required" });
    expect(await isApprovalEffective(db, "REC-AGG")).toBe(false);

    // Disposition thiếu căn cứ hoặc sai capability bị chặn.
    await expect(
      dispositionImpact(db, cmd("nobasis"), {
        impactId: "IMP-AGG-3", conclusion: "keep-value", actor: "STAFF-APPROVER", basis: "",
      }),
    ).rejects.toMatchObject({ code: "ERR-002" });
    await expect(
      dispositionImpact(db, cmd("nocap"), {
        impactId: "IMP-AGG-3", conclusion: "keep-value", actor: "STAFF-AUTHOR", basis: "x",
      }),
    ).rejects.toMatchObject({ code: "ERR-CAPABILITY" });
  });

  it("replay dựng lại toàn bộ vòng đời condition/impact byte-identical", async () => {
    const before = await snapshotProjections(db);
    expect(before["dopaios_impact_records"]!.length).toBeGreaterThan(0);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
