import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-03 B3: vòng đời condition và impact trên approval engine B2.
//  - Đóng condition kèm bằng chứng đạt closure_criteria (FS-003 SFR-055) —
//    thiếu đường này mọi condition tất định quá hạn.
//  - Quá hạn (FS-002 SFR-016 / FS-003 SFR-034): watchdog tick tuyên bố
//    overdue → approval mất hiệu lực phần phụ thuộc qua impact-pending, mở
//    ĐÚNG MỘT impact record cho sự kiện, tạo Gói EXCEPTION target chính
//    revision đã duyệt cùng đúng một Yêu cầu exception.
//  - Quyết định trên Gói EXCEPTION: approve BẮT BUỘC kèm disposition tường
//    minh cho condition quá hạn TRONG CÙNG transaction; reject chấm dứt
//    hiệu lực chấp nhận qua kết luận must-fix — phiên bản GIỮ NGUYÊN trạng
//    thái đã duyệt, không viết lại lifecycle.
//  - Luật gộp SFR-029: artifact chỉ rời impact-pending khi MỌI impact record
//    mở đã có disposition; còn ≥1 kết luận must-fix → rework-required, toàn
//    giữ-giá-trị → reaffirmed; `clear` không bao giờ là đích disposition.

type Json = Record<string, unknown>;

async function queryRows<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

type ConditionRow = {
  id: string;
  record_id: string;
  state: string;
  owner: string;
  deadline: Date | string;
};

type RecordRow = {
  id: string;
  actor: string;
  target_id: string | null;
  target_revision: number | null;
};

async function loadConditionWithRecord(
  ctx: CommandContext,
  conditionId: string,
): Promise<{ condition: ConditionRow; record: RecordRow }> {
  const conditions = await queryRows<ConditionRow>(
    ctx,
    sql`SELECT id, record_id, state, owner, deadline FROM dopaios_conditions WHERE id = ${conditionId}`,
  );
  if (conditions.length === 0) {
    throw new CommandRejectedError("ERR-CONDITION", "Condition not found");
  }
  const records = await queryRows<RecordRow>(
    ctx,
    sql`SELECT id, actor, target_id, target_revision FROM dopaios_approval_records
        WHERE id = ${conditions[0].record_id}`,
  );
  if (records.length === 0) {
    throw new CommandRejectedError("ERR-RECORD", "Approval record of the condition not found");
  }
  return { condition: conditions[0], record: records[0] };
}

// SFR-055: người quyết định được pin trên record gửi lệnh đóng kèm bằng
// chứng; đóng xong hiệu lực approval giữ nguyên.
export async function closeCondition(
  db: Db,
  commandId: string,
  payload: { conditionId: string; actor: string; closureEvidence: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const { condition, record } = await loadConditionWithRecord(ctx, p["conditionId"] as string);
      if (condition.state !== "open") {
        throw new CommandRejectedError("ERR-CONDITION-STATE", `Condition is ${condition.state}, not open`);
      }
      if ((p["actor"] as string) !== record.actor) {
        throw new CommandRejectedError(
          "ERR-DECIDER",
          "Only the decider pinned on the approval record may close its conditions",
        );
      }
      if (!p["closureEvidence"]) {
        throw new CommandRejectedError("ERR-002", "Closure evidence is required");
      }
      await ctx.emit({
        streamName: `dopaiosCondition-${condition.id}`,
        type: "ConditionClosed",
        data: {
          conditionId: condition.id,
          closedBy: p["actor"],
          closureEvidence: p["closureEvidence"],
        },
      });
      return { conditionId: condition.id, state: "closed" };
    },
  });
}

