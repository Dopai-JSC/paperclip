import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  executeCommand,
  payloadSha256,
  writeEvent,
  CommandRejectedError,
} from "./event-store.js";

// KC-03 B2: approval engine dùng chung trên event store KC-01, đúng hợp đồng
// record-approval của FS-002 (bảng d.651-661) và ranh FS-003:
//  - actor của lệnh CHÍNH LÀ người duyệt (không có trường "người duyệt" rời);
//  - separation rule fail-closed theo LOẠI artifact (SFR-014) và theo ĐỊNH
//    DANH Staff đã tạo revision (SFR-013) — không theo capability, nên một
//    người giữ nhiều capability vẫn hợp lệ (điểm nóng kế hoạch);
//  - bốn outcome + luật phạm vi SFR-022…027; supersede nguyên tử SFR-028;
//  - Gate Record chỉ cho Cổng A/B/C (FS-003 SFR-035);
//  - mọi lệnh bị chặn đều để lại vệt audit bất biến (SQR-001) qua
//    executeAuditedCommand — event CommandRejected không có projection.

type Json = Record<string, unknown>;

export const APPROVAL_OUTCOMES = [
  "approve",
  "reject",
  "approve-with-conditions",
  "request-more-information",
] as const;

// Bản đồ Cổng duy nhất được phép có Gate Record (FX-03: chỉ ba điểm này
// gate_record=true; C4 ngoài phạm vi).
const GATE_POINTS: Record<string, string> = {
  "Cổng A": "B0-12",
  "Cổng B": "B1-08",
  "Cổng C": "B2-06",
};

const POLICY_REQUIRED_FIELDS = [
  "policy_id",
  "scope_level",
  "approver_capability",
  "effective_at",
  "invalidation_rule",
] as const;

// Chặn + audit (SQR-001): CommandRejectedError vẫn rollback trọn transaction
// lệnh (REC-001), nhưng để lại một event audit ở transaction riêng — bằng
// chứng bất biến rằng hành động đã bị chặn, vì sao, với payload hash nào.
export async function executeAuditedCommand(
  db: Db,
  input: {
    commandId: string;
    payload: Json;
    handler: (ctx: CommandContext, payload: Json) => Promise<CommandResult>;
  },
): Promise<CommandResult> {
  try {
    return await executeCommand(db, input);
  } catch (error) {
    if (error instanceof CommandRejectedError) {
      await db.transaction(async (tx) => {
        await writeEvent(tx, {
          streamName: `dopaiosAudit-${input.commandId}`,
          type: "CommandRejected",
          data: {
            commandId: input.commandId,
            code: error.code,
            reason: error.message,
            payloadSha256: payloadSha256(input.payload),
          },
        });
      });
    }
    throw error;
  }
}

async function queryRows<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

export async function pinSeparationPolicy(
  db: Db,
  commandId: string,
  payload: { policyId: string; artifactType: string; revision: number; policy: Json; pinnedBy: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      // Không guard nội dung tại thời điểm pin: SFR-014 kiểm ĐỦ TRƯỜNG lúc
      // phê duyệt — fixture cần pin được policy thiếu trường để chứng minh
      // fail-closed chặn mọi lệnh của loại đó.
      await ctx.emit({
        streamName: `dopaiosSeparationPolicy-${p["policyId"]}`,
        type: "SeparationPolicyPinned",
        data: {
          policyId: p["policyId"],
          artifactType: p["artifactType"],
          revision: p["revision"],
          policy: p["policy"],
          pinnedBy: p["pinnedBy"],
        },
      });
      return { policyId: p["policyId"] as string, revision: p["revision"] as number };
    },
  });
}

export async function registerDraftArtifact(
  db: Db,
  commandId: string,
  payload: {
    artifactId: string;
    revision: number;
    sha256: string;
    createdBy: string;
    artifactType: string;
    hasRegionSchema: boolean;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const existing = await queryRows<{ max: number | null }>(
        ctx,
        sql`SELECT max(revision)::int AS max FROM dopaios_artifacts WHERE id = ${p["artifactId"]}`,
      );
      const maxRevision = existing[0]?.max ?? 0;
      if ((p["revision"] as number) !== maxRevision + 1) {
        throw new CommandRejectedError(
          "ERR-REVISION",
          `Revision must be ${maxRevision + 1}, got ${p["revision"]}`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactRegistered",
        data: {
          artifactId: p["artifactId"],
          revision: p["revision"],
          sha256: p["sha256"],
          artifactState: "draft",
          impactStatus: "clear",
          createdBy: p["createdBy"],
          artifactType: p["artifactType"],
          hasRegionSchema: p["hasRegionSchema"],
        },
      });
      return { artifactId: p["artifactId"] as string, revision: p["revision"] as number, state: "draft" };
    },
  });
}

