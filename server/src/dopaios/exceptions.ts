import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  executeCommand,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-14 B5: hai hàng `ACCEPTED` của bảng đầu ra FS-003 (d.1604-1605) và hủy
// run (SFR-041/051/057, FX-02-N15) trên trục Phiên bản đầu ra.
//
//  - Condition của chấp-nhận-ngoại-lệ quá hạn (SFR-034): revision GIỮ
//    `ACCEPTED` — lifecycle không viết lại; approval hết hiệu lực cho phạm
//    vi phụ thuộc (invalidated_at/invalidation_reason); bước phụ thuộc bị
//    tái chặn và run quay về dừng tại điểm phê duyệt (SFR-050); Gói quyết
//    định `EXCEPTION` target CHÍNH phiên bản này tái pin bằng chứng kiểm
//    của phiên bản + đúng một Yêu cầu `exception` định tuyến người quyết
//    định của run. Idempotency: condition ID × kỳ quá hạn.
//  - record-approval trên Gói `EXCEPTION`: approve = tái xác nhận + mở lại
//    đúng bước bị tái chặn + disposition tường minh condition trong CÙNG
//    transaction; reject = chấm dứt hiệu lực chấp nhận, kết thúc nghĩa vụ
//    theo dõi, KHÔNG mở lại bước, KHÔNG đòi điểm tái nhập — đường tiếp là
//    bản sửa hoặc hủy run; request-more-information = không đổi hiệu lực +
//    Yêu cầu clarification Pod-của-run (SFR-046).
//  - cancel-test-run: nguyên tử — run CANCELLED; mọi work-item chưa terminal
//    CANCELLED (không tính sản lượng); phiên bản không terminal GIỮ NGUYÊN
//    trạng thái (trục đầu ra không có trạng thái hủy — PRD Mục 3); MỌI nghĩa
//    vụ mở phải có disposition tường minh, thiếu một cái là toàn lệnh thất
//    bại (SFR-057/058).

type Json = Record<string, unknown>;

async function queryRows<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