// Watchdog tick: tìm condition open đã quá hạn theo đồng hồ người gọi và xử
// từng cái idempotent (command id theo condition + deadline — tick lặp không
// bắn đôi). Mỗi condition quá hạn: overdue + impact-pending + Gói EXCEPTION
// + đúng một Yêu cầu exception (SFR-016/034).
export async function detectOverdueConditions(
  db: Db,
  input: { nowMs: number },
): Promise<Array<{ conditionId: string; exceptionPackageId: string }>> {
  const overdue = (await db.execute(sql`
    SELECT c.id, c.deadline, r.target_id, r.target_revision
    FROM dopaios_conditions c
    JOIN dopaios_approval_records r ON r.id = c.record_id
    WHERE c.state = 'open' AND c.deadline < to_timestamp(${input.nowMs / 1000})
    ORDER BY c.id
  `)) as unknown as Array<{
    id: string;
    deadline: Date | string;
    target_id: string | null;
    target_revision: number | null;
  }>;

  const declared: Array<{ conditionId: string; exceptionPackageId: string }> = [];
  for (const row of overdue) {
    const deadlineMs = new Date(row.deadline).getTime();
    const exceptionPackageId = `EXC-${row.id}`;
    await executeAuditedCommand(db, {
      commandId: `OVERDUE-${row.id}-${deadlineMs}`,
      payload: { conditionId: row.id, deadlineMs },
      handler: async (ctx, p) => {
        const conditionId = p["conditionId"] as string;
        await ctx.emit({
          streamName: `dopaiosCondition-${conditionId}`,
          type: "ConditionOverdueDeclared",
          data: { conditionId },
        });
        await ctx.emit({
          streamName: `dopaiosImpact-IMP-${conditionId}`,
          type: "ImpactRecordOpened",
          data: {
            impactId: `IMP-${conditionId}`,
            artifactId: row.target_id,
            artifactRevision: row.target_revision,
            source: "condition-overdue",
            sourceRef: conditionId,
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosArtifact-${row.target_id}`,
          type: "ArtifactImpactChanged",
          data: {
            artifactId: row.target_id,
            revision: row.target_revision,
            impactStatus: "impact-pending",
          },
        });
        await ctx.emit({
          streamName: `dopaiosDecisionPackage-${exceptionPackageId}`,
          type: "DecisionPackageAssembled",
          data: {
            packageId: exceptionPackageId,
            revision: 1,
            refs: { conditionId, kind: "EXCEPTION" },
            target: { artifactId: row.target_id, revision: row.target_revision },
            fields: { kind: "EXCEPTION", decisionAsk: `Condition ${conditionId} quá hạn — xử lý?` },
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosActionRequest-REQ-${exceptionPackageId}`,
          type: "ActionRequestCreated",
          data: { requestId: `REQ-${exceptionPackageId}`, kind: "exception", runId: "NONE" },
          expectedVersion: -1,
        });
        return { conditionId, exceptionPackageId };
      },
    });
    declared.push({ conditionId: row.id, exceptionPackageId });
  }
  return declared;
}

// Luật gộp SFR-029 — chạy trong CÙNG transaction với disposition vừa ghi:
// còn record mở → giữ impact-pending; hết record mở → rework-required nếu
// còn ≥1 must-fix, reaffirmed nếu toàn keep-value.
async function aggregateImpact(
  ctx: CommandContext,
  artifactId: string,
  artifactRevision: number,
): Promise<string> {
  const rows = await queryRows<{ state: string; conclusion: string | null }>(
    ctx,
    sql`SELECT state, conclusion FROM dopaios_impact_records
        WHERE artifact_id = ${artifactId} AND artifact_revision = ${artifactRevision}`,
  );
  const open = rows.filter((r) => r.state === "open");
  if (open.length > 0) return "impact-pending";
  const mustFix = rows.some((r) => r.conclusion === "must-fix");
  const status = mustFix ? "rework-required" : "reaffirmed";
  await ctx.emit({
    streamName: `dopaiosArtifact-${artifactId}`,
    type: "ArtifactImpactChanged",
    data: { artifactId, revision: artifactRevision, impactStatus: status },
  });
  return status;
}

// Disposition một impact record (SFR-029): actor phải giữ capability
// governance-approver; conclusion chỉ có hai đích must-fix/keep-value —
// `clear` không bao giờ là đích.
export async function dispositionImpact(
  db: Db,
  commandId: string,
  payload: { impactId: string; conclusion: "must-fix" | "keep-value"; actor: string; basis: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      if (p["conclusion"] !== "must-fix" && p["conclusion"] !== "keep-value") {
        throw new CommandRejectedError("ERR-002", "Conclusion must be must-fix or keep-value");
      }
      if (!p["basis"]) {
        throw new CommandRejectedError("ERR-002", "Disposition requires an explicit basis");
      }
      const actors = await queryRows<{ capabilities: string[] }>(
        ctx,
        sql`SELECT capabilities FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (actors.length === 0 || !actors[0].capabilities.includes("governance-approver")) {
        throw new CommandRejectedError("ERR-CAPABILITY", "Disposition requires governance-approver");
      }
      const impacts = await queryRows<{
        state: string;
        artifact_id: string;
        artifact_revision: number;
      }>(
        ctx,
        sql`SELECT state, artifact_id, artifact_revision FROM dopaios_impact_records
            WHERE id = ${p["impactId"]}`,
      );
      if (impacts.length === 0) {
        throw new CommandRejectedError("ERR-IMPACT", "Impact record not found");
      }
      if (impacts[0].state !== "open") {
        throw new CommandRejectedError("ERR-IMPACT-STATE", "Impact record already dispositioned");
      }
      await ctx.emit({
        streamName: `dopaiosImpact-${p["impactId"]}`,
        type: "ImpactRecordDispositioned",
        data: {
          impactId: p["impactId"],
          conclusion: p["conclusion"],
          dispositionedBy: p["actor"],
          basis: p["basis"],
        },
      });
      const status = await aggregateImpact(ctx, impacts[0].artifact_id, impacts[0].artifact_revision);
      return { impactId: p["impactId"] as string, impactStatus: status };
    },
  });
}

// Nguồn khai đổi nghĩa (FS-002 SFR-010 → luật gộp SFR-029; ca chặn FX-03-B12):
// target đổi sau approval → impact record mới + impact-pending — hiệu lực
// approval treo cho tới khi mọi record mở có disposition.
export async function declareSourceChanged(
  db: Db,
  commandId: string,
  payload: { impactId: string; artifactId: string; artifactRevision: number; sourceRef: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const artifacts = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_artifacts
            WHERE id = ${p["artifactId"]} AND revision = ${p["artifactRevision"]}`,
      );
      if (artifacts.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Artifact revision not found");
      }
      await ctx.emit({
        streamName: `dopaiosImpact-${p["impactId"]}`,
        type: "ImpactRecordOpened",
        data: {
          impactId: p["impactId"],
          artifactId: p["artifactId"],
          artifactRevision: p["artifactRevision"],
          source: "source-changed",
          sourceRef: p["sourceRef"],
        },
        expectedVersion: -1,
      });
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactImpactChanged",
        data: {
          artifactId: p["artifactId"],
          revision: p["artifactRevision"],
          impactStatus: "impact-pending",
        },
      });
      return { impactId: p["impactId"] as string, impactStatus: "impact-pending" };
    },
  });
}

