import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";
import {
  applyOutputRevisionEntry,
  maybePassChecks,
  requireRunningRunOfWorkItem,
} from "./commands.js";
import { unsatisfiedDependencies } from "./graph-repo.js";
import {
  validateQualityContractPin,
  validateSourceRefs,
  type QualityContractRef,
  type SourceRef,
} from "./lifecycle.js";

// KC-14 B4: submit-fixture-revision — hàng `NONE (revision kế tiếp)` của bảng
// đầu ra FS-003. Bản sửa KHÔNG mở work-item: self-check và Review Evidence
// gắn vào CHÍNH phiên bản đầu ra trong cùng transaction (DEV-011); bản sửa
// gắn cùng dòng đầu ra/bước (giữ liên kết work-item của dòng), không mở lại
// work-item terminal; bản mới không kế thừa gói/yêu cầu/quyết định của bản
// cũ (SFR-030) — side effect thay thế bản cũ chạy nguyên tử qua
// applyOutputRevisionEntry (SFR-031/050).
//
// SFR-053: khi run đang dừng tại điểm phê duyệt khai đầu ra này và bản sửa
// đạt trọn kiểm theo Hợp đồng chất lượng được pin, hệ thống tạo ĐÚNG MỘT Gói
// quyết định mới + ĐÚNG MỘT Yêu cầu quyết định mới cho điểm đó — caller
// (test harness đóng vai runtime) truyền định danh tất định của cặp này.
// Bản sửa CHƯA đủ kiểm (hợp đồng đòi thêm loại kiểm): giữ INDEPENDENT_CHECK,
// bổ sung bằng chứng qua attach-check-evidence rồi trình điểm bằng
// advance-to-decision — giới hạn slice ghi trong hồ sơ.

type Json = Record<string, unknown>;

