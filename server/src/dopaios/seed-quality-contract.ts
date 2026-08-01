import type { Db } from "./event-store.js";
import { registerActor } from "./commands.js";
import {
  pinSeparationPolicy,
  registerDraftArtifact,
  submitArtifactForReview,
  assembleDecisionPackage,
  recordApprovalDecision,
} from "./approval.js";
import {
  registerQualityContract,
  qualityContractContentSha256,
  type QualityContractRef,
} from "./lifecycle.js";

// KC-14: seed một Hợp đồng chất lượng đã duyệt qua ĐƯỜNG KC-03 THẬT —
// draft → in-review → Gói quyết định → approve (Approval Record hiệu lực) —
// vì guard pin của KC-14 đòi approval record thật, không nhận hàng ledger
// bootstrap không record (finding vòng review đối kháng B7). Helper tự seed
// hai Staff chuyên trách + separation policy với command id CỐ ĐỊNH nên gọi
// nhiều lần trong một suite chỉ là idempotent replay.
const QC_AUTHOR = "QC-HELPER-AUTHOR";
const QC_APPROVER = "QC-HELPER-APPROVER";

async function ensureHelperActorsAndPolicy(db: Db): Promise<void> {
  await registerActor(db, "KC14-HELPER-ACTOR-AUTHOR", {
    actorId: QC_AUTHOR,
    kind: "human",
    active: true,
    capabilities: ["product-governance"],
  });
  await registerActor(db, "KC14-HELPER-ACTOR-APPROVER", {
    actorId: QC_APPROVER,
    kind: "human",
    active: true,
    capabilities: ["governance-approver"],
  });
  await pinSeparationPolicy(db, "KC14-HELPER-POLICY", {
    policyId: "SEP-QC-HELPER",
    artifactType: "quality-contract",
    revision: 1,
    policy: {
      policy_id: "SEP-QC-HELPER",
      scope_level: "company",
      approver_capability: "governance-approver",
      effective_at: "2026-08-01T00:00:00Z",
      invalidation_rule: "revision-superseded",
    },
    pinnedBy: QC_APPROVER,
  });
}

export async function seedApprovedQualityContract(
  db: Db,
  opts: {
    id: string;
    revision?: number;
    outputType: string;
    requiredChecks: string[];
    cmdPrefix: string;
    registeredBy?: string;
  },
): Promise<QualityContractRef> {
  const revision = opts.revision ?? 1;
  const sha256 = qualityContractContentSha256({
    outputType: opts.outputType,
    requiredChecks: opts.requiredChecks,
  });
  await ensureHelperActorsAndPolicy(db);
  await registerDraftArtifact(db, `${opts.cmdPrefix}-QC-DRAFT-${opts.id}-r${revision}`, {
    artifactId: opts.id,
    revision,
    sha256,
    createdBy: QC_AUTHOR,
    artifactType: "quality-contract",
    hasRegionSchema: false,
  });
  await submitArtifactForReview(db, `${opts.cmdPrefix}-QC-SUBMIT-${opts.id}-r${revision}`, {
    artifactId: opts.id,
    revision,
  });
  await assembleDecisionPackage(db, `${opts.cmdPrefix}-QC-PKG-${opts.id}-r${revision}`, {
    packageId: `PKG-QC-${opts.id}-r${revision}`,
    revision: 1,
    target: { artifactId: opts.id, revision, sha256 },
    refs: { evidence: `ev-qc-${opts.id}-r${revision}` },
    fields: {},
  });
  await recordApprovalDecision(db, `${opts.cmdPrefix}-QC-APPROVE-${opts.id}-r${revision}`, {
    recordId: `REC-QC-${opts.id}-r${revision}`,
    packageId: `PKG-QC-${opts.id}-r${revision}`,
    packageRevision: 1,
    target: { artifactId: opts.id, revision, sha256 },
    outcome: "approve",
    approvedScope: { kind: "full-revision" },
    findings: [],
    nonWaivableBlockers: [],
    impactSet: [],
    downstreamChecked: [],
    pinnedRefs: { evidence: `ev-qc-${opts.id}-r${revision}` },
    actor: QC_APPROVER,
  });
  await registerQualityContract(db, `${opts.cmdPrefix}-QC-CONTENT-${opts.id}-r${revision}`, {
    contractId: opts.id,
    revision,
    outputType: opts.outputType,
    requiredChecks: opts.requiredChecks,
    registeredBy: opts.registeredBy ?? QC_AUTHOR,
  });
  return { id: opts.id, revision, sha256 };
}
