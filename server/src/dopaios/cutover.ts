import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandContext,
  type CommandResult,
  CommandRejectedError,
  payloadSha256,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-17 B2: cutover bootstrap→runtime theo PRD Mục 6.1 (d.318–320) và
// AC-V1-10, trên fixture FX-05 — cutover GIẢ LẬP, không phải cutover DS-1
// thật; tiền điều kiện DS-1 biểu diễn bằng bốn cờ readiness (QD-1, PRD
// revision 3 d.402), không suy diễn nội dung FS-005/FS-006/Baseline/ADP-3.
//
//  - Guard hình dạng production (ASM-001): mọi tiền điều kiện đọc từ
//    projection/sổ cái trong CÙNG transaction SERIALIZABLE của
//    executeCommand KC-01; không tin trường caller tự khai khi đã có nguồn
//    ghi (bài học KC-14 B7). Nội dung Plan được đối chiếu content-addressed:
//    sha256 trên đúng byte UTF-8 phải khớp cả tham chiếu lẫn sổ cái artifact.
//  - Approval `PILOT-CUTOVER` chỉ được TIÊU THỤ ở đây; ngữ nghĩa phê duyệt
//    thuộc KC-03 (ràng buộc 1 của lệnh mở KC-17).
//  - Đúng-một-lần (AC-V1-10): activation event/idempotency key CHÍNH LÀ
//    command id của execute-cutover (QD-5) — replay cùng key + cùng payload
//    trả kết quả cũ qua idempotency KC-01; cùng key khác payload bị
//    CommandPayloadMismatchError; key khác nhưng phạm vi đã chuyển bị guard
//    trạng thái chặn; unique index activation_key (0518) là phòng thủ
//    chiều sâu ngoài đường lệnh.
//  - Chỉ Cutover Record `effective` hợp lệ mới kết thúc bootstrap workflow
//    (PRD d.318): duy nhất executeCutover phát BootstrapWorkflowDisabled;
//    appendCutoverRecord không bao giờ chạm bootstrap (C08).

type Json = Record<string, unknown>;

export type ArtifactRef = { artifactId: string; revision: number; sha256: string };

// Bốn tiền điều kiện DS-1 theo PRD revision 3 d.402 (QD-1) — thứ tự cố định
// để thông điệp chặn tất định.
export const CUTOVER_READINESS_FLAGS = [
  "fs005_ready",
  "fs006_ready",
  "product_baseline_p1",
  "adp3",
] as const;

export const CUTOVER_RECORD_STATES = ["effective", "rolled-back", "completed"] as const;

export function sha256Utf8(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

async function rowsOf<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

async function oneOf<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | null> {
  const rows = await rowsOf<T>(ctx, query);
  return rows[0] ?? null;
}

function requireFields(p: Json, fields: readonly string[]): void {
  for (const field of fields) {
    if (p[field] === undefined || p[field] === null || p[field] === "") {
      throw new CommandRejectedError("ERR-002", `Thiếu trường bắt buộc: ${field}`);
    }
  }
}

async function requireActor(
  ctx: CommandContext,
  actorId: string,
  expectedKind: string,
  role: string,
): Promise<void> {
  const actor = await oneOf<{ id: string; kind: string; active: boolean }>(
    ctx,
    sql`SELECT id, kind, active FROM dopaios_actors WHERE id = ${actorId}`,
  );
  if (!actor || !actor.active) {
    throw new CommandRejectedError("ERR-ACTOR", `${role} ${actorId} chưa đăng ký hoặc không active`);
  }
  if (actor.kind !== expectedKind) {
    throw new CommandRejectedError(
      "ERR-ACTOR",
      `${role} ${actorId} phải có kind '${expectedKind}', đang là '${actor.kind}'`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bootstrap workflow giả lập (QD-3)

export async function registerBootstrapWorkflow(
  db: Db,
  commandId: string,
  payload: { workflowId: string; featureId: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["workflowId", "featureId"]);
      const existing = await oneOf<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_bootstrap_workflows WHERE id = ${p["workflowId"]}`,
      );
      if (existing) {
        throw new CommandRejectedError("ERR-STATE", `Bootstrap workflow ${p["workflowId"]} đã đăng ký`);
      }
      const byFeature = await oneOf<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_bootstrap_workflows WHERE feature_id = ${p["featureId"]}`,
      );
      if (byFeature) {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Feature ${p["featureId"]} đã có bootstrap workflow ${byFeature.id}`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosBootstrapWorkflow-${p["workflowId"]}`,
        type: "BootstrapWorkflowRegistered",
        data: { workflowId: p["workflowId"], featureId: p["featureId"] },
      });
      return { workflowId: p["workflowId"] as string, state: "ACTIVE" };
    },
  });
}

// Đường ghi trạng thái bootstrap (QD-3). Trước cutover `effective` đây là
// đường ghi hợp lệ; sau khi phạm vi đã chuyển, mọi lệnh ghi bị từ chối —
// "không còn đường ghi trạng thái song song cho phạm vi đã chuyển"
// (PRD d.318, tiêu chí KC-17). Event audit-only, không có projection.
export async function writeBootstrapState(
  db: Db,
  commandId: string,
  payload: { workflowId: string; entry: Json; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["workflowId", "entry", "actor"]);
      const workflow = await oneOf<{ id: string; state: string; disabled_by_ref: Json | null }>(
        ctx,
        sql`SELECT id, state, disabled_by_ref FROM dopaios_bootstrap_workflows WHERE id = ${p["workflowId"]}`,
      );
      if (!workflow) {
        throw new CommandRejectedError("ERR-TARGET", `Bootstrap workflow ${p["workflowId"]} không tồn tại`);
      }
      if (workflow.state === "DISABLED") {
        throw new CommandRejectedError(
          "ERR-CUTOVER-PARALLEL-WRITE",
          `Bootstrap workflow ${p["workflowId"]} đã bị vô hiệu bởi Cutover Record effective — không còn đường ghi trạng thái song song cho phạm vi đã chuyển`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosBootstrapWorkflow-${p["workflowId"]}`,
        type: "BootstrapStateWritten",
        data: { workflowId: p["workflowId"], entry: p["entry"], actor: p["actor"] },
      });
      return { accepted: true };
    },
  });
}

// Cờ readiness tiền điều kiện DS-1 (QD-1) — fixture đặt/tắt từng cờ.
export async function setCutoverReadiness(
  db: Db,
  commandId: string,
  payload: { featureId: string; flag: string; ready: boolean; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["featureId", "flag", "actor"]);
      if (typeof p["ready"] !== "boolean") {
        throw new CommandRejectedError("ERR-002", "Thiếu trường bắt buộc: ready (boolean)");
      }
      const flag = p["flag"] as string;
      if (!(CUTOVER_READINESS_FLAGS as readonly string[]).includes(flag)) {
        throw new CommandRejectedError(
          "ERR-002",
          `Cờ readiness không hợp lệ: ${flag} (hợp lệ: ${CUTOVER_READINESS_FLAGS.join(", ")})`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosCutoverReadiness-${p["featureId"]}`,
        type: "CutoverReadinessSet",
        data: { featureId: p["featureId"], flag, ready: p["ready"], actor: p["actor"] },
      });
      return { featureId: p["featureId"] as string, flag, ready: p["ready"] as boolean };
    },
  });
}