// Watchdog SFR-034 mức run: quét condition open quá hạn của approval CÒN
// hiệu lực trên trục đầu ra (target là phiên bản đầu ra), thuộc run chưa
// terminal — run terminal thì bộ máy quá hạn không kích hoạt nữa (SFR-057).
export async function detectOverdueRunConditions(
  db: Db,
  input: { nowMs: number },
): Promise<Array<{ conditionId: string; exceptionPackageId: string }>> {
  const overdue = (await db.execute(sql`
    SELECT c.id, c.deadline, r.id AS record_id, r.target_id, r.target_revision,
           o.work_item_id, w.run_id, run.decider
    FROM dopaios_conditions c
    JOIN dopaios_approval_records r ON r.id = c.record_id
    JOIN dopaios_output_versions o ON o.id = r.target_id AND o.revision = r.target_revision
    JOIN dopaios_work_items w ON w.id = o.work_item_id
    JOIN dopaios_sop_runs run ON run.id = w.run_id
    WHERE c.state = 'open' AND c.deadline < to_timestamp(${input.nowMs / 1000})
      AND r.invalidated_at IS NULL
      AND run.state NOT IN ('COMPLETED', 'CANCELLED')
    ORDER BY c.id
  `)) as unknown as Array<{
    id: string;
    deadline: Date | string;
    record_id: string;
    target_id: string;
    target_revision: number;
    run_id: string;
  }>;

  const declared: Array<{ conditionId: string; exceptionPackageId: string }> = [];
  for (const row of overdue) {
    const deadlineMs = new Date(row.deadline).getTime();
    const exceptionPackageId = `EXC-RUN-${row.id}`;
    try {
      await executeAuditedCommand(db, {
        commandId: `OVERDUE-RUN-${row.id}-${deadlineMs}`,
        payload: { conditionId: row.id, deadlineMs },
      handler: async (ctx, p) => {
        const conditionId = p["conditionId"] as string;
        // KC-14 B7 (blocker review — cùng pattern requeueExpiredActivations):
        // danh sách quét nằm NGOÀI transaction — handler phải RE-CHECK trên
        // snapshot của chính transaction: condition còn open, approval còn
        // hiệu lực, run chưa terminal; closeCondition/cancelTestRun/bản sửa
        // chen giữa thì lệnh này phải chết, không tuyên bố quá hạn oan.
        const fresh = await queryRows<{ c_state: string; invalidated: boolean; run_state: string }>(
          ctx,
          sql`SELECT c.state AS c_state, (r.invalidated_at IS NOT NULL) AS invalidated, run.state AS run_state
              FROM dopaios_conditions c
              JOIN dopaios_approval_records r ON r.id = c.record_id
              JOIN dopaios_output_versions o ON o.id = r.target_id AND o.revision = r.target_revision
              JOIN dopaios_work_items w ON w.id = o.work_item_id
              JOIN dopaios_sop_runs run ON run.id = w.run_id
              WHERE c.id = ${conditionId}
              FOR UPDATE OF c, r`,
        );
        if (
          fresh.length === 0 ||
          fresh[0].c_state !== "open" ||
          fresh[0].invalidated ||
          fresh[0].run_state === "COMPLETED" ||
          fresh[0].run_state === "CANCELLED"
        ) {
          throw new CommandRejectedError(
            "ERR-OVERDUE-STALE",
            `Condition ${conditionId} is no longer an open obligation of an effective approval on a live run`,
          );
        }
        // Tái pin bằng chứng kiểm của CHÍNH phiên bản vào gói EXCEPTION
        // (SFR-034: cùng ID@revision@hash như gói gốc).
        const version = await queryRows<{ check_evidence: Json | null; content_sha256: string }>(
          ctx,
          sql`SELECT check_evidence, content_sha256 FROM dopaios_output_versions
              WHERE id = ${row.target_id} AND revision = ${row.target_revision}`,
        );
        await ctx.emit({
          streamName: `dopaiosCondition-${conditionId}`,
          type: "ConditionOverdueDeclared",
          data: { conditionId },
        });
        await ctx.emit({
          streamName: `dopaiosApprovalRecord-${row.record_id}`,
          type: "ApprovalInvalidated",
          data: {
            recordId: row.record_id,
            reason: `condition ${conditionId} quá hạn chưa đóng — hiệu lực treo cho phạm vi phụ thuộc (SFR-034)`,
          },
        });
        // SFR-050: tái chặn bước đã mở theo approval này — run quay về dừng
        // tại điểm phê duyệt.
        const steps = await queryRows<{ run_id: string; step_id: string }>(
          ctx,
          sql`SELECT run_id, step_id FROM dopaios_run_steps
              WHERE opened_by_record_id = ${row.record_id} AND state = 'open'
              ORDER BY run_id, step_id`,
        );
        for (const step of steps) {
          await ctx.emit({
            streamName: `dopaiosRunStep-${step.run_id}-${step.step_id}`,
            type: "RunStepReblocked",
            data: { runId: step.run_id, stepId: step.step_id },
          });
        }
        await ctx.emit({
          streamName: `dopaiosDecisionPackage-${exceptionPackageId}`,
          type: "DecisionPackageAssembled",
          data: {
            packageId: exceptionPackageId,
            revision: 1,
            refs: {
              kind: "EXCEPTION",
              conditionId,
              sourceRecordId: row.record_id,
              repinnedEvidence: version[0]?.check_evidence ?? null,
              targetContentSha256: version[0]?.content_sha256 ?? null,
            },
            target: { outputId: row.target_id, revision: row.target_revision },
            fields: {
              kind: "EXCEPTION",
              decisionAsk: `Condition ${conditionId} của chấp-nhận-ngoại-lệ quá hạn chưa đóng — tái xác nhận, chấm dứt hay cần bổ sung?`,
              context: "hệ thống điền từ gói gốc cộng bối cảnh quá hạn (SFR-034)",
            },
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosActionRequest-REQ-${exceptionPackageId}`,
          type: "ActionRequestCreated",
          data: {
            requestId: `REQ-${exceptionPackageId}`,
            kind: "exception",
            runId: row.run_id,
            packageId: exceptionPackageId,
            packageRevision: 1,
          },
          expectedVersion: -1,
        });
        return { conditionId, exceptionPackageId, runId: row.run_id };
        },
      });
      declared.push({ conditionId: row.id, exceptionPackageId });
    } catch (error) {
      // Ca stale (re-check trượt) đã để vệt audit — watchdog đi tiếp,
      // không sập cả tick.
      if (!(error instanceof CommandRejectedError)) throw error;
    }
  }
  return declared;
}

export type RunExceptionDisposition =
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

// record-approval trên Gói EXCEPTION của trục đầu ra (hàng d.1605).
export async function decideRunException(
  db: Db,
  commandId: string,
  payload: {
    packageId: string;
    packageRevision?: number;
    outcome: "approve" | "reject" | "request-more-information";
    actor: string;
    recordId: string;
    disposition?: RunExceptionDisposition;
    requiredInfo?: string;
    clarificationRequestId?: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const packageRevision = (p["packageRevision"] as number | undefined) ?? 1;
      const packages = await queryRows<{ state: string; refs: Json; target: Json | null }>(
        ctx,
        sql`SELECT state, refs, target FROM dopaios_decision_packages
            WHERE id = ${p["packageId"]} AND revision = ${packageRevision}`,
      );
      if (packages.length === 0 || (packages[0].refs as Json)["kind"] !== "EXCEPTION") {
        throw new CommandRejectedError("ERR-PKG", "Run EXCEPTION package not found");
      }
      if (packages[0].state !== "OPEN") {
        throw new CommandRejectedError("SFR-047", `EXCEPTION package is ${packages[0].state} — not open`);
      }
      const target = packages[0].target as { outputId: string; revision: number };
      const version = await queryRows<{ state: string; work_item_id: string }>(
        ctx,
        sql`SELECT state, work_item_id FROM dopaios_output_versions
            WHERE id = ${target.outputId} AND revision = ${target.revision}`,
      );
      if (version.length === 0 || version[0].state !== "ACCEPTED") {
        throw new CommandRejectedError("ERR-STATE", "EXCEPTION decisions apply to the ACCEPTED version only");
      }
      // Run chưa terminal (SFR-057) — sự kiện quá hạn/quyết định ngoại lệ
      // chạy cả khi run BLOCKED, chỉ terminal mới từ chối.
      const run = await queryRows<{ id: string; state: string; decider: string; pod: string }>(
        ctx,
        sql`SELECT r.id, r.state, r.decider, r.pod
            FROM dopaios_sop_runs r
            JOIN dopaios_work_items w ON w.run_id = r.id
            WHERE w.id = ${version[0].work_item_id}`,
      );
      if (run.length === 0 || run[0].state === "COMPLETED" || run[0].state === "CANCELLED") {
        throw new CommandRejectedError("SFR-057", "Run of the version is terminal — command refused");
      }
      if ((p["actor"] as string) !== run[0].decider) {
        throw new CommandRejectedError("SFR-042", "Actor is not the pinned decider of this run");
      }
      const actors = await queryRows<{ kind: string; active: boolean }>(
        ctx,
        sql`SELECT kind, active FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (actors.length === 0) {
        throw new CommandRejectedError("ERR-ACTOR", "Decider is not a registered active actor");
      }
      if (actors[0].kind !== "human") {
        throw new CommandRejectedError("SFR-023", "AI holds no exception-decision authority");
      }
      const refs = packages[0].refs as { conditionId: string; sourceRecordId: string };
      const conditions = await queryRows<{ id: string; state: string }>(
        ctx,
        sql`SELECT id, state FROM dopaios_conditions WHERE id = ${refs.conditionId}`,
      );
      if (conditions.length === 0 || conditions[0].state !== "overdue") {
        throw new CommandRejectedError("ERR-CONDITION-STATE", "Exception decisions apply to overdue conditions");
      }

      // KC-14 B7 (major review): quyết định đóng ĐÚNG yêu cầu của revision
      // gói đang ký — sau vòng RMI, yêu cầu hiện hành là yêu cầu do
      // answerClarification tạo, không phải yêu cầu gốc của watchdog.
      const linkedRequest = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_action_requests
            WHERE package_id = ${p["packageId"]} AND package_revision = ${packageRevision}
              AND kind = 'exception'
              AND state NOT IN ('DECIDED', 'SUPERSEDED-TARGET-CHANGED')
            ORDER BY id LIMIT 1`,
      );
      if (linkedRequest.length === 0) {
        throw new CommandRejectedError(
          "SFR-048",
          "No open exception request is linked to this package revision",
        );
      }

      const outcome = p["outcome"] as string;
      if (outcome === "approve") {
        const disposition = p["disposition"] as RunExceptionDisposition | undefined;
        if (!disposition) {
          throw new CommandRejectedError(
            "SFR-034",
            "Approve requires an explicit disposition for the overdue condition in the same transaction",
          );
        }
        await ctx.emit({
          streamName: `dopaiosApprovalRecord-${p["recordId"]}`,
          type: "ApprovalRecorded",
          data: {
            recordId: p["recordId"],
            packageId: p["packageId"],
            packageRevision,
            outcome: "approve",
            pinnedRefs: packages[0].refs,
            actor: p["actor"],
            targetId: target.outputId,
            targetRevision: target.revision,
            openedStep: null,
          },
          expectedVersion: -1,
        });
        if (disposition.kind === "close") {
          if (!disposition.basis) {
            throw new CommandRejectedError("ERR-002", "Closing disposition requires a basis");
          }
          await ctx.emit({
            streamName: `dopaiosCondition-${refs.conditionId}`,
            type: "ConditionClosed",
            data: {
              conditionId: refs.conditionId,
              closedBy: p["actor"],
              closureEvidence: `exception-approve: ${disposition.basis}`,
            },
          });
        } else if (disposition.kind === "replace") {
          const replacement = disposition.condition;
          for (const field of [
            "conditionId",
            "scope",
            "risk",
            "owner",
            "deadline",
            "closureCriteria",
            "blocksNextStep",
          ]) {
            if ((replacement as unknown as Json)[field] === undefined) {
              throw new CommandRejectedError("SFR-033", `Replacement condition is missing ${field}`);
            }
          }
          // KC-14 B7 (minor review): tái xác nhận MỞ LẠI bước — condition
          // thay thế chặn bước thì mâu thuẫn với chính quyết định (SFR-022).
          if (replacement.blocksNextStep === true) {
            throw new CommandRejectedError(
              "SFR-022",
              "A replacement condition with blocks_next_step: true contradicts reaffirmation",
            );
          }
          await ctx.emit({
            streamName: `dopaiosCondition-${refs.conditionId}`,
            type: "ConditionClosed",
            data: {
              conditionId: refs.conditionId,
              closedBy: p["actor"],
              closureEvidence: `exception-approve: thay bằng ${replacement.conditionId}`,
            },
          });
          await ctx.emit({
            streamName: `dopaiosCondition-${replacement.conditionId}`,
            type: "ConditionOpened",
            data: {
              conditionId: replacement.conditionId,
              recordId: p["recordId"],
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
        // Mở lại ĐÚNG bước bị tái chặn theo record gốc (SFR-029) — record
        // EXCEPTION mới là căn cứ mở.
        const steps = await queryRows<{ run_id: string; step_id: string }>(
          ctx,
          sql`SELECT run_id, step_id FROM dopaios_run_steps
              WHERE opened_by_record_id = ${refs.sourceRecordId} AND state = 'reblocked'
              ORDER BY run_id, step_id`,
        );
        for (const step of steps) {
          await ctx.emit({
            streamName: `dopaiosRunStep-${step.run_id}-${step.step_id}`,
            type: "RunStepOpened",
            data: { runId: step.run_id, stepId: step.step_id, recordId: p["recordId"] },
          });
        }
      } else if (outcome === "reject") {
        // Chấm dứt hiệu lực chấp nhận: revision GIỮ ACCEPTED, không mở lại
        // bước, không điểm tái nhập; nghĩa vụ theo dõi condition kết thúc.
        await ctx.emit({
          streamName: `dopaiosApprovalRecord-${p["recordId"]}`,
          type: "ApprovalRecorded",
          data: {
            recordId: p["recordId"],
            packageId: p["packageId"],
            packageRevision,
            outcome: "reject",
            pinnedRefs: packages[0].refs,
            actor: p["actor"],
            targetId: target.outputId,
            targetRevision: target.revision,
            reEntryPoint: null,
            findings: [{ terminatesAcceptance: true, basis: "exception reject — đường tiếp là bản sửa hoặc hủy run (SFR-034/045)" }],
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosCondition-${refs.conditionId}`,
          type: "ConditionClosed",
          data: {
            conditionId: refs.conditionId,
            closedBy: p["actor"],
            closureEvidence: "exception reject — chấm dứt hiệu lực chấp nhận, nghĩa vụ theo dõi kết thúc (SFR-034)",
          },
        });
      } else if (outcome === "request-more-information") {
        if (!p["requiredInfo"] || !p["clarificationRequestId"]) {
          throw new CommandRejectedError("SFR-046", "RMI requires the missing part and the clarification request id");
        }
        await ctx.emit({
          streamName: `dopaiosApprovalRecord-${p["recordId"]}`,
          type: "ApprovalRecorded",
          data: {
            recordId: p["recordId"],
            packageId: p["packageId"],
            packageRevision,
            outcome: "request-more-information",
            pinnedRefs: packages[0].refs,
            actor: p["actor"],
            targetId: target.outputId,
            targetRevision: target.revision,
            findings: [{ requiredInfo: p["requiredInfo"] }],
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: `dopaiosActionRequest-${p["clarificationRequestId"]}`,
          type: "ActionRequestCreated",
          data: {
            requestId: p["clarificationRequestId"],
            kind: "clarification",
            runId: run[0].id,
            packageId: p["packageId"],
            packageRevision,
          },
          expectedVersion: -1,
        });
      } else {
        throw new CommandRejectedError("ERR-002", "Outcome must be approve, reject or request-more-information");
      }

      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageRevisionStateChanged",
        data: {
          packageId: p["packageId"],
          revision: packageRevision,
          state: outcome === "request-more-information" ? "AWAITING_INFO" : "DECIDED",
        },
      });
      await ctx.emit({
        streamName: `dopaiosActionRequest-${linkedRequest[0].id}`,
        type: "ActionRequestStateChanged",
        data: { requestId: linkedRequest[0].id, state: "DECIDED", decidedBy: p["actor"] },
      });
      return {
        packageId: p["packageId"] as string,
        outcome,
        versionState: "ACCEPTED",
        decidedRequestId: linkedRequest[0].id,
      };
    },
  });
}

// cancel-test-run (SFR-041/051/057/058 — FX-02-N15): hủy nguyên tử với
// disposition tường minh cho TỪNG nghĩa vụ mở. Nghĩa vụ mở gồm: phiên bản
// đầu ra không terminal, Yêu cầu chưa kết thúc, condition đang open/overdue
// của approval trên phiên bản thuộc run.
export async function cancelTestRun(
  db: Db,
  commandId: string,
  payload: {
    runId: string;
    actor: string;
    reason: string;
    dispositions: Record<string, string>;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const run = await queryRows<{ state: string; decider: string }>(
        ctx,
        sql`SELECT state, decider FROM dopaios_sop_runs WHERE id = ${p["runId"]}`,
      );
      if (run.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Run not found");
      }
      if (run[0].state === "COMPLETED" || run[0].state === "CANCELLED") {
        throw new CommandRejectedError("SFR-057", `Run is already terminal (${run[0].state})`);
      }
      if ((p["actor"] as string) !== run[0].decider) {
        throw new CommandRejectedError("SFR-051", "Cancel requires the pinned authority of the run");
      }
      // KC-14 B7 (major review): hủy là quyết định có thẩm quyền — actor
      // phải là NGƯỜI đã đăng ký và đang active (SFR-023), không chỉ trùng
      // chuỗi decider.
      const cancelActor = await queryRows<{ kind: string }>(
        ctx,
        sql`SELECT kind FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (cancelActor.length === 0) {
        throw new CommandRejectedError("ERR-ACTOR", "Cancel authority is not a registered active actor");
      }
      if (cancelActor[0].kind !== "human") {
        throw new CommandRejectedError("SFR-023", "AI holds no cancel authority");
      }
      if (!p["reason"]) {
        throw new CommandRejectedError("ERR-002", "Cancel requires an explicit reason");
      }
      const dispositions = (p["dispositions"] as Record<string, string>) ?? {};

      // Kiểm ĐỦ disposition trước khi ghi bất kỳ event nào (SFR-057:
      // thiếu một disposition thì toàn lệnh thất bại nguyên tử).
      const openVersions = await queryRows<{ id: string; revision: number; state: string }>(
        ctx,
        sql`SELECT o.id, o.revision, o.state
            FROM dopaios_output_versions o
            JOIN dopaios_work_items w ON w.id = o.work_item_id
            WHERE w.run_id = ${p["runId"]}
              AND o.state NOT IN ('APPROVED', 'ACCEPTED', 'REJECTED', 'REWORK_REQUIRED')
            ORDER BY o.id, o.revision`,
      );
      const openRequests = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_action_requests
            WHERE run_id = ${p["runId"]}
              AND state NOT IN ('DECIDED', 'CLOSED', 'SUPERSEDED-TARGET-CHANGED')
            ORDER BY id`,
      );
      const openConditions = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT c.id
            FROM dopaios_conditions c
            JOIN dopaios_approval_records r ON r.id = c.record_id
            JOIN dopaios_output_versions o ON o.id = r.target_id AND o.revision = r.target_revision
            JOIN dopaios_work_items w ON w.id = o.work_item_id
            WHERE w.run_id = ${p["runId"]} AND c.state <> 'closed'
              -- KC-14 B7 (minor review): approval đã vô hiệu thì nghĩa vụ
              -- theo dõi condition đã kết thúc (SFR-016/031) — không đòi
              -- disposition thừa, nhất quán với watchdog.
              AND r.invalidated_at IS NULL
            ORDER BY c.id`,
      );
      const obligations = [
        ...openVersions.map((v) => `output:${v.id}@${v.revision}`),
        ...openRequests.map((r) => `request:${r.id}`),
        ...openConditions.map((c) => `condition:${c.id}`),
      ];
      const missing = obligations.filter((key) => !dispositions[key]);
      if (missing.length > 0) {
        throw new CommandRejectedError(
          "SFR-057",
          `Cancel requires a disposition for every open obligation — missing: ${missing.join(", ")}`,
        );
      }

      await ctx.emit({
        streamName: `dopaiosSopRun-${p["runId"]}`,
        type: "SopRunStateChanged",
        data: { runId: p["runId"], state: "CANCELLED" },
      });
      // Record hủy bất biến mang lý do + disposition từng nghĩa vụ (SFR-057);
      // audit-only — không projection, đọc lại từ event log.
      await ctx.emit({
        streamName: `dopaiosSopRun-${p["runId"]}`,
        type: "RunCancellationRecorded",
        data: {
          runId: p["runId"],
          reason: p["reason"],
          authority: p["actor"],
          dispositions,
          obligations,
        },
      });
      // Work-item chưa terminal → CANCELLED (terminal riêng, không tính sản
      // lượng — PRD Mục 3); phiên bản đầu ra GIỮ NGUYÊN trạng thái.
      const openWorkItems = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_work_items
            WHERE run_id = ${p["runId"]} AND state NOT IN ('COMPLETED', 'CANCELLED')
            ORDER BY id`,
      );
      for (const workItem of openWorkItems) {
        await ctx.emit({
          streamName: `dopaiosWorkItem-${workItem.id}`,
          type: "WorkItemStateChanged",
          data: { workItemId: workItem.id, state: "CANCELLED" },
        });
      }
      return {
        runId: p["runId"] as string,
        state: "CANCELLED",
        cancelledWorkItems: openWorkItems.length,
        dispositionedObligations: obligations.length,
      };
    },
  });
}