export async function submitArtifactForReview(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const rows = await queryRows<{ artifact_state: string }>(
        ctx,
        sql`SELECT artifact_state FROM dopaios_artifacts
            WHERE id = ${p["artifactId"]} AND revision = ${p["revision"]}`,
      );
      if (rows.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Artifact revision not found");
      }
      if (rows[0].artifact_state !== "draft") {
        throw new CommandRejectedError("ERR-STATE", "Only draft can be submitted for review");
      }
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactStateChanged",
        data: { artifactId: p["artifactId"], revision: p["revision"], artifactState: "in-review" },
      });
      return { artifactId: p["artifactId"] as string, state: "in-review" };
    },
  });
}

// Gói quyết định có revision; revision > 1 supersede gói trước trên cùng
// target và (nếu truyền requestId) tạo đúng một Yêu cầu mới — SFR-047.
export async function assembleDecisionPackage(
  db: Db,
  commandId: string,
  payload: {
    packageId: string;
    revision: number;
    target: { artifactId: string; revision: number; sha256: string };
    refs: Json;
    fields: Json;
    requestId?: string;
    runId?: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const target = p["target"] as { artifactId: string; revision: number; sha256: string };
      const artifact = await queryRows<{ artifact_state: string; sha256: string }>(
        ctx,
        sql`SELECT artifact_state, sha256 FROM dopaios_artifacts
            WHERE id = ${target.artifactId} AND revision = ${target.revision}`,
      );
      if (artifact.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Target artifact revision not found");
      }
      if (artifact[0].artifact_state !== "in-review") {
        throw new CommandRejectedError("ERR-001", "Target is not in-review");
      }
      if (artifact[0].sha256 !== target.sha256) {
        throw new CommandRejectedError("SFR-007", "Target content hash does not match the pinned hash");
      }
      const revision = p["revision"] as number;
      if (revision > 1) {
        const prior = await queryRows<{ state: string }>(
          ctx,
          sql`SELECT state FROM dopaios_decision_packages
              WHERE id = ${p["packageId"]} AND revision = ${revision - 1}`,
        );
        if (prior.length === 0) {
          throw new CommandRejectedError("SFR-047", `Package revision ${revision - 1} does not exist`);
        }
        await ctx.emit({
          streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
          type: "DecisionPackageRevisionStateChanged",
          data: { packageId: p["packageId"], revision: revision - 1, state: "SUPERSEDED" },
        });
      }
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageAssembled",
        data: {
          packageId: p["packageId"],
          revision,
          refs: p["refs"],
          target,
          fields: p["fields"],
        },
      });
      if (p["requestId"]) {
        await ctx.emit({
          streamName: `dopaiosActionRequest-${p["requestId"]}`,
          type: "ActionRequestCreated",
          data: { requestId: p["requestId"], kind: "decision", runId: p["runId"] ?? "NONE" },
        });
      }
      return { packageId: p["packageId"] as string, revision };
    },
  });
}

export type ApprovalCondition = {
  conditionId: string;
  scope: Json;
  risk: string;
  owner: string;
  deadline: string;
  closureCriteria: string;
  compensatingObligation?: string;
  blocksNextStep: boolean;
};

export type RecordApprovalPayload = {
  recordId: string;
  packageId: string;
  packageRevision: number;
  target: { artifactId: string; revision: number; sha256: string };
  outcome: (typeof APPROVAL_OUTCOMES)[number];
  approvedScope: { kind: "full-revision" } | { kind: "regions"; regions: string[] };
  findings: Json[];
  nonWaivableBlockers: Json[];
  impactSet: Json[];
  downstreamChecked: Json[];
  conditions?: ApprovalCondition[];
  openedStep?: string;
  reEntryPoint?: string | null;
  expiry?: Json;
  pinnedRefs: Json;
  actor: string;
};

const RECORD_REQUIRED_FIELDS = [
  "recordId",
  "packageId",
  "packageRevision",
  "target",
  "outcome",
  "approvedScope",
  "findings",
  "nonWaivableBlockers",
  "impactSet",
  "downstreamChecked",
  "pinnedRefs",
  "actor",
] as const;

const CONDITION_REQUIRED_FIELDS = [
  "conditionId",
  "scope",
  "risk",
  "owner",
  "deadline",
  "closureCriteria",
  "blocksNextStep",
] as const;