// ---------------------------------------------------------------------------
// Cutover Record — append có kiểm đủ trường (PRD d.318; ca âm C07).
// KHÔNG chạm bootstrap workflow: chỉ executeCutover, sau khi record
// `effective` được tạo trong cùng transaction, mới phát
// BootstrapWorkflowDisabled (C08).

export type CutoverRecordInput = {
  recordId: string;
  revision: number;
  featureId: string;
  state: (typeof CUTOVER_RECORD_STATES)[number];
  effectiveAt: string | null;
  authorityActor: string;
  executionActor: string;
  approvalRecordRef: Json;
  firstRuntimeWorkItemRef: string;
  runtimeActivationSnapshotRef: { snapshotId: string; revision: number; sha256: string };
  reconciliationRef: Json | null;
};

export async function appendCutoverRecord(
  ctx: CommandContext,
  input: CutoverRecordInput,
): Promise<{ sha256: string }> {
  const reject = (detail: string): never => {
    throw new CommandRejectedError("ERR-CUTOVER-RECORD", detail);
  };
  if (!input.recordId) reject("Cutover Record thiếu recordId");
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    reject(`Cutover Record ${input.recordId} có revision không hợp lệ: ${input.revision}`);
  }
  if (!input.featureId) reject(`Cutover Record ${input.recordId} thiếu feature_id`);
  if (!(CUTOVER_RECORD_STATES as readonly string[]).includes(input.state)) {
    reject(`Cutover Record ${input.recordId} có state không hợp lệ: ${input.state}`);
  }
  // PRD d.318: record ghi effective_at, authority/execution actor, Approval
  // Record, first_runtime_work_item_ref, runtime_activation_snapshot_ref —
  // từng trường thiếu bị từ chối đích danh (C07).
  if (input.state === "effective" && !input.effectiveAt) {
    reject(`Cutover Record ${input.recordId} state effective thiếu effective_at`);
  }
  if (!input.authorityActor) reject(`Cutover Record ${input.recordId} thiếu authority actor`);
  if (!input.executionActor) reject(`Cutover Record ${input.recordId} thiếu execution actor`);
  // B6 (finding lens 1 — C07 "sai actor"): actor của record đối chiếu sổ
  // actor ngay tại tầng append — mọi caller in-process đều bị kiểm, không
  // chỉ executeCutover.
  await requireActor(ctx, input.authorityActor, "human", "Authority actor của Cutover Record");
  await requireActor(ctx, input.executionActor, "system", "Execution actor của Cutover Record");
  if (!input.approvalRecordRef || !input.approvalRecordRef["recordId"]) {
    reject(`Cutover Record ${input.recordId} thiếu tham chiếu Approval Record`);
  }
  if (!input.firstRuntimeWorkItemRef) {
    reject(`Cutover Record ${input.recordId} thiếu first_runtime_work_item_ref`);
  }
  const snapshotRef = input.runtimeActivationSnapshotRef;
  if (!snapshotRef || !snapshotRef.snapshotId || !snapshotRef.revision || !snapshotRef.sha256) {
    reject(`Cutover Record ${input.recordId} thiếu runtime_activation_snapshot_ref`);
  }

  // Đối chiếu ref với nguồn ghi trong cùng transaction — sai revision/hash
  // bị từ chối (C07), không tin caller tự khai.
  const approval = await oneOf<{ id: string }>(
    ctx,
    sql`SELECT id FROM dopaios_approval_records WHERE id = ${input.approvalRecordRef["recordId"]}`,
  );
  if (!approval) {
    reject(`Cutover Record ${input.recordId} tham chiếu Approval Record không tồn tại: ${input.approvalRecordRef["recordId"]}`);
  }
  if (input.reconciliationRef !== null) {
    const reconRef = input.reconciliationRef as {
      reconciliationId?: string;
      revision?: number;
      sha256?: string;
    };
    if (!reconRef.reconciliationId || !reconRef.revision || !reconRef.sha256) {
      reject(`Cutover Record ${input.recordId} pin Reconciliation thiếu ID@revision@hash`);
    }
    const recon = await oneOf<{ sha256: string }>(
      ctx,
      sql`SELECT sha256 FROM dopaios_cutover_reconciliations
          WHERE id = ${reconRef.reconciliationId} AND revision = ${reconRef.revision}`,
    );
    if (!recon) {
      reject(`Cutover Record ${input.recordId} pin Reconciliation không tồn tại: ${reconRef.reconciliationId}@${reconRef.revision}`);
    }
    if (recon!.sha256 !== reconRef.sha256) {
      reject(`Cutover Record ${input.recordId} pin sai hash Reconciliation ${reconRef.reconciliationId}@${reconRef.revision}`);
    }
  }
  const snapshot = await oneOf<{ id: string; sha256: string }>(
    ctx,
    sql`SELECT id, sha256 FROM dopaios_runtime_activation_snapshots
        WHERE id = ${snapshotRef.snapshotId} AND revision = ${snapshotRef.revision}`,
  );
  if (!snapshot) {
    reject(`Cutover Record ${input.recordId} tham chiếu snapshot không tồn tại: ${snapshotRef.snapshotId}@${snapshotRef.revision}`);
  }
  if (snapshot!.sha256 !== snapshotRef.sha256) {
    reject(`Cutover Record ${input.recordId} pin sai hash snapshot ${snapshotRef.snapshotId}@${snapshotRef.revision}`);
  }
  // Revision phải nối tiếp lịch sử hiện có của đúng record id (lịch sử không
  // xóa — mỗi revision một hàng).
  const latest = await oneOf<{ revision: number }>(
    ctx,
    sql`SELECT revision FROM dopaios_cutover_records WHERE id = ${input.recordId} ORDER BY revision DESC LIMIT 1`,
  );
  const expectedRevision = (latest?.revision ?? 0) + 1;
  if (input.revision !== expectedRevision) {
    reject(
      `Cutover Record ${input.recordId} revision ${input.revision} không nối tiếp lịch sử (kỳ vọng ${expectedRevision})`,
    );
  }
  // B6 (finding 2 lens): bất biến "một effective sống mỗi feature" đặt tại
  // tầng append — record id KHÁC đang effective (revision mới nhất) thì
  // không nhận thêm record effective, dù caller là ai.
  if (input.state === "effective") {
    const otherEffective = await oneOf<{ id: string }>(
      ctx,
      sql`SELECT id FROM (
            SELECT DISTINCT ON (id) id, state
            FROM dopaios_cutover_records WHERE feature_id = ${input.featureId}
            ORDER BY id, revision DESC
          ) latest WHERE state = 'effective' AND id <> ${input.recordId} LIMIT 1`,
    );
    if (otherEffective) {
      reject(
        `Feature ${input.featureId} đã có Cutover Record effective ${otherEffective!.id} — một effective sống mỗi feature`,
      );
    }
  }

  const body: Json = {
    recordId: input.recordId,
    revision: input.revision,
    featureId: input.featureId,
    state: input.state,
    effectiveAt: input.effectiveAt,
    authorityActor: input.authorityActor,
    executionActor: input.executionActor,
    approvalRecordRef: input.approvalRecordRef,
    firstRuntimeWorkItemRef: input.firstRuntimeWorkItemRef,
    runtimeActivationSnapshotRef: snapshotRef as unknown as Json,
    reconciliationRef: input.reconciliationRef,
  };
  const sha256 = payloadSha256(body);
  await ctx.emit({
    streamName: `dopaiosCutoverRecord-${input.recordId}`,
    type: "CutoverRecordAppended",
    data: { ...body, sha256 },
  });
  return { sha256 };
}