export async function submitFixtureRevision(
  db: Db,
  commandId: string,
  payload: {
    outputId: string;
    newRevision: number;
    contentSha256: string;
    outputType: string;
    qualityContractRef: QualityContractRef;
    sourceRefs?: SourceRef[];
    selfCheckEvidence: { ref: string; sha256: string; targetSha256: string; by: string };
    expectedSelfCheckSha256: string;
    reviewEvidence: { ref: string; sha256: string; targetSha256: string; conclusion: string; by: string };
    expectedReviewSha256: string;
    decisionPoint?: {
      packageId: string;
      newPackageRevision: number;
      refs: Json;
      newDecisionRequestId: string;
    };
  },
): Promise<CommandResult> {
  // KC-15 B5 (major review lens 2): lệnh này mang guard re-entry trọng yếu
  // (pin nguồn superseded bị chặn) — mọi rejection phải để vệt audit bất
  // biến như các lệnh anh em (SQR-001); đổi executeCommand trần sang audited.
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const prior = (await ctx.tx.execute(sql`
        SELECT revision, state, work_item_id FROM dopaios_output_versions
        WHERE id = ${p["outputId"]} ORDER BY revision DESC LIMIT 1
      `)) as unknown as Array<{ revision: number; state: string; work_item_id: string }>;
      if (prior.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "submit-fixture-revision requires a prior version of the output");
      }
      // SFR-045: bản sửa chỉ hợp lệ khi bản trước đã đứng ở trạng thái chờ
      // hoặc đã có quyết định — không chen ngang bản đang trong chuỗi kiểm.
      const allowedPriorStates = ["AWAITING_DECISION", "APPROVED", "ACCEPTED", "REJECTED"];
      if (!allowedPriorStates.includes(prior[0].state)) {
        throw new CommandRejectedError(
          "SFR-045",
          `Prior version is ${prior[0].state} — a revision may enter only over ${allowedPriorStates.join("/")}`,
        );
      }
      const runId = await requireRunningRunOfWorkItem(ctx, prior[0].work_item_id);

      // Ready-check tương đương của bản sửa: pin Hợp đồng chất lượng hiệu lực.
      const requiredChecks = await validateQualityContractPin(
        ctx,
        p["qualityContractRef"] as QualityContractRef,
        p["outputType"] as string,
      );
      // KC-15 B3 (QD-4): pin nguồn của bản sửa kiểm cùng chuẩn — nguồn
      // superseded bị chặn, buộc re-entry qua đúng revision nguồn được duyệt.
      await validateSourceRefs(ctx, p["sourceRefs"] as SourceRef[] | undefined);
      // KC-15 B5 (major review lens 1): đường vào trục thứ hai cũng phải qua
      // guard đồ thị — bản sửa của dòng thuộc work-item hạ nguồn đang bị chặn
      // không được vào trục khi thượng nguồn chưa thỏa.
      const revUnsatisfied = await unsatisfiedDependencies(ctx, prior[0].work_item_id);
      if (revUnsatisfied.length > 0) {
        throw new CommandRejectedError(
          "ERR-DEP-UNSATISFIED",
          `Revision ready-check: unsatisfied dependencies — ${revUnsatisfied
            .map((u) => `${u.dependsOnWorkItemId}:${u.reason}`)
            .join(", ")}`,
        );
      }

      // Thành phần bản sửa phải đúng hash đã pin trong gói fixture (SFR-020,
      // DEV-011/DEV-012) — thiếu hoặc sai là chặn TẠI CỬA, không ghi phiên bản.
      const selfCheck = p["selfCheckEvidence"] as {
        ref: string;
        sha256: string;
        targetSha256: string;
        by: string;
      };
      const review = p["reviewEvidence"] as {
        ref: string;
        sha256: string;
        targetSha256: string;
        conclusion: string;
        by: string;
      };
      if (!selfCheck?.ref || !selfCheck?.sha256 || !selfCheck?.targetSha256 || !selfCheck?.by) {
        throw new CommandRejectedError("SFR-020", "Revision self-check evidence is missing required fields");
      }
      if (!review?.ref || !review?.sha256 || !review?.targetSha256 || !review?.conclusion || !review?.by) {
        throw new CommandRejectedError("SFR-020", "Revision Review Evidence is missing required fields");
      }
      if (review.conclusion !== "ready") {
        throw new CommandRejectedError("SFR-020", "Review Evidence with a not-ready conclusion is refused at the door");
      }
      if (selfCheck.sha256 !== (p["expectedSelfCheckSha256"] as string)) {
        throw new CommandRejectedError("SFR-020", "Revision self-check evidence does not match the pinned hash");
      }
      if (review.sha256 !== (p["expectedReviewSha256"] as string)) {
        throw new CommandRejectedError("SFR-020", "Revision Review Evidence does not match the pinned hash");
      }
      const contentSha = p["contentSha256"] as string;
      if (selfCheck.targetSha256 !== contentSha || review.targetSha256 !== contentSha) {
        throw new CommandRejectedError("SFR-020", "Revision evidence does not target the revision content");
      }
      // DEV-012: người kiểm độc lập của bản sửa khác người tự kiểm.
      if (review.by === selfCheck.by) {
        throw new CommandRejectedError("SFR-019", "Reviewer of the revision must differ from the self-check author");
      }

      // Vào trục DRAFT → SUBMITTED + side effect thay thế bản cũ (nguyên tử).
      const entry = await applyOutputRevisionEntry(ctx, {
        outputId: p["outputId"] as string,
        revision: p["newRevision"] as number,
        workItemId: prior[0].work_item_id,
        contentSha256: contentSha,
        qualityContractRef: p["qualityContractRef"] as unknown as Json,
        sourceRefs: p["sourceRefs"] as SourceRef[] | undefined,
      });

      // Binding bằng chứng trên chính phiên bản (DEV-011) + hai hàng
      // validate runtime tự động trong cùng lệnh.
      const outputStream = `dopaiosOutput-${p["outputId"]}`;
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionCheckEvidenceAdded",
        data: { outputId: p["outputId"], revision: p["newRevision"], checkKey: "self-check", evidence: selfCheck },
      });
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["newRevision"], state: "SELF_CHECK" },
      });
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionCheckEvidenceAdded",
        data: {
          outputId: p["outputId"],
          revision: p["newRevision"],
          checkKey: "independent-review",
          evidence: review,
        },
      });
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["newRevision"], state: "INDEPENDENT_CHECK" },
      });
      const checks = await maybePassChecks(ctx, {
        outputId: p["outputId"] as string,
        outputRevision: p["newRevision"] as number,
      });

      // SFR-053: bản hiện hành mới đạt kiểm trong lúc run đang dừng tại điểm
      // phê duyệt → AWAITING_DECISION + đúng một Gói mới + một Yêu cầu mới.
      const decisionPoint = p["decisionPoint"] as
        | { packageId: string; newPackageRevision: number; refs: Json; newDecisionRequestId: string }
        | undefined;
      let finalState = checks.passed ? "CHECK_PASSED" : "INDEPENDENT_CHECK";
      if (checks.passed && decisionPoint) {
        const priorPkg = (await ctx.tx.execute(sql`
          SELECT state FROM dopaios_decision_packages
          WHERE id = ${decisionPoint.packageId} AND revision = ${decisionPoint.newPackageRevision - 1}
        `)) as unknown as Array<{ state: string }>;
        if (priorPkg.length === 0) {
          throw new CommandRejectedError(
            "SFR-053",
            `Decision point package revision ${decisionPoint.newPackageRevision - 1} does not exist`,
          );
        }
        if (priorPkg[0].state === "OPEN" || priorPkg[0].state === "AWAITING_INFO") {
          throw new CommandRejectedError(
            "SFR-053",
            "Prior package revision is still open after invalidation — inconsistent decision point",
          );
        }
        await ctx.emit({
          streamName: outputStream,
          type: "OutputVersionStateChanged",
          data: { outputId: p["outputId"], revision: p["newRevision"], state: "AWAITING_DECISION" },
        });
        await ctx.emit({
          streamName: `dopaiosDecisionPackage-${decisionPoint.packageId}`,
          type: "DecisionPackageAssembled",
          data: {
            packageId: decisionPoint.packageId,
            revision: decisionPoint.newPackageRevision,
            refs: decisionPoint.refs,
            target: { outputId: p["outputId"], revision: p["newRevision"] },
          },
        });
        await ctx.emit({
          streamName: `dopaiosActionRequest-${decisionPoint.newDecisionRequestId}`,
          type: "ActionRequestCreated",
          data: {
            requestId: decisionPoint.newDecisionRequestId,
            kind: "decision",
            runId,
            packageId: decisionPoint.packageId,
            packageRevision: decisionPoint.newPackageRevision,
          },
          expectedVersion: -1,
        });
        finalState = "AWAITING_DECISION";
      }

      return {
        outputId: p["outputId"] as string,
        newRevision: p["newRevision"] as number,
        replacesRevision: entry.replacesRevision,
        state: finalState,
        missingChecks: checks.missing,
        requiredChecks,
      };
    },
  });
}
