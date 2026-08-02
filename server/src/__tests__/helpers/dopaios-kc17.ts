import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { createDb } from "@paperclipai/db";
import { registerActor } from "../../dopaios/commands.js";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
  type RecordApprovalPayload,
} from "../../dopaios/approval.js";
import {
  registerBootstrapWorkflow,
  setCutoverReadiness,
  sha256Utf8,
  CUTOVER_READINESS_FLAGS,
  type ExecuteCutoverPayload,
} from "../../dopaios/cutover.js";

// Helper dùng chung KC-17: dựng bối cảnh cutover giả lập từ ĐÚNG fixture
// FX-05 của danh mục V-09 (không chép nội dung vào test — đọc file thật,
// đối chiếu hash pin trong fx-05-cutover-sim.json).

type Db = ReturnType<typeof createDb>;

const FIXTURES_ROOT = new URL("../../../../dopaios/fixtures/", import.meta.url);

export function readFixtureUtf8(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, FIXTURES_ROOT)), "utf8");
}

export const FX05 = JSON.parse(readFixtureUtf8("fx-05-cutover-sim.json")) as {
  readiness_flags: Record<string, boolean | string>;
  approval_fixture: {
    approval_point: string;
    decision_authority: string;
    target: { record_id: string; revision: number; sha256: string };
  };
  activation: { command: string; activation_idempotency_key: string };
  cases: Array<{ case_id: string; title: string }>;
};

export const PLAN_CONTENT_UTF8 = readFixtureUtf8("content/cutover-plan.json");
export const PLAN_SHA256 = sha256Utf8(PLAN_CONTENT_UTF8);
export const PLAN_DOC = JSON.parse(PLAN_CONTENT_UTF8) as {
  plan_id: string;
  revision: number;
  feature_id: string;
  first_runtime_work_item_ref: string;
  open_states: Array<Record<string, unknown>>;
  rollback_condition: string;
  rollback_target: string;
};

export const RECON_CONTENT_UTF8 = readFixtureUtf8("content/cutover-reconciliation-mapping.json");
export const RECON_SHA256 = sha256Utf8(RECON_CONTENT_UTF8);
export const RECON_DOC = JSON.parse(RECON_CONTENT_UTF8) as {
  mapping_id: string;
  revision: number;
  pins_cutover_record: { record_id: string; revision: number; state: string };
  mappings: Array<Record<string, unknown>>;
  residuals: Array<Record<string, unknown>>;
};

export const FEATURE_ID = PLAN_DOC.feature_id; // FS-SIM-001
export const BOOTSTRAP_WORKFLOW_ID = "bootstrap-board-sim";
export const ORCHESTRATOR = FX05.approval_fixture.decision_authority; // STAFF-HUMAN-DECIDER-001
export const SYSTEM_ACTOR = "SYSTEM-RUNTIME-SIM-001";
export const AI_LEAD = "STAFF-AI-LEAD-SIM-001";
export const AI_REVIEWER = "STAFF-AI-REVIEWER-SIM-001";
export const PLAN_ARTIFACT_ID = FX05.approval_fixture.target.record_id; // CUTOVER-PLAN-SIM-001
export const APPROVAL_RECORD_ID = "APR-PILOT-CUTOVER-SIM-001";
export const EFFECTIVE_AT = "2026-07-31T09:00:00+07:00"; // = planned_effective_at (QD-6)