// ---------------------------------------------------------------------------
// complete-cutover: revision kế tiếp state `completed` khi runtime đã xong.
// KHÔNG chạm bootstrap workflow — chỉ Cutover Record `effective` hợp lệ mới
// kết thúc bootstrap (PRD d.318, ca C08): lệnh này không bao giờ phát
// BootstrapWorkflowDisabled; refs kế thừa nguyên từ revision trước.

export async function completeCutover(
  db: Db,
  commandId: string,
  payload: { recordId: string; executionActor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["recordId", "executionActor"]);
      await requireActor(ctx, p["executionActor"] as string, "system", "Execution actor");
      const latest = await oneOf<{
        revision: number;
        feature_id: string;
        state: string;
        effective_at: string | null;
        authority_actor: string;
        approval_record_ref: Json;
        first_runtime_work_item_ref: string;
        runtime_activation_snapshot_ref: Json;
      }>(
        ctx,
        sql`SELECT revision, feature_id, state, effective_at, authority_actor,
                   approval_record_ref, first_runtime_work_item_ref, runtime_activation_snapshot_ref
            FROM dopaios_cutover_records WHERE id = ${p["recordId"]}
            ORDER BY revision DESC LIMIT 1`,
      );
      if (!latest) {
        throw new CommandRejectedError("ERR-TARGET", `Cutover Record ${p["recordId"]} không tồn tại`);
      }
      if (latest.state !== "effective") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Cutover Record ${p["recordId"]} đang '${latest.state}' — chỉ hoàn tất từ 'effective'`,
        );
      }
      const snapshotRef = latest.runtime_activation_snapshot_ref as {
        snapshotId: string;
        revision: number;
        sha256: string;
      };
      const record = await appendCutoverRecord(ctx, {
        recordId: p["recordId"] as string,
        revision: latest.revision + 1,
        featureId: latest.feature_id,
        state: "completed",
        effectiveAt:
          latest.effective_at === null ? null : new Date(latest.effective_at).toISOString(),
        authorityActor: latest.authority_actor,
        executionActor: p["executionActor"] as string,
        approvalRecordRef: latest.approval_record_ref,
        firstRuntimeWorkItemRef: latest.first_runtime_work_item_ref,
        runtimeActivationSnapshotRef: snapshotRef,
        reconciliationRef: null,
      });
      return {
        recordId: p["recordId"] as string,
        revision: latest.revision + 1,
        state: "completed",
        sha256: record.sha256,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// execute-cutover: guard + thực thi đúng-một-lần (C01–C08)

export type ExecuteCutoverPayload = {
  featureId: string;
  activationKey: string;
  plan: ArtifactRef;
  planContentUtf8: string;
  approvalRecordId: string;
  authorityActor: string;
  executionActor: string;
  bootstrapWorkflowId: string;
  runtimeWorkflowRef: string;
  snapshotId: string;
  cutoverRecordId: string;
  effectiveAt: string;
};

const EXECUTE_CUTOVER_REQUIRED = [
  "featureId",
  "activationKey",
  "plan",
  "planContentUtf8",
  "approvalRecordId",
  "authorityActor",
  "executionActor",
  "bootstrapWorkflowId",
  "runtimeWorkflowRef",
  "snapshotId",
  "cutoverRecordId",
  "effectiveAt",
] as const;

type PlanOpenState = {
  state_id?: string;
  source?: string;
  snapshot_ref?: string;
  disposition?: string;
  target?: string;
  evidence?: string;
  owner?: string;
  due?: string;
  guard?: string;
};

// Kiểm Plan bất biến đủ trường theo PRD d.318 — từng thiếu sót bị nêu đích
// danh (fail-closed, không default ngầm).
function validatePlanDocument(planDoc: Json, featureId: string): {
  firstWorkItemRef: string;
  openStates: PlanOpenState[];
} {
  const reject = (detail: string): never => {
    throw new CommandRejectedError("ERR-CUTOVER-PLAN", detail);
  };
  if (planDoc["immutable"] !== true) reject("Cutover Plan phải bất biến (immutable: true)");
  if (planDoc["feature_id"] !== featureId) {
    reject(`Cutover Plan thuộc feature ${String(planDoc["feature_id"])}, lệnh cutover cho ${featureId}`);
  }
  const pins = planDoc["pins"] as Json | undefined;
  for (const pin of ["feature_spec", "plan", "tasks"] as const) {
    const ref = pins?.[pin] as Json | undefined;
    if (!ref || !ref["artifact_id"] || !ref["revision"] || !ref["sha256"]) {
      reject(`Cutover Plan thiếu pin ${pin} theo ID–revision–hash`);
    }
  }
  const firstWorkItemRef = planDoc["first_runtime_work_item_ref"];
  if (typeof firstWorkItemRef !== "string" || firstWorkItemRef === "") {
    reject("Cutover Plan thiếu first_runtime_work_item_ref");
  }
  if (!planDoc["planned_effective_at"]) reject("Cutover Plan thiếu planned_effective_at");
  const snapshotPin = planDoc["source_inventory_snapshot"] as Json | undefined;
  if (!snapshotPin || !snapshotPin["snapshot_id"] || !snapshotPin["revision"] || !snapshotPin["sha256"]) {
    reject("Cutover Plan thiếu source_inventory_snapshot theo ID–revision–hash");
  }
  const openStates = planDoc["open_states"];
  if (!Array.isArray(openStates) || openStates.length === 0) {
    reject("Cutover Plan thiếu danh sách trạng thái mở");
  }
  const expectedSnapshotRef = `${String(snapshotPin?.["snapshot_id"])}@${String(snapshotPin?.["revision"])}`;
  for (const state of openStates as PlanOpenState[]) {
    if (!state.state_id) reject("Cutover Plan có trạng thái mở thiếu state_id");
    // B6 (finding lens 1): PRD d.318 — "từng trạng thái mở CÙNG NGUỒN/
    // snapshot/revision/hash và đúng một disposition".
    if (!state.source) reject(`Trạng thái mở ${state.state_id} thiếu nguồn (source)`);
    if (state.snapshot_ref !== expectedSnapshotRef) {
      reject(
        `Trạng thái mở ${state.state_id} phải pin snapshot ${expectedSnapshotRef}, đang là: ${String(state.snapshot_ref)}`,
      );
    }
    const disposition = state.disposition;
    if (disposition !== "imported" && disposition !== "closed" && disposition !== "deferred") {
      reject(
        `Trạng thái mở ${state.state_id} phải có đúng một disposition imported | closed | deferred, đang là: ${String(disposition)}`,
      );
    }
    if (disposition === "imported" && !state.target) {
      reject(`Trạng thái mở ${state.state_id} disposition imported thiếu target`);
    }
    if (disposition === "closed" && !state.evidence) {
      reject(`Trạng thái mở ${state.state_id} disposition closed thiếu evidence`);
    }
    if (disposition === "deferred" && !(state.owner && state.due && state.guard)) {
      reject(`Trạng thái mở ${state.state_id} disposition deferred thiếu owner–due–guard`);
    }
  }
  if (!planDoc["rollback_condition"]) reject("Cutover Plan thiếu rollback_condition");
  if (!planDoc["rollback_target"]) reject("Cutover Plan thiếu rollback_target");
  return { firstWorkItemRef: firstWorkItemRef as string, openStates: openStates as PlanOpenState[] };
}

export async function executeCutover(
  db: Db,
  activationKey: string,
  payload: ExecuteCutoverPayload,
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId: activationKey,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, EXECUTE_CUTOVER_REQUIRED);
      if (p["activationKey"] !== activationKey) {
        throw new CommandRejectedError(
          "ERR-002",
          "activationKey trong payload phải trùng activation event/idempotency key của lệnh (QD-5)",
        );
      }
      // B6 (finding 2 lens): effectiveAt phải là mốc thời gian đọc được —
      // fail-closed trước khi bất kỳ guard nào so sánh với nó.
      const effectiveAtMs = Date.parse(p["effectiveAt"] as string);
      if (Number.isNaN(effectiveAtMs)) {
        throw new CommandRejectedError(
          "ERR-002",
          `effectiveAt không phải mốc thời gian hợp lệ: ${String(p["effectiveAt"])}`,
        );
      }

      // Authority là Orchestrator (người); executor là system actor —
      // UJ-11: "pin thẩm quyền Orchestrator nhưng ghi hệ thống là actor
      // thực thi".
      await requireActor(ctx, p["authorityActor"] as string, "human", "Authority actor");
      await requireActor(ctx, p["executionActor"] as string, "system", "Execution actor");

      // Bootstrap workflow của đúng feature, còn ACTIVE.
      const workflow = await oneOf<{ id: string; feature_id: string; state: string }>(
        ctx,
        sql`SELECT id, feature_id, state FROM dopaios_bootstrap_workflows WHERE id = ${p["bootstrapWorkflowId"]}`,
      );
      if (!workflow) {
        throw new CommandRejectedError("ERR-TARGET", `Bootstrap workflow ${p["bootstrapWorkflowId"]} không tồn tại`);
      }
      if (workflow.feature_id !== p["featureId"]) {
        throw new CommandRejectedError(
          "ERR-TARGET",
          `Bootstrap workflow ${workflow.id} thuộc feature ${workflow.feature_id}, không phải ${p["featureId"]}`,
        );
      }
      if (workflow.state !== "ACTIVE") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Bootstrap workflow ${workflow.id} đang ${workflow.state} — phạm vi đã chuyển, không kích hoạt lần thứ hai`,
        );
      }

      // Chưa có record id nào của feature đang ở effective (B6, finding
      // lens 2: đọc revision mới nhất của TỪNG record id, không lấy max
      // xuyên id); activation key và snapshot id chưa từng dùng (guard
      // chính; unique index 0518 là phòng thủ chiều sâu).
      const effectiveRecord = await oneOf<{ id: string; revision: number }>(
        ctx,
        sql`SELECT id, revision FROM (
              SELECT DISTINCT ON (id) id, revision, state
              FROM dopaios_cutover_records WHERE feature_id = ${p["featureId"]}
              ORDER BY id, revision DESC
            ) latest WHERE state = 'effective' LIMIT 1`,
      );
      if (effectiveRecord) {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Feature ${p["featureId"]} đã có Cutover Record effective (${effectiveRecord.id}@${effectiveRecord.revision}) — không tạo lần kích hoạt thứ hai`,
        );
      }
      const keyUsed = await oneOf<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_runtime_activation_snapshots WHERE activation_key = ${activationKey}`,
      );
      if (keyUsed) {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Activation key ${activationKey} đã dùng cho snapshot ${keyUsed.id} — không tạo lần kích hoạt thứ hai`,
        );
      }
      // B6 (finding lens 2): snapshot id tái dùng là xung đột tất định —
      // rejection sạch thay vì vỡ PK rồi cạn retry thành ERR-CONTENTION.
      const snapshotUsed = await oneOf<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_runtime_activation_snapshots WHERE id = ${p["snapshotId"]}`,
      );
      if (snapshotUsed) {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Snapshot id ${String(p["snapshotId"])} đã dùng cho lần kích hoạt trước — chọn snapshot id mới`,
        );
      }

      // Từng tiền điều kiện DS-1 một guard riêng (C01/C02/C03/C11) — thiếu
      // hàng readiness là chưa đạt (fail-closed).
      for (const flag of CUTOVER_READINESS_FLAGS) {
        const readiness = await oneOf<{ ready: boolean }>(
          ctx,
          sql`SELECT ready FROM dopaios_cutover_readiness WHERE feature_id = ${p["featureId"]} AND flag = ${flag}`,
        );
        if (!readiness || readiness.ready !== true) {
          throw new CommandRejectedError(
            "ERR-CUTOVER-READINESS",
            `Tiền điều kiện DS-1 chưa đạt: ${flag} (PRD revision 3 d.402)`,
          );
        }
      }

      // Plan content-addressed: hash byte phải khớp tham chiếu VÀ sổ cái.
      const plan = p["plan"] as ArtifactRef;
      const contentSha = sha256Utf8(p["planContentUtf8"] as string);
      if (contentSha !== plan.sha256) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-PLAN",
          `Nội dung Cutover Plan không khớp hash tham chiếu ${plan.artifactId}@${plan.revision} (nội dung ${contentSha}, tham chiếu ${plan.sha256})`,
        );
      }
      const ledgerRow = await oneOf<{ sha256: string; artifact_state: string }>(
        ctx,
        sql`SELECT sha256, artifact_state FROM dopaios_artifacts
            WHERE id = ${plan.artifactId} AND revision = ${plan.revision}`,
      );
      if (!ledgerRow) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-PLAN",
          `Cutover Plan ${plan.artifactId}@${plan.revision} chưa đăng ký sổ cái artifact`,
        );
      }
      if (ledgerRow.sha256 !== plan.sha256) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-PLAN",
          `Cutover Plan ${plan.artifactId}@${plan.revision} sai hash so với sổ cái`,
        );
      }
      if (ledgerRow.artifact_state !== "approved") {
        throw new CommandRejectedError(
          "ERR-CUTOVER-PLAN",
          `Cutover Plan ${plan.artifactId}@${plan.revision} ở trạng thái '${ledgerRow.artifact_state}', không phải 'approved'`,
        );
      }
      let planDoc: Json;
      try {
        planDoc = JSON.parse(p["planContentUtf8"] as string) as Json;
      } catch {
        throw new CommandRejectedError("ERR-CUTOVER-PLAN", "Nội dung Cutover Plan không phải JSON hợp lệ");
      }
      const { firstWorkItemRef, openStates } = validatePlanDocument(planDoc, p["featureId"] as string);
      // B6 (finding 2 lens — chống backdate): effective_at không phải trường
      // caller tự do — trên fixture nó phải đúng planned_effective_at đã pin
      // trong Plan content-addressed (QD-6). Nhờ đó guard expiry so sánh với
      // một mốc đã được phê duyệt, không phải mốc caller tự khai.
      const plannedMs = Date.parse(String(planDoc["planned_effective_at"]));
      if (Number.isNaN(plannedMs) || effectiveAtMs !== plannedMs) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-PLAN",
          `effective_at (${String(p["effectiveAt"])}) phải đúng planned_effective_at đã pin trong Plan (${String(planDoc["planned_effective_at"])}) — QD-6`,
        );
      }

      // Approval PILOT-CUTOVER: tiêu thụ đúng approval hợp lệ (C04) — ngữ
      // nghĩa phê duyệt thuộc KC-03, ở đây chỉ đối chiếu.
      const approval = await oneOf<{
        id: string;
        package_id: string;
        package_revision: number;
        outcome: string;
        target_id: string | null;
        target_revision: number | null;
        target_sha256: string | null;
        expiry: Json | null;
        invalidated_at: string | null;
      }>(
        ctx,
        sql`SELECT id, package_id, package_revision, outcome, target_id, target_revision, target_sha256, expiry, invalidated_at
            FROM dopaios_approval_records WHERE id = ${p["approvalRecordId"]}`,
      );
      if (!approval) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${p["approvalRecordId"]} không tồn tại — cutover thiếu phê duyệt PILOT-CUTOVER`,
        );
      }
      // B6 (finding lens 1 — ngữ nghĩa "tiêu thụ"): mỗi Approval Record chỉ
      // dùng cho MỘT lần kích hoạt; sau rollback, lần kích hoạt mới cần
      // approval mới. Mọi revision của Cutover Record đều kế thừa approval
      // ref của lần kích hoạt nên chỉ cần một hàng khớp là đã tiêu thụ.
      const approvalConsumed = await oneOf<{ id: string; revision: number }>(
        ctx,
        sql`SELECT id, revision FROM dopaios_cutover_records
            WHERE approval_record_ref->>'recordId' = ${p["approvalRecordId"]}
            ORDER BY revision ASC LIMIT 1`,
      );
      if (approvalConsumed) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${approval.id} đã được tiêu thụ bởi Cutover Record ${approvalConsumed.id}@${approvalConsumed.revision} — lần kích hoạt mới cần approval mới`,
        );
      }
      if (approval.invalidated_at !== null) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${approval.id} đã bị vô hiệu — không còn hiệu lực cho cutover`,
        );
      }
      if (approval.outcome !== "approve") {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${approval.id} có outcome '${approval.outcome}' — cutover cần 'approve' trọn revision`,
        );
      }
      // B6 (finding 2 lens — MAJOR): expiry so theo EPOCH, không so chuỗi
      // (hai chuỗi ISO khác offset so lexicographic cho kết quả sai);
      // expires_at có mặt mà không đọc được là fail-closed.
      const expiresAtRaw = approval.expiry?.["expires_at"];
      if (expiresAtRaw !== undefined && expiresAtRaw !== null) {
        const expiresMs = typeof expiresAtRaw === "string" ? Date.parse(expiresAtRaw) : Number.NaN;
        if (Number.isNaN(expiresMs)) {
          throw new CommandRejectedError(
            "ERR-CUTOVER-APPROVAL",
            `Approval Record ${approval.id} có expiry không đọc được (${String(expiresAtRaw)}) — fail-closed`,
          );
        }
        if (expiresMs < effectiveAtMs) {
          throw new CommandRejectedError(
            "ERR-CUTOVER-APPROVAL",
            `Approval Record ${approval.id} hết hiệu lực từ ${String(expiresAtRaw)}, trước effective_at ${String(p["effectiveAt"])}`,
          );
        }
      }
      if (
        approval.target_id !== plan.artifactId ||
        approval.target_revision !== plan.revision ||
        approval.target_sha256 !== plan.sha256
      ) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${approval.id} không duyệt đúng Plan revision/hash ${plan.artifactId}@${plan.revision}`,
        );
      }
      const decisionPackage = await oneOf<{ fields: Json | null }>(
        ctx,
        sql`SELECT fields FROM dopaios_decision_packages
            WHERE id = ${approval.package_id} AND revision = ${approval.package_revision}`,
      );
      if (!decisionPackage || decisionPackage.fields?.["pointId"] !== "PILOT-CUTOVER") {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${approval.id} không thuộc điểm phê duyệt PILOT-CUTOVER`,
        );
      }

      // ---- Guard đã đạt hết: thực thi trong cùng transaction nguyên tử ----
      // Kết quả áp từng source state theo đúng disposition của Plan.
      const sourceStateResults = openStates.map((state) => {
        if (state.disposition === "imported") {
          return {
            stateId: state.state_id,
            disposition: "imported",
            result: { workItemRef: state.target },
          };
        }
        if (state.disposition === "closed") {
          return {
            stateId: state.state_id,
            disposition: "closed",
            result: { evidence: state.evidence },
          };
        }
        return {
          stateId: state.state_id,
          disposition: "deferred",
          result: { owner: state.owner, due: state.due, guard: state.guard },
        };
      });

      const snapshotBody: Json = {
        snapshotId: p["snapshotId"],
        revision: 1,
        featureId: p["featureId"],
        planRef: plan as unknown as Json,
        approvalRef: {
          recordId: approval.id,
          packageId: approval.package_id,
          packageRevision: approval.package_revision,
        },
        authorityActor: p["authorityActor"],
        systemActor: p["executionActor"],
        activationKey,
        bootstrapWorkflowRef: workflow.id,
        bootstrapDisabled: true,
        sourceStateResults,
        runtimeWorkflowRef: p["runtimeWorkflowRef"],
        firstWorkItemRef,
      };
      const snapshotSha = payloadSha256(snapshotBody);
      await ctx.emit({
        streamName: `dopaiosRuntimeActivationSnapshot-${p["snapshotId"]}`,
        type: "RuntimeActivationSnapshotCreated",
        data: { ...snapshotBody, sha256: snapshotSha },
      });

      const record = await appendCutoverRecord(ctx, {
        recordId: p["cutoverRecordId"] as string,
        revision: 1,
        featureId: p["featureId"] as string,
        state: "effective",
        effectiveAt: p["effectiveAt"] as string,
        authorityActor: p["authorityActor"] as string,
        executionActor: p["executionActor"] as string,
        approvalRecordRef: {
          recordId: approval.id,
          packageId: approval.package_id,
          packageRevision: approval.package_revision,
        },
        firstRuntimeWorkItemRef: firstWorkItemRef,
        runtimeActivationSnapshotRef: {
          snapshotId: p["snapshotId"] as string,
          revision: 1,
          sha256: snapshotSha,
        },
        reconciliationRef: null,
      });

      // Chỉ Cutover Record `effective` hợp lệ mới kết thúc bootstrap workflow
      // (PRD d.318) — phát duy nhất tại đây, sau khi record đã ghi.
      await ctx.emit({
        streamName: `dopaiosBootstrapWorkflow-${workflow.id}`,
        type: "BootstrapWorkflowDisabled",
        data: {
          workflowId: workflow.id,
          byRecordRef: {
            recordId: p["cutoverRecordId"],
            revision: 1,
            sha256: record.sha256,
          },
        },
      });

      return {
        activated: true,
        activationKey,
        snapshot: { snapshotId: p["snapshotId"] as string, revision: 1, sha256: snapshotSha },
        cutoverRecord: {
          recordId: p["cutoverRecordId"] as string,
          revision: 1,
          state: "effective",
          sha256: record.sha256,
        },
        firstWorkItemRef,
        bootstrapDisabled: true,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Nhánh rollback — chuỗi hash MỘT CHIỀU theo PRD d.320 (C09/C10):
// Cutover Record `rolled-back` (reconciliation ref null) → Reconciliation
// Record ánh xạ đúng-một-lần → AI-Reviewer pin mapping revision/hash trong
// Review Evidence `ready` → closure chỉ pin mapping revision không mới hơn
// cùng Review Evidence đó → Cutover Record revision kế tiếp pin đúng
// Reconciliation ID@revision@hash; Reconciliation không pin ngược. Lịch sử
// không bị xóa — mỗi bước là một revision/hàng mới.

// Bước 1: rollback từ effective — revision kế tiếp state rolled-back với
// reconciliation ref NULL; bootstrap được KHÔI PHỤC làm nguồn duy nhất
// (rollback target của Plan). Record rolled-back không "kết thúc" bootstrap
// (C08): lệnh này không bao giờ phát BootstrapWorkflowDisabled.
export async function rollbackCutover(
  db: Db,
  commandId: string,
  payload: { recordId: string; executionActor: string; reason: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["recordId", "executionActor", "reason"]);
      await requireActor(ctx, p["executionActor"] as string, "system", "Execution actor");
      const latest = await oneOf<{
        revision: number;
        feature_id: string;
        state: string;
        effective_at: string | null;
        authority_actor: string;
        approval_record_ref: Json;
        first_runtime_work_item_ref: string;
        runtime_activation_snapshot_ref: Json;
      }>(
        ctx,
        sql`SELECT revision, feature_id, state, effective_at, authority_actor,
                   approval_record_ref, first_runtime_work_item_ref, runtime_activation_snapshot_ref
            FROM dopaios_cutover_records WHERE id = ${p["recordId"]}
            ORDER BY revision DESC LIMIT 1`,
      );
      if (!latest) {
        throw new CommandRejectedError("ERR-TARGET", `Cutover Record ${p["recordId"]} không tồn tại`);
      }
      if (latest.state !== "effective") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Cutover Record ${p["recordId"]} đang '${latest.state}' — chỉ rollback từ 'effective'`,
        );
      }
      const record = await appendCutoverRecord(ctx, {
        recordId: p["recordId"] as string,
        revision: latest.revision + 1,
        featureId: latest.feature_id,
        state: "rolled-back",
        effectiveAt:
          latest.effective_at === null ? null : new Date(latest.effective_at).toISOString(),
        authorityActor: latest.authority_actor,
        executionActor: p["executionActor"] as string,
        approvalRecordRef: latest.approval_record_ref,
        firstRuntimeWorkItemRef: latest.first_runtime_work_item_ref,
        runtimeActivationSnapshotRef: latest.runtime_activation_snapshot_ref as {
          snapshotId: string;
          revision: number;
          sha256: string;
        },
        reconciliationRef: null,
      });
      const workflow = await oneOf<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_bootstrap_workflows WHERE feature_id = ${latest.feature_id}`,
      );
      if (workflow) {
        await ctx.emit({
          streamName: `dopaiosBootstrapWorkflow-${workflow.id}`,
          type: "BootstrapWorkflowReactivated",
          data: { workflowId: workflow.id, reason: p["reason"] },
        });
      }
      return {
        recordId: p["recordId"] as string,
        revision: latest.revision + 1,
        state: "rolled-back",
        sha256: record.sha256,
        bootstrapRestored: workflow !== null,
      };
    },
  });
}

type ReconciliationMappingDoc = {
  mapping_id?: string;
  revision?: number;
  pins_cutover_record?: { record_id?: string; revision?: number; state?: string };
  mappings?: Array<{ event?: string; mapped_to?: string; target?: unknown }>;
  residuals?: Array<{
    residual_id?: string;
    action_owner?: string;
    due?: string;
    guard?: string;
    target?: unknown;
    mapped_to?: unknown;
  }>;
};

// Bước 2: Reconciliation Record — pin ĐÚNG revision rolled-back đang mang
// reconciliation ref null; mọi event/state đúng-một-mapping; residual trỏ
// action owner–due–guard, không target giả (PRD d.320).
export async function createCutoverReconciliation(
  db: Db,
  commandId: string,
  payload: {
    reconciliationId: string;
    featureId: string;
    rolledBackRecordRef: { recordId: string; revision: number; sha256: string };
    mappingArtifactRef: ArtifactRef;
    mappingContentUtf8: string;
    executionActor: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, [
        "reconciliationId",
        "featureId",
        "rolledBackRecordRef",
        "mappingArtifactRef",
        "mappingContentUtf8",
        "executionActor",
      ]);
      await requireActor(ctx, p["executionActor"] as string, "system", "Execution actor");
      const chain = (detail: string): never => {
        throw new CommandRejectedError("ERR-CUTOVER-CHAIN", detail);
      };

      // C10-i: chưa có record rolled-back thì không có Reconciliation.
      const recordRef = p["rolledBackRecordRef"] as { recordId: string; revision: number; sha256: string };
      const rolledBack = await oneOf<{ state: string; sha256: string; reconciliation_ref: Json | null }>(
        ctx,
        sql`SELECT state, sha256, reconciliation_ref FROM dopaios_cutover_records
            WHERE id = ${recordRef.recordId} AND revision = ${recordRef.revision}`,
      );
      if (!rolledBack) {
        chain(
          `Chưa có Cutover Record ${recordRef.recordId}@${recordRef.revision} — Reconciliation phải tạo SAU record rolled-back`,
        );
      }
      if (rolledBack!.state !== "rolled-back") {
        chain(
          `Cutover Record ${recordRef.recordId}@${recordRef.revision} đang '${rolledBack!.state}' — Reconciliation chỉ pin revision rolled-back`,
        );
      }
      if (rolledBack!.sha256 !== recordRef.sha256) {
        chain(`Reconciliation pin sai hash Cutover Record ${recordRef.recordId}@${recordRef.revision}`);
      }
      // C10-iii (chống vòng hash): revision rolled-back được pin phải đang
      // mang reconciliation ref null — revision kế tiếp (đã pin một
      // Reconciliation) không bao giờ được pin ngược.
      if (rolledBack!.reconciliation_ref !== null) {
        chain(
          `Cutover Record ${recordRef.recordId}@${recordRef.revision} đã pin Reconciliation — không pin ngược để tạo vòng hash`,
        );
      }
      // Đúng-một-lần: một revision rolled-back chỉ một Reconciliation.
      const existing = await oneOf<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_cutover_reconciliations
            WHERE rolled_back_record_ref->>'recordId' = ${recordRef.recordId}
              AND (rolled_back_record_ref->>'revision')::int = ${recordRef.revision}`,
      );
      if (existing) {
        chain(
          `Revision rolled-back ${recordRef.recordId}@${recordRef.revision} đã có Reconciliation ${existing.id} — ánh xạ đúng-một-lần`,
        );
      }

      // Mapping content-addressed như Plan: hash byte khớp tham chiếu + sổ cái.
      const mappingRef = p["mappingArtifactRef"] as ArtifactRef;
      const contentSha = sha256Utf8(p["mappingContentUtf8"] as string);
      if (contentSha !== mappingRef.sha256) {
        chain(`Nội dung mapping không khớp hash tham chiếu ${mappingRef.artifactId}@${mappingRef.revision}`);
      }
      const ledgerRow = await oneOf<{ sha256: string }>(
        ctx,
        sql`SELECT sha256 FROM dopaios_artifacts
            WHERE id = ${mappingRef.artifactId} AND revision = ${mappingRef.revision}`,
      );
      if (!ledgerRow) {
        chain(`Mapping ${mappingRef.artifactId}@${mappingRef.revision} chưa đăng ký sổ cái artifact`);
      }
      if (ledgerRow!.sha256 !== mappingRef.sha256) {
        chain(`Mapping ${mappingRef.artifactId}@${mappingRef.revision} sai hash so với sổ cái`);
      }
      let mappingDoc: ReconciliationMappingDoc;
      try {
        mappingDoc = JSON.parse(p["mappingContentUtf8"] as string) as ReconciliationMappingDoc;
      } catch {
        chain("Nội dung mapping không phải JSON hợp lệ");
        throw new Error("unreachable");
      }
      const pins = mappingDoc.pins_cutover_record;
      if (
        !pins ||
        pins.record_id !== recordRef.recordId ||
        pins.revision !== recordRef.revision ||
        pins.state !== "rolled-back"
      ) {
        chain(
          `Mapping phải pin đúng revision rolled-back ${recordRef.recordId}@${recordRef.revision} (state rolled-back)`,
        );
      }
      const mappings = mappingDoc.mappings ?? [];
      if (mappings.length === 0) chain("Mapping rỗng — mọi event/state phải có đúng một mapping hoặc residual");
      const seenEvents = new Set<string>();
      for (const mapping of mappings) {
        if (!mapping.event || !mapping.mapped_to) {
          chain("Mapping có mục thiếu event hoặc mapped_to");
        }
        if (seenEvents.has(mapping.event as string)) {
          chain(`Event ${mapping.event} có nhiều hơn một mapping — ánh xạ phải đúng-một-lần`);
        }
        seenEvents.add(mapping.event as string);
      }
      for (const residual of mappingDoc.residuals ?? []) {
        if (residual.target !== undefined || residual.mapped_to !== undefined) {
          chain(`Residual ${String(residual.residual_id)} mang target giả — residual chỉ trỏ action owner–due–guard`);
        }
        if (!residual.action_owner || !residual.due || !residual.guard) {
          chain(`Residual ${String(residual.residual_id)} thiếu action owner–due–guard`);
        }
      }

      const latestRecon = await oneOf<{ revision: number }>(
        ctx,
        sql`SELECT revision FROM dopaios_cutover_reconciliations
            WHERE id = ${p["reconciliationId"]} ORDER BY revision DESC LIMIT 1`,
      );
      const revision = (latestRecon?.revision ?? 0) + 1;
      const body: Json = {
        reconciliationId: p["reconciliationId"],
        revision,
        featureId: p["featureId"],
        rolledBackRecordRef: recordRef as unknown as Json,
        mappingArtifactRef: mappingRef as unknown as Json,
        mappings: mappings as unknown as Json[],
        residuals: (mappingDoc.residuals ?? []) as unknown as Json[],
        // B6 (finding 2 lens — MAJOR): executor ghi vào NGUỒN để guard
        // reviewer≠executor của bước review đối chiếu được (bài học KC-14 B7).
        executionActor: p["executionActor"],
      };
      const sha256 = payloadSha256(body);
      await ctx.emit({
        streamName: `dopaiosCutoverReconciliation-${p["reconciliationId"]}`,
        type: "CutoverReconciliationCreated",
        data: { ...body, sha256 },
      });
      return { reconciliationId: p["reconciliationId"] as string, revision, sha256 };
    },
  });
}

