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
  for (const state of openStates as PlanOpenState[]) {
    if (!state.state_id) reject("Cutover Plan có trạng thái mở thiếu state_id");
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

      // Chưa từng có cutover effective cho feature; activation key chưa từng
      // dùng (guard chính; unique index 0518 là phòng thủ chiều sâu).
      const latestRecord = await oneOf<{ id: string; revision: number; state: string }>(
        ctx,
        sql`SELECT id, revision, state FROM dopaios_cutover_records
            WHERE feature_id = ${p["featureId"]} ORDER BY revision DESC LIMIT 1`,
      );
      if (latestRecord && latestRecord.state === "effective") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Feature ${p["featureId"]} đã có Cutover Record effective (${latestRecord.id}@${latestRecord.revision}) — không tạo lần kích hoạt thứ hai`,
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
      const expiresAt = approval.expiry?.["expires_at"];
      if (typeof expiresAt === "string" && expiresAt < (p["effectiveAt"] as string)) {
        throw new CommandRejectedError(
          "ERR-CUTOVER-APPROVAL",
          `Approval Record ${approval.id} hết hiệu lực từ ${expiresAt}, trước effective_at ${String(p["effectiveAt"])}`,
        );
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