export async function recordApprovalDecision(
  db: Db,
  commandId: string,
  payload: RecordApprovalPayload,
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      // ERR-002: fail-closed thiếu trường — nêu đích danh, không default ngầm.
      for (const field of RECORD_REQUIRED_FIELDS) {
        if (p[field] === undefined || p[field] === null) {
          throw new CommandRejectedError("ERR-002", `Missing required field: ${field}`);
        }
      }
      const outcome = p["outcome"] as string;
      if (!APPROVAL_OUTCOMES.includes(outcome as (typeof APPROVAL_OUTCOMES)[number])) {
        throw new CommandRejectedError("ERR-002", `Unknown outcome: ${outcome}`);
      }
      const target = p["target"] as { artifactId: string; revision: number; sha256: string };
      const actor = p["actor"] as string;

      // SFR-021: target chặng Project không thuộc quyền lệnh sổ cái này.
      const project = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_projects WHERE id = ${target.artifactId}`,
      );
      if (project.length > 0) {
        throw new CommandRejectedError("SFR-021", "Approval target must not be a Project stage");
      }

      const artifactRows = await queryRows<{
        artifact_state: string;
        sha256: string;
        created_by: string | null;
        artifact_type: string | null;
        has_region_schema: boolean | null;
      }>(
        ctx,
        sql`SELECT artifact_state, sha256, created_by, artifact_type, has_region_schema
            FROM dopaios_artifacts
            WHERE id = ${target.artifactId} AND revision = ${target.revision}`,
      );
      if (artifactRows.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Target artifact revision not found");
      }
      const artifact = artifactRows[0];
      if (artifact.artifact_state !== "in-review") {
        throw new CommandRejectedError("ERR-001", "Target is not in-review — no record is created");
      }
      // SFR-027 (FS-002): chỉ revision MỚI NHẤT nhận quyết định.
      const latest = await queryRows<{ max: number }>(
        ctx,
        sql`SELECT max(revision)::int AS max FROM dopaios_artifacts WHERE id = ${target.artifactId}`,
      );
      if (target.revision !== latest[0]?.max) {
        throw new CommandRejectedError("SFR-027", "Approval must target the latest revision");
      }
      // SFR-006/007: hiệu lực gắn content-hash — pin sai hash bị chặn.
      if (artifact.sha256 !== target.sha256) {
        throw new CommandRejectedError("SFR-007", "Target content hash does not match the pinned hash");
      }

      // SFR-014 fail-closed: policy theo LOẠI artifact phải được pin và ĐỦ
      // trường; thiếu bất kỳ trường nào → chặn MỌI lệnh phê duyệt loại đó.
      const policyRows = await queryRows<{ policy: Json }>(
        ctx,
        sql`SELECT policy FROM dopaios_separation_policies
            WHERE artifact_type = ${artifact.artifact_type}`,
      );
      if (policyRows.length === 0) {
        throw new CommandRejectedError(
          "SFR-014",
          `Separation rule for artifact type ${artifact.artifact_type} is not pinned — fail closed`,
        );
      }
      const policy = policyRows[0].policy;
      for (const field of POLICY_REQUIRED_FIELDS) {
        if (!policy[field]) {
          throw new CommandRejectedError(
            "SFR-014",
            `Separation rule is missing required field ${field} — fail closed`,
          );
        }
      }

      // SFR-013: tách theo ĐỊNH DANH Staff tạo revision — không theo
      // capability, nên một người giữ nhiều capability vẫn duyệt được
      // artifact do NGƯỜI KHÁC tạo (điểm nóng CTO-2-capability).
      if (actor === artifact.created_by) {
        throw new CommandRejectedError(
          "SFR-013",
          "Approver must differ from the Staff who created the target revision",
        );
      }

      const actorRows = await queryRows<{ active: boolean; kind: string; capabilities: string[] }>(
        ctx,
        sql`SELECT active, kind, capabilities FROM dopaios_actors WHERE id = ${actor}`,
      );
      if (actorRows.length === 0 || !actorRows[0].active) {
        throw new CommandRejectedError("ERR-ACTOR", "Approver is not a registered active actor");
      }
      // KC-13 B6 (FS-003 SFR-023): vai quyết định của mọi điểm kiểm soát là
      // vai NGƯỜI — AI cầm đúng capability vẫn không được phê duyệt.
      if (actorRows[0].kind !== "human") {
        throw new CommandRejectedError(
          "SFR-023",
          "AI holds no approval authority — the deciding role of every control point is a human role",
        );
      }
      const requiredCapability = policy["approver_capability"] as string;
      if (!actorRows[0].capabilities.includes(requiredCapability)) {
        throw new CommandRejectedError(
          "ERR-CAPABILITY",
          `Approver lacks capability ${requiredCapability}`,
        );
      }

      const pkgRows = await queryRows<{ state: string; refs: Json; target: Json | null }>(
        ctx,
        sql`SELECT state, refs, target FROM dopaios_decision_packages
            WHERE id = ${p["packageId"]} AND revision = ${p["packageRevision"]}`,
      );
      if (pkgRows.length === 0) {
        throw new CommandRejectedError("ERR-PKG", "Decision package revision not found");
      }
      if (pkgRows[0].state !== "OPEN") {
        throw new CommandRejectedError(
          "SFR-047",
          "Decisions are only recorded on the newest open package revision",
        );
      }
      if (payloadSha256(pkgRows[0].refs) !== payloadSha256(p["pinnedRefs"])) {
        throw new CommandRejectedError(
          "SFR-028",
          "Pinned refs must be byte-equivalent to the decision package refs",
        );
      }
      if (pkgRows[0].target && payloadSha256(pkgRows[0].target) !== payloadSha256(target)) {
        throw new CommandRejectedError("ERR-PKG-TARGET", "Package was assembled for a different target");
      }

      const blockers = p["nonWaivableBlockers"] as unknown[];
      const scope = p["approvedScope"] as { kind: string };
      const conditions = (p["conditions"] as ApprovalCondition[] | undefined) ?? [];

      if (outcome === "approve") {
        if (blockers.length > 0) {
          throw new CommandRejectedError("ERR-BLOCKER", "Approve is blocked by non-waivable blockers");
        }
        if (scope.kind !== "full-revision") {
          throw new CommandRejectedError(
            "ERR-004",
            "Approve must cover the full revision — use approve-with-conditions by region or split the artifact (SFR-026)",
          );
        }
        if (conditions.length > 0) {
          throw new CommandRejectedError("ERR-002", "Conditions are only valid with approve-with-conditions");
        }
      }
      if (outcome === "approve-with-conditions") {
        if (blockers.length > 0) {
          throw new CommandRejectedError(
            "SFR-022",
            "Approve-with-conditions is rejected while non-waivable blockers exist",
          );
        }
        if (conditions.length === 0) {
          throw new CommandRejectedError("ERR-002", "Approve-with-conditions requires at least one condition");
        }
        for (const condition of conditions) {
          for (const field of CONDITION_REQUIRED_FIELDS) {
            if ((condition as unknown as Json)[field] === undefined) {
              throw new CommandRejectedError("SFR-033", `Condition is missing required field ${field}`);
            }
          }
          if (condition.blocksNextStep === true) {
            throw new CommandRejectedError(
              "SFR-022",
              "A condition with blocks_next_step: true blocks the decision",
            );
          }
        }
        if (scope.kind === "regions") {
          if (artifact.has_region_schema !== true) {
            throw new CommandRejectedError(
              "SFR-025",
              "Region-scoped approval requires an artifact type with a region schema — split the revision instead",
            );
          }
        } else if (scope.kind !== "full-revision") {
          throw new CommandRejectedError("ERR-002", `Unknown approved_scope kind: ${scope.kind}`);
        }
      }

      await ctx.emit({
        streamName: `dopaiosApproval-${p["recordId"]}`,
        type: "ApprovalRecorded",
        data: {
          recordId: p["recordId"],
          packageId: p["packageId"],
          packageRevision: p["packageRevision"],
          outcome,
          pinnedRefs: p["pinnedRefs"],
          actor,
          targetId: target.artifactId,
          targetRevision: target.revision,
          targetSha256: target.sha256,
          approvedScope: p["approvedScope"],
          findings: p["findings"],
          nonWaivableBlockers: p["nonWaivableBlockers"],
          impactSet: p["impactSet"],
          downstreamChecked: p["downstreamChecked"],
          openedStep: p["openedStep"] ?? null,
          reEntryPoint: p["reEntryPoint"] ?? null,
          expiry: p["expiry"] ?? null,
          requestedBy: artifact.created_by,
        },
        expectedVersion: -1,
      });

      let resultingState = artifact.artifact_state;
      const becomesApproved =
        outcome === "approve" || (outcome === "approve-with-conditions" && scope.kind === "full-revision");
      if (becomesApproved) {
        await ctx.emit({
          streamName: `dopaiosArtifact-${target.artifactId}`,
          type: "ArtifactStateChanged",
          data: { artifactId: target.artifactId, revision: target.revision, artifactState: "approved" },
        });
        resultingState = "approved";
        // SFR-028 (FS-002): supersede nguyên tử MỌI revision cũ chưa terminal
        // — cùng transaction với approve, hỏng một phần là hỏng cả lệnh.
        const older = await queryRows<{ revision: number }>(
          ctx,
          sql`SELECT revision FROM dopaios_artifacts
              WHERE id = ${target.artifactId} AND revision < ${target.revision}
                AND artifact_state NOT IN ('superseded', 'retired')
              ORDER BY revision`,
        );
        for (const row of older) {
          await ctx.emit({
            streamName: `dopaiosArtifact-${target.artifactId}`,
            type: "ArtifactStateChanged",
            data: { artifactId: target.artifactId, revision: row.revision, artifactState: "superseded" },
          });
        }
      } else if (outcome === "reject") {
        // EDGE-002: nội dung revision bất biến — chỉ trạng thái quay về draft.
        await ctx.emit({
          streamName: `dopaiosArtifact-${target.artifactId}`,
          type: "ArtifactStateChanged",
          data: { artifactId: target.artifactId, revision: target.revision, artifactState: "draft" },
        });
        resultingState = "draft";
      }
      // AWC theo vùng (SFR-024) và request-more-information: giữ in-review.

      for (const condition of conditions) {
        await ctx.emit({
          streamName: `dopaiosCondition-${condition.conditionId}`,
          type: "ConditionOpened",
          data: {
            conditionId: condition.conditionId,
            recordId: p["recordId"],
            scope: condition.scope,
            risk: condition.risk,
            owner: condition.owner,
            deadline: condition.deadline,
            closureCriteria: condition.closureCriteria,
            compensatingObligation: condition.compensatingObligation ?? null,
            blocksNextStep: condition.blocksNextStep,
          },
          expectedVersion: -1,
        });
      }

      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageRevisionStateChanged",
        data: {
          packageId: p["packageId"],
          revision: p["packageRevision"],
          state: outcome === "request-more-information" ? "AWAITING_INFO" : "DECIDED",
        },
      });

      return {
        recordId: p["recordId"] as string,
        outcome,
        artifactState: resultingState,
        conditionsOpened: conditions.length,
      };
    },
  });
}

// FX-03-B06 (SOP d.905, FS-003 US6-AC4): comment/kết luận ready/im lặng
// KHÔNG thay Approval Record — lệnh này chỉ để lại event audit bất biến,
// không đổi bất kỳ trạng thái nào (event không có projection).
export async function recordReviewComment(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number; author: string; comment: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await ctx.emit({
        streamName: `dopaiosComment-${p["artifactId"]}`,
        type: "ReviewCommentRecorded",
        data: {
          artifactId: p["artifactId"],
          revision: p["revision"],
          author: p["author"],
          comment: p["comment"],
        },
      });
      return { artifactId: p["artifactId"] as string, stateChanged: false };
    },
  });
}

// Gate Record CHỈ cho Cổng A/B/C (FS-003 SFR-035): điểm không phải Cổng
// không bao giờ có Gate Record — mọi yêu cầu khác bị từ chối kèm audit.
export async function createGateRecord(
  db: Db,
  commandId: string,
  payload: {
    gateRecordId: string;
    gateName: string;
    pointId: string;
    runId?: string;
    approvalRecordId: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const expectedPoint = GATE_POINTS[p["gateName"] as string];
      if (!expectedPoint || expectedPoint !== p["pointId"]) {
        throw new CommandRejectedError(
          "SFR-035",
          `Gate Records exist only for Cổng A/B/C at their points — ${p["gateName"]}/${p["pointId"]} refused`,
        );
      }
      const record = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_approval_records WHERE id = ${p["approvalRecordId"]}`,
      );
      if (record.length === 0) {
        throw new CommandRejectedError("ERR-RECORD", "Approval record not found");
      }
      await ctx.emit({
        streamName: `dopaiosGateRecord-${p["gateRecordId"]}`,
        type: "GateRecordCreated",
        data: {
          gateRecordId: p["gateRecordId"],
          gateName: p["gateName"],
          pointId: p["pointId"],
          runId: p["runId"] ?? null,
          approvalRecordId: p["approvalRecordId"],
        },
        expectedVersion: -1,
      });
      return { gateRecordId: p["gateRecordId"] as string, gateName: p["gateName"] as string };
    },
  });
}