// Bước 3: AI-Reviewer pin đúng mapping revision/hash trong Review Evidence
// `ready` (QD-4: tái dùng khuôn Review Evidence KC-14 — reviewer khác
// executor, conclusion ready, pin target theo revision/hash; reviewer là
// fixture/system actor giả lập, KHÔNG gọi model thật).
export async function pinReconciliationReview(
  db: Db,
  commandId: string,
  payload: {
    reconciliationId: string;
    revision: number;
    reviewer: string;
    reviewEvidence: {
      ref: string;
      conclusion: string;
      targetMappingRevision: number;
      targetMappingSha256: string;
    };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["reconciliationId", "revision", "reviewer", "reviewEvidence"]);
      const recon = await oneOf<{
        revision: number;
        mapping_artifact_ref: { sha256?: string };
        review_evidence_ref: Json | null;
        execution_actor: string | null;
      }>(
        ctx,
        sql`SELECT revision, mapping_artifact_ref, review_evidence_ref, execution_actor
            FROM dopaios_cutover_reconciliations
            WHERE id = ${p["reconciliationId"]} AND revision = ${p["revision"]}`,
      );
      if (!recon) {
        throw new CommandRejectedError(
          "ERR-TARGET",
          `Reconciliation ${p["reconciliationId"]}@${p["revision"]} không tồn tại`,
        );
      }
      if (recon.review_evidence_ref !== null) {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Reconciliation ${p["reconciliationId"]}@${p["revision"]} đã có Review Evidence`,
        );
      }
      const reviewer = p["reviewer"] as string;
      const reviewerRow = await oneOf<{ kind: string; active: boolean }>(
        ctx,
        sql`SELECT kind, active FROM dopaios_actors WHERE id = ${reviewer}`,
      );
      if (!reviewerRow || !reviewerRow.active) {
        throw new CommandRejectedError("ERR-ACTOR", `AI-Reviewer ${reviewer} chưa đăng ký hoặc không active`);
      }
      // B6 (finding MAJOR cả hai lens — độc lập của mắt xích review):
      // AI-Reviewer phải là actor AI (QD-4) và khác executor ĐÃ GHI của
      // Reconciliation. Kind system≠ai đã tách hai vai; equality là backstop.
      if (reviewerRow.kind !== "ai") {
        throw new CommandRejectedError(
          "ERR-ACTOR",
          `AI-Reviewer ${reviewer} phải là actor kind 'ai' (QD-4), đang là '${reviewerRow.kind}'`,
        );
      }
      if (recon.execution_actor !== null && reviewer === recon.execution_actor) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          `AI-Reviewer phải khác executor đã ghi của Reconciliation (${recon.execution_actor}) — không tự review`,
        );
      }
      const evidence = p["reviewEvidence"] as {
        ref: string;
        conclusion: string;
        targetMappingRevision: number;
        targetMappingSha256: string;
      };
      if (evidence.conclusion !== "ready") {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          `Review Evidence phải ở kết luận 'ready', đang là '${evidence.conclusion}'`,
        );
      }
      if (
        evidence.targetMappingRevision !== recon.revision ||
        evidence.targetMappingSha256 !== recon.mapping_artifact_ref?.sha256
      ) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          `Review Evidence phải pin đúng mapping revision/hash của Reconciliation ${p["reconciliationId"]}@${p["revision"]}`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosCutoverReconciliation-${p["reconciliationId"]}`,
        type: "ReconciliationReviewPinned",
        data: {
          reconciliationId: p["reconciliationId"],
          revision: p["revision"],
          reviewEvidenceRef: { ...evidence, reviewer },
        },
      });
      return { reconciliationId: p["reconciliationId"] as string, revision: p["revision"] as number, pinned: true };
    },
  });
}