export function approvalPayload(
  overrides: Partial<RecordApprovalPayload> &
    Pick<RecordApprovalPayload, "recordId" | "packageId" | "target" | "actor">,
): RecordApprovalPayload {
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

// Đăng ký một "bản plan" trong sổ cái (id tùy biến, nội dung = đúng byte
// fixture) rồi đưa qua chuỗi KC-03: in-review → Gói quyết định (pointId) →
// Approval Record. Trả về approvalRecordId.
export async function stagePlanWithApproval(
  db: Db,
  cmd: (label: string) => string,
  input: {
    artifactId: string;
    approvalRecordId: string;
    pointId?: string;
    expiry?: Record<string, unknown>;
    outcome?: RecordApprovalPayload["outcome"];
  },
): Promise<string> {
  await registerDraftArtifact(db, cmd(`reg-${input.artifactId}`), {
    artifactId: input.artifactId,
    revision: 1,
    sha256: PLAN_SHA256,
    createdBy: AI_LEAD,
    artifactType: "cutover-plan",
    hasRegionSchema: false,
    storageRef: "dopaios/fixtures/content/cutover-plan.json",
  });
  await submitArtifactForReview(db, cmd(`sub-${input.artifactId}`), {
    artifactId: input.artifactId,
    revision: 1,
  });
  await assembleDecisionPackage(db, cmd(`pkg-${input.artifactId}`), {
    packageId: `PKG-${input.artifactId}`,
    revision: 1,
    target: { artifactId: input.artifactId, revision: 1, sha256: PLAN_SHA256 },
    refs: { evidence: `ev-${input.artifactId}` },
    fields: {
      pointId: input.pointId ?? "PILOT-CUTOVER",
      decisionAsk: `Duyệt Cutover Plan ${input.artifactId}@1?`,
    },
  });
  await recordApprovalDecision(
    db,
    cmd(`apr-${input.artifactId}`),
    approvalPayload({
      recordId: input.approvalRecordId,
      packageId: `PKG-${input.artifactId}`,
      target: { artifactId: input.artifactId, revision: 1, sha256: PLAN_SHA256 },
      actor: ORCHESTRATOR,
      ...(input.expiry ? { expiry: input.expiry } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
    }),
  );
  return input.approvalRecordId;
}

// Bối cảnh nền: actor, separation policy, bootstrap workflow, 4 cờ readiness
// đạt, plan chuẩn CUTOVER-PLAN-SIM-001@1 được duyệt tại PILOT-CUTOVER.
export async function setupCutoverBase(db: Db, cmd: (label: string) => string): Promise<void> {
  await registerActor(db, cmd("actor-lead"), {
    actorId: AI_LEAD,
    kind: "ai",
    active: true,
    capabilities: ["product-governance"],
  });
  await registerActor(db, cmd("actor-reviewer"), {
    actorId: AI_REVIEWER,
    kind: "ai",
    active: true,
    capabilities: ["independent-review"],
  });
  await registerActor(db, cmd("actor-orch"), {
    actorId: ORCHESTRATOR,
    kind: "human",
    active: true,
    capabilities: ["pilot-cutover-approver"],
  });
  await registerActor(db, cmd("actor-system"), {
    actorId: SYSTEM_ACTOR,
    kind: "system",
    active: true,
    capabilities: ["runtime-activation"],
  });
  await pinSeparationPolicy(db, cmd("policy"), {
    policyId: "SEP-CUTOVER-PLAN-001",
    artifactType: "cutover-plan",
    revision: 1,
    policy: {
      policy_id: "SEP-CUTOVER-PLAN-001",
      scope_level: "artifact-type",
      approver_capability: "pilot-cutover-approver",
      effective_at: "2026-07-30T00:00:00+07:00",
      invalidation_rule: "target-revision-change",
    },
    pinnedBy: ORCHESTRATOR,
  });
  await registerBootstrapWorkflow(db, cmd("bootstrap"), {
    workflowId: BOOTSTRAP_WORKFLOW_ID,
    featureId: FEATURE_ID,
  });
  for (const flag of CUTOVER_READINESS_FLAGS) {
    await setCutoverReadiness(db, cmd(`ready-${flag}`), {
      featureId: FEATURE_ID,
      flag,
      ready: true,
      actor: ORCHESTRATOR,
    });
  }
  await stagePlanWithApproval(db, cmd, {
    artifactId: PLAN_ARTIFACT_ID,
    approvalRecordId: APPROVAL_RECORD_ID,
  });
}

export function baseCutoverPayload(
  activationKey: string,
  overrides: Partial<ExecuteCutoverPayload> = {},
): ExecuteCutoverPayload {
  return {
    featureId: FEATURE_ID,
    activationKey,
    plan: { artifactId: PLAN_ARTIFACT_ID, revision: 1, sha256: PLAN_SHA256 },
    planContentUtf8: PLAN_CONTENT_UTF8,
    approvalRecordId: APPROVAL_RECORD_ID,
    authorityActor: ORCHESTRATOR,
    executionActor: SYSTEM_ACTOR,
    bootstrapWorkflowId: BOOTSTRAP_WORKFLOW_ID,
    runtimeWorkflowRef: "runtime-workflow-sim-001",
    snapshotId: "RAS-SIM-001",
    cutoverRecordId: "CUTOVER-REC-SIM-001",
    effectiveAt: EFFECTIVE_AT,
    ...overrides,
  };
}