export type ExceptionDisposition =
  | { kind: "close"; basis: string }
  | {
      kind: "replace";
      condition: {
        conditionId: string;
        scope: Json;
        risk: string;
        owner: string;
        deadline: string;
        closureCriteria: string;
        blocksNextStep: boolean;
      };
    };

// Quyết định trên Gói EXCEPTION (SFR-034). approve: tái xác nhận — disposition
// tường minh cho condition quá hạn TRONG CÙNG transaction (đóng có căn cứ
// hoặc condition thay thế đủ trường, owner + hạn mới) + kết luận keep-value
// cho impact record của sự kiện. reject: chấm dứt hiệu lực chấp nhận qua
// kết luận must-fix; re-entry point là null — đường tiếp là bản sửa.
export async function decideException(
  db: Db,
  commandId: string,
  payload: {
    packageId: string;
    outcome: "approve" | "reject";
    actor: string;
    conditionId: string;
    disposition?: ExceptionDisposition;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const packages = await queryRows<{ state: string; refs: Json; target: Json | null }>(
        ctx,
        sql`SELECT state, refs, target FROM dopaios_decision_packages
            WHERE id = ${p["packageId"]} AND revision = 1`,
      );
      if (packages.length === 0 || (packages[0].refs as Json)["kind"] !== "EXCEPTION") {
        throw new CommandRejectedError("ERR-PKG", "EXCEPTION package not found");
      }
      if (packages[0].state !== "OPEN") {
        throw new CommandRejectedError("SFR-047", "EXCEPTION package is no longer open");
      }
      const actors = await queryRows<{ capabilities: string[] }>(
        ctx,
        sql`SELECT capabilities FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (actors.length === 0 || !actors[0].capabilities.includes("governance-approver")) {
        throw new CommandRejectedError("ERR-CAPABILITY", "Deciding an exception requires governance-approver");
      }
      const { condition } = await loadConditionWithRecord(ctx, p["conditionId"] as string);
      if (condition.state !== "overdue") {
        throw new CommandRejectedError("ERR-CONDITION-STATE", "Exception decisions apply to overdue conditions");
      }
      const impactId = `IMP-${condition.id}`;
      const target = packages[0].target as { artifactId: string; revision: number };

      if (p["outcome"] === "approve") {
        const disposition = p["disposition"] as ExceptionDisposition | undefined;
        if (!disposition) {
          throw new CommandRejectedError(
            "SFR-034",
            "Approve requires an explicit disposition for the overdue condition in the same transaction",
          );
        }
        if (disposition.kind === "close") {
          if (!disposition.basis) {
            throw new CommandRejectedError("ERR-002", "Closing disposition requires a basis");
          }
          await ctx.emit({
            streamName: `dopaiosCondition-${condition.id}`,
            type: "ConditionClosed",
            data: {
              conditionId: condition.id,
              closedBy: p["actor"],
              closureEvidence: `exception-approve: ${disposition.basis}`,
            },
          });
        } else if (disposition.kind === "replace") {
          const replacement = disposition.condition;
          for (const field of ["conditionId", "scope", "risk", "owner", "deadline", "closureCriteria", "blocksNextStep"]) {
            if ((replacement as unknown as Json)[field] === undefined) {
              throw new CommandRejectedError("SFR-033", `Replacement condition is missing ${field}`);
            }
          }
          await ctx.emit({
            streamName: `dopaiosCondition-${condition.id}`,
            type: "ConditionClosed",
            data: {
              conditionId: condition.id,
              closedBy: p["actor"],
              closureEvidence: `exception-approve: thay bằng ${replacement.conditionId}`,
            },
          });
          await ctx.emit({
            streamName: `dopaiosCondition-${replacement.conditionId}`,
            type: "ConditionOpened",
            data: {
              conditionId: replacement.conditionId,
              recordId: condition.record_id,
              scope: replacement.scope,
              risk: replacement.risk,
              owner: replacement.owner,
              deadline: replacement.deadline,
              closureCriteria: replacement.closureCriteria,
              compensatingObligation: null,
              blocksNextStep: replacement.blocksNextStep,
            },
            expectedVersion: -1,
          });
        } else {
          throw new CommandRejectedError("ERR-002", "Unknown disposition kind");
        }
        await ctx.emit({
          streamName: `dopaiosImpact-${impactId}`,
          type: "ImpactRecordDispositioned",
          data: {
            impactId,
            conclusion: "keep-value",
            dispositionedBy: p["actor"],
            basis: "exception approve — tái xác nhận",
          },
        });
      } else if (p["outcome"] === "reject") {
        await ctx.emit({
          streamName: `dopaiosImpact-${impactId}`,
          type: "ImpactRecordDispositioned",
          data: {
            impactId,
            conclusion: "must-fix",
            dispositionedBy: p["actor"],
            basis: "exception reject — chấm dứt hiệu lực chấp nhận, đường tiếp là bản sửa (re-entry null)",
          },
        });
      } else {
        throw new CommandRejectedError("ERR-002", "Outcome must be approve or reject");
      }

      const status = await aggregateImpact(ctx, target.artifactId, target.revision);
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageRevisionStateChanged",
        data: { packageId: p["packageId"], revision: 1, state: "DECIDED" },
      });
      await ctx.emit({
        streamName: `dopaiosActionRequest-REQ-${p["packageId"]}`,
        type: "ActionRequestStateChanged",
        data: { requestId: `REQ-${p["packageId"]}`, state: "DECIDED", decidedBy: p["actor"] },
      });
      return { packageId: p["packageId"] as string, outcome: p["outcome"] as string, impactStatus: status };
    },
  });
}

// Hiệu lực approval để bước tiêu thụ (begin-implementation SPEC:682) đọc:
// đúng hash pin, artifact đang approved và impact ∈ {clear, reaffirmed}.
export async function isApprovalEffective(db: Db, recordId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT r.target_sha256, a.sha256, a.artifact_state, a.impact_status
    FROM dopaios_approval_records r
    JOIN dopaios_artifacts a ON a.id = r.target_id AND a.revision = r.target_revision
    WHERE r.id = ${recordId}
  `)) as unknown as Array<{
    target_sha256: string | null;
    sha256: string;
    artifact_state: string;
    impact_status: string;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0];
  return (
    row.target_sha256 === row.sha256 &&
    row.artifact_state === "approved" &&
    (row.impact_status === "clear" || row.impact_status === "reaffirmed")
  );
}