// Bước 4: closure — chỉ pin mapping revision KHÔNG MỚI HƠN revision mà
// Review Evidence `ready` đã kiểm, cùng đúng Review Evidence đó (C10-ii).
export async function closeReconciliation(
  db: Db,
  commandId: string,
  payload: {
    reconciliationId: string;
    revision: number;
    closureMappingRevision: number;
    reviewEvidenceRef: string;
    actor: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["reconciliationId", "revision", "closureMappingRevision", "reviewEvidenceRef", "actor"]);
      // B6 (finding 2 lens): closure là bước chốt của người — actor phải
      // đăng ký, active, kind human; revision phải là số nguyên dương thật
      // (chuỗi "1" hay 0 đều fail-closed).
      await requireActor(ctx, p["actor"] as string, "human", "Closure actor");
      const closureRevision = p["closureMappingRevision"];
      if (!Number.isInteger(closureRevision) || (closureRevision as number) < 1) {
        throw new CommandRejectedError(
          "ERR-002",
          `closureMappingRevision phải là số nguyên dương, đang là: ${String(closureRevision)}`,
        );
      }
      const recon = await oneOf<{
        review_evidence_ref: { ref?: string; conclusion?: string; targetMappingRevision?: number } | null;
        closure: Json | null;
      }>(
        ctx,
        sql`SELECT review_evidence_ref, closure FROM dopaios_cutover_reconciliations
            WHERE id = ${p["reconciliationId"]} AND revision = ${p["revision"]}`,
      );
      if (!recon) {
        throw new CommandRejectedError(
          "ERR-TARGET",
          `Reconciliation ${p["reconciliationId"]}@${p["revision"]} không tồn tại`,
        );
      }
      if (recon.closure !== null) {
        throw new CommandRejectedError("ERR-STATE", `Reconciliation ${p["reconciliationId"]}@${p["revision"]} đã closure`);
      }
      const evidence = recon.review_evidence_ref;
      if (!evidence || evidence.conclusion !== "ready") {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          "Closure cần Review Evidence 'ready' đã pin trước đó",
        );
      }
      if (evidence.ref !== p["reviewEvidenceRef"]) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          "Closure phải pin đúng Review Evidence đã kiểm mapping — không thay bằng evidence khác",
        );
      }
      if ((p["closureMappingRevision"] as number) > (evidence.targetMappingRevision ?? 0)) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          `Closure pin mapping revision ${String(p["closureMappingRevision"])} mới hơn revision ${String(evidence.targetMappingRevision)} mà Review Evidence đã kiểm`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosCutoverReconciliation-${p["reconciliationId"]}`,
        type: "ReconciliationClosed",
        data: {
          reconciliationId: p["reconciliationId"],
          revision: p["revision"],
          closure: {
            mappingRevision: p["closureMappingRevision"],
            reviewEvidenceRef: p["reviewEvidenceRef"],
            closedBy: p["actor"],
          },
        },
      });
      return { reconciliationId: p["reconciliationId"] as string, closed: true };
    },
  });
}

// Bước 5: sau closure mới tạo Cutover Record revision kế tiếp pin đúng
// Reconciliation ID@revision@hash (appendCutoverRecord đối chiếu hash với
// projection — C10-iii bị chặn từ createCutoverReconciliation).
export async function recordPostClosureCutoverRevision(
  db: Db,
  commandId: string,
  payload: { recordId: string; reconciliationId: string; executionActor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      requireFields(p, ["recordId", "reconciliationId", "executionActor"]);
      await requireActor(ctx, p["executionActor"] as string, "system", "Execution actor");
      const latest = await oneOf<{
        revision: number;
        feature_id: string;
        state: string;
        effective_at: string | null;
        authority_actor: string;
        approval_record_ref: Json;
        first_runtime_work_item_ref: string;
        runtime_activation_snapshot_ref: Json;
      }>(
        ctx,
        sql`SELECT revision, feature_id, state, effective_at, authority_actor,
                   approval_record_ref, first_runtime_work_item_ref, runtime_activation_snapshot_ref
            FROM dopaios_cutover_records WHERE id = ${p["recordId"]}
            ORDER BY revision DESC LIMIT 1`,
      );
      if (!latest) {
        throw new CommandRejectedError("ERR-TARGET", `Cutover Record ${p["recordId"]} không tồn tại`);
      }
      if (latest.state !== "rolled-back") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Cutover Record ${p["recordId"]} đang '${latest.state}' — revision hậu closure chỉ nối sau rolled-back`,
        );
      }
      const recon = await oneOf<{ revision: number; sha256: string; closure: Json | null }>(
        ctx,
        sql`SELECT revision, sha256, closure FROM dopaios_cutover_reconciliations
            WHERE id = ${p["reconciliationId"]}
              AND rolled_back_record_ref->>'recordId' = ${p["recordId"]}
              AND (rolled_back_record_ref->>'revision')::int = ${latest.revision}`,
      );
      if (!recon) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          `Không có Reconciliation ${p["reconciliationId"]} pin revision rolled-back ${p["recordId"]}@${latest.revision}`,
        );
      }
      // C09 bước 5: SAU closure mới tạo revision kế tiếp.
      if (recon.closure === null) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-CHAIN",
          `Reconciliation ${p["reconciliationId"]} chưa closure — chưa được tạo Cutover Record revision kế tiếp`,
        );
      }
      const record = await appendCutoverRecord(ctx, {
        recordId: p["recordId"] as string,
        revision: latest.revision + 1,
        featureId: latest.feature_id,
        state: "rolled-back",
        effectiveAt:
          latest.effective_at === null ? null : new Date(latest.effective_at).toISOString(),
        authorityActor: latest.authority_actor,
        executionActor: p["executionActor"] as string,
        approvalRecordRef: latest.approval_record_ref,
        firstRuntimeWorkItemRef: latest.first_runtime_work_item_ref,
        runtimeActivationSnapshotRef: latest.runtime_activation_snapshot_ref as {
          snapshotId: string;
          revision: number;
          sha256: string;
        },
        reconciliationRef: {
          reconciliationId: p["reconciliationId"],
          revision: recon.revision,
          sha256: recon.sha256,
        },
      });
      return {
        recordId: p["recordId"] as string,
        revision: latest.revision + 1,
        state: "rolled-back",
        reconciliationRef: {
          reconciliationId: p["reconciliationId"] as string,
          revision: recon.revision,
          sha256: recon.sha256,
        },
        sha256: record.sha256,
      };
    },
  });
}
