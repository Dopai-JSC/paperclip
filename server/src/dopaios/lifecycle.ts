import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  payloadSha256,
  CommandRejectedError,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";
import {
  currentOutputsPinningSource,
  invalidateEffectiveApprovalsAndReblockSteps,
  invalidateOpenPackagesAndRequestsForOutput,
} from "./graph-repo.js";

// KC-14 B2: hoàn tất bảng transition `artifact_state` FS-002 (bốn hàng KC-03
// chưa hiện thực: create-revision, begin-implementation, freeze-artifact,
// retire-artifact) và Hợp đồng chất lượng theo QD-2 đã duyệt:
//  - nội dung hợp đồng là projection theo (id, revision); HIỆU LỰC do guard
//    đọc sổ artifact FS-002 trong cùng transaction — đăng ký loại
//    'quality-contract', approved, impact ∈ {clear, reaffirmed}, đúng sha256;
//  - pin vào phiên bản đầu ra lúc nộp là ID@revision@hash (không-"latest");
//    revision hợp đồng mới KHÔNG đổi âm thầm phiên bản đang chạy;
//  - begin-implementation là điểm chứng minh guard TRỤC KÉP: artifact_state
//    'approved' chưa đủ — impact_status phải ∈ {clear, reaffirmed} (FS-002
//    d.108-115: approved mà impact-pending thì bị chặn SỬ DỤNG).

type Json = Record<string, unknown>;

async function queryRows<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await ctx.tx.execute(query)) as unknown as T[];
}

type ArtifactRow = {
  revision: number;
  sha256: string;
  artifact_state: string;
  impact_status: string;
  artifact_type: string | null;
  has_region_schema: boolean | null;
  created_by: string | null;
};

async function loadArtifactRevisions(ctx: CommandContext, artifactId: string): Promise<ArtifactRow[]> {
  return queryRows<ArtifactRow>(
    ctx,
    sql`SELECT revision, sha256, artifact_state, impact_status, artifact_type,
               has_region_schema, created_by
        FROM dopaios_artifacts WHERE id = ${artifactId} ORDER BY revision`,
  );
}

// SFR-004: ID đã retire không bao giờ tái sử dụng — guard chung cho mọi lệnh
// tạo revision trên một ID.
function rejectIfRetired(revisions: ArtifactRow[], artifactId: string): void {
  if (revisions.some((r) => r.artifact_state === "retired")) {
    throw new CommandRejectedError("SFR-004", `Artifact ID ${artifactId} is retired and never reused`);
  }
}

// Approval đang hiệu lực của đúng (id, revision): outcome approve/AWC, pin
// đúng content hash hiện hành, chưa bị vô hiệu (invalidated_at IS NULL).
// Trục impact kiểm RIÊNG ở từng call site — hàng begin-implementation của
// bảng FS-002 tách "approval còn hiệu lực đúng hash" và "impact ∈ {clear,
// reaffirmed}" thành hai vế guard.
async function findEffectiveApproval(
  ctx: CommandContext,
  artifactId: string,
  revision: number,
  sha256: string,
): Promise<{ id: string } | null> {
  const rows = await queryRows<{ id: string }>(
    ctx,
    sql`SELECT id FROM dopaios_approval_records
        WHERE target_id = ${artifactId} AND target_revision = ${revision}
          AND target_sha256 = ${sha256}
          AND outcome IN ('approve', 'approve-with-conditions')
          AND invalidated_at IS NULL
        ORDER BY id DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

// ===== Hàng NONE (revision kế tiếp) → draft: create-revision =====
// Side effect impact (SFR-010): revision nguồn khai đổi nghĩa mở MỘT impact
// record cho MỖI artifact phụ thuộc còn hiệu lực — không ghi được trọn thì
// toàn lệnh thất bại nguyên tử. Danh sách phụ thuộc artifact↔artifact do
// fixture khai tường minh (sổ nguồn trong projection artifact thuộc phạm vi
// sau); KC-15 B3 đóng phần trục RUN bằng sổ dùng chung: phần bị ảnh hưởng là
// các phiên bản đầu ra HIỆN HÀNH pin nguồn này (source_refs — pin FS-002,
// QD-4), approval hiệu lực của chúng hết hiệu lực + bước tái chặn trong CÙNG
// transaction (SFR-031/050) — dùng chung helper với đường bản-mới-vào-trục
// của KC-14, không cơ chế thứ hai.
export async function createArtifactRevision(
  db: Db,
  commandId: string,
  payload: {
    artifactId: string;
    revision: number;
    sha256: string;
    createdBy: string;
    semanticChange: boolean;
    dependents: Array<{ artifactId: string; revision: number }>;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      if (typeof p["semanticChange"] !== "boolean") {
        throw new CommandRejectedError("ERR-002", "Revision must declare semanticChange explicitly");
      }
      const revisions = await loadArtifactRevisions(ctx, p["artifactId"] as string);
      if (revisions.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "create-revision requires an existing artifact");
      }
      rejectIfRetired(revisions, p["artifactId"] as string);
      const maxRevision = revisions[revisions.length - 1].revision;
      if ((p["revision"] as number) !== maxRevision + 1) {
        throw new CommandRejectedError(
          "ERR-REVISION",
          `Revision must be ${maxRevision + 1}, got ${p["revision"]}`,
        );
      }
      const base = revisions[revisions.length - 1];
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
          artifactType: base.artifact_type,
          hasRegionSchema: base.has_region_schema,
        },
      });
      const dependents = p["dependents"] as Array<{ artifactId: string; revision: number }>;
      let runLevelInvalidated = 0;
      if (p["semanticChange"] === true) {
        // KC-15 B3: impact trục run từ sổ dùng chung — KHÔNG khai tay.
        const affectedOutputs = await currentOutputsPinningSource(ctx, p["artifactId"] as string);
        const sourceEvent = `${p["artifactId"]}@${p["revision"]}`;
        for (const output of affectedOutputs) {
          runLevelInvalidated += await invalidateEffectiveApprovalsAndReblockSteps(
            ctx,
            output.outputId,
            output.revision,
            `source-changed: ${sourceEvent} khai đổi nghĩa (SFR-031/050)`,
          );
          await invalidateOpenPackagesAndRequestsForOutput(ctx, output.outputId, output.revision, {
            reason: "source-changed",
            sourceEvent,
          });
        }
        for (const dep of dependents) {
          const depRows = await queryRows<{ artifact_state: string }>(
            ctx,
            sql`SELECT artifact_state FROM dopaios_artifacts
                WHERE id = ${dep.artifactId} AND revision = ${dep.revision}`,
          );
          if (depRows.length === 0) {
            throw new CommandRejectedError(
              "SFR-010",
              `Dependent ${dep.artifactId}@${dep.revision} not found — impact side effect must be atomic`,
            );
          }
          if (depRows[0].artifact_state === "superseded" || depRows[0].artifact_state === "retired") {
            continue; // phụ thuộc đã kết thúc — không còn hiệu lực để chịu impact
          }
          // Idempotency key của hàng impact: ID@revision nguồn × artifact phụ thuộc.
          const impactId = `IMP-${p["artifactId"]}r${p["revision"]}-${dep.artifactId}r${dep.revision}`;
          await ctx.emit({
            streamName: `dopaiosImpact-${impactId}`,
            type: "ImpactRecordOpened",
            data: {
              impactId,
              artifactId: dep.artifactId,
              artifactRevision: dep.revision,
              source: "source-changed",
              sourceRef: `${p["artifactId"]}@${p["revision"]}`,
            },
            expectedVersion: -1,
          });
          await ctx.emit({
            streamName: `dopaiosArtifact-${dep.artifactId}`,
            type: "ArtifactImpactChanged",
            data: { artifactId: dep.artifactId, revision: dep.revision, impactStatus: "impact-pending" },
          });
        }
      }
      return {
        artifactId: p["artifactId"] as string,
        revision: p["revision"] as number,
        state: "draft",
        impactedDependents: p["semanticChange"] === true ? dependents.length : 0,
        // KC-15 B3: số approval trục run hết hiệu lực từ sổ dùng chung.
        runLevelInvalidated,
      };
    },
  });
}

// ===== Hàng approved → implementing: begin-implementation =====
// Guard trục kép: approval hiệu lực đúng hash VÀ impact ∈ {clear, reaffirmed}.
export async function beginImplementation(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const rows = await queryRows<ArtifactRow>(
        ctx,
        sql`SELECT revision, sha256, artifact_state, impact_status, artifact_type,
                   has_region_schema, created_by
            FROM dopaios_artifacts
            WHERE id = ${p["artifactId"]} AND revision = ${p["revision"]}`,
      );
      if (rows.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Artifact revision not found");
      }
      const artifact = rows[0];
      if (artifact.artifact_state !== "approved") {
        throw new CommandRejectedError("ERR-STATE", "begin-implementation requires state approved");
      }
      const actor = await queryRows<{ active: boolean }>(
        ctx,
        sql`SELECT active FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (actor.length === 0) {
        throw new CommandRejectedError("ERR-ACTOR", "Actor is not a registered active actor");
      }
      const approval = await findEffectiveApproval(
        ctx,
        p["artifactId"] as string,
        p["revision"] as number,
        artifact.sha256,
      );
      if (!approval) {
        throw new CommandRejectedError("ERR-APPROVAL", "No effective approval pins this revision hash");
      }
      if (artifact.impact_status !== "clear" && artifact.impact_status !== "reaffirmed") {
        throw new CommandRejectedError(
          "SFR-011",
          `Artifact is ${artifact.impact_status} — approved but blocked for use inside the impact set`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactStateChanged",
        data: { artifactId: p["artifactId"], revision: p["revision"], artifactState: "implementing" },
      });
      return { artifactId: p["artifactId"] as string, state: "implementing" };
    },
  });
}

// ===== Hàng implementing → released-frozen: freeze-artifact =====
// Guard: approval còn hiệu lực; MỌI condition thuộc record đó đã đóng.
export async function freezeArtifact(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const rows = await queryRows<ArtifactRow>(
        ctx,
        sql`SELECT revision, sha256, artifact_state, impact_status, artifact_type,
                   has_region_schema, created_by
            FROM dopaios_artifacts
            WHERE id = ${p["artifactId"]} AND revision = ${p["revision"]}`,
      );
      if (rows.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Artifact revision not found");
      }
      if (rows[0].artifact_state !== "implementing") {
        throw new CommandRejectedError("ERR-STATE", "freeze-artifact requires state implementing");
      }
      // KC-14 B7 (major review): freeze cũng là điểm DÙNG — actor phải đăng
      // ký/active và trục impact phải sạch như begin-implementation.
      const freezeActor = await queryRows<{ active: boolean }>(
        ctx,
        sql`SELECT active FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (freezeActor.length === 0) {
        throw new CommandRejectedError("ERR-ACTOR", "Actor is not a registered active actor");
      }
      if (rows[0].impact_status !== "clear" && rows[0].impact_status !== "reaffirmed") {
        throw new CommandRejectedError(
          "SFR-011",
          `Artifact is ${rows[0].impact_status} — blocked for use inside the impact set`,
        );
      }
      const approval = await findEffectiveApproval(
        ctx,
        p["artifactId"] as string,
        p["revision"] as number,
        rows[0].sha256,
      );
      if (!approval) {
        throw new CommandRejectedError("ERR-APPROVAL", "No effective approval pins this revision hash");
      }
      const openConditions = await queryRows<{ id: string; state: string }>(
        ctx,
        sql`SELECT id, state FROM dopaios_conditions
            WHERE record_id = ${approval.id} AND state <> 'closed'`,
      );
      if (openConditions.length > 0) {
        throw new CommandRejectedError(
          "ERR-CONDITION-OPEN",
          `Conditions in scope are not closed: ${openConditions.map((c) => c.id).join(", ")}`,
        );
      }
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactStateChanged",
        data: { artifactId: p["artifactId"], revision: p["revision"], artifactState: "released-frozen" },
      });
      return { artifactId: p["artifactId"] as string, state: "released-frozen" };
    },
  });
}

// ===== Hàng mọi trạng thái chưa terminal → retired: retire-artifact =====
// Guard "không còn artifact chưa kết thúc đang pin artifact này": slice kiểm
// đủ các chỗ pin ĐANG TỒN TẠI trong hệ — định nghĩa SOP chưa retired, Product
// Baseline đang active, phiên bản đầu ra chưa terminal pin Hợp đồng chất
// lượng. Sổ nguồn-pin đầy đủ thuộc KC-15/DS-2.
export async function retireArtifact(
  db: Db,
  commandId: string,
  payload: { artifactId: string; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const actorRows = await queryRows<{ kind: string; capabilities: string[] }>(
        ctx,
        sql`SELECT kind, capabilities FROM dopaios_actors WHERE id = ${p["actor"]} AND active = true`,
      );
      if (actorRows.length === 0 || !actorRows[0].capabilities.includes("governance-approver")) {
        throw new CommandRejectedError("ERR-CAPABILITY", "retire-artifact requires governance-approver");
      }
      if (actorRows[0].kind !== "human") {
        throw new CommandRejectedError("SFR-023", "AI holds no retire authority");
      }
      const revisions = await loadArtifactRevisions(ctx, p["artifactId"] as string);
      if (revisions.length === 0) {
        throw new CommandRejectedError("ERR-TARGET", "Artifact not found");
      }
      rejectIfRetired(revisions, p["artifactId"] as string);

      const pinningDefinitions = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_sop_definitions
            WHERE sop_pin->>'artifactId' = ${p["artifactId"]} AND state <> 'retired'`,
      );
      if (pinningDefinitions.length > 0) {
        throw new CommandRejectedError(
          "ERR-PINNED",
          `SOP definitions still pin this artifact: ${pinningDefinitions.map((r) => r.id).join(", ")}`,
        );
      }
      const pinningBaselines = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT DISTINCT id FROM dopaios_product_baselines
            WHERE state IN ('pinned', 'active')
              AND items @> ${JSON.stringify([{ artifactId: p["artifactId"] }])}::jsonb`,
      );
      if (pinningBaselines.length > 0) {
        throw new CommandRejectedError(
          "ERR-PINNED",
          `Active Product Baselines still pin this artifact: ${pinningBaselines.map((r) => r.id).join(", ")}`,
        );
      }
      const pinningOutputs = await queryRows<{ id: string; revision: number }>(
        ctx,
        sql`SELECT id, revision FROM dopaios_output_versions
            WHERE quality_contract_ref->>'id' = ${p["artifactId"]}
              AND state NOT IN ('APPROVED', 'ACCEPTED', 'REJECTED', 'REWORK_REQUIRED')`,
      );
      if (pinningOutputs.length > 0) {
        throw new CommandRejectedError(
          "ERR-PINNED",
          `Non-terminal output versions still pin this quality contract: ${pinningOutputs
            .map((r) => `${r.id}@${r.revision}`)
            .join(", ")}`,
        );
      }
      // KC-14 B7 (minor review): Project shell pin templateRef — Project chưa
      // đóng còn pin template này thì không retire được.
      const pinningProjects = await queryRows<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_projects
            WHERE template_ref->>'template_id' = ${p["artifactId"]}
              AND state NOT IN ('P4_CLOSED')`,
      );
      if (pinningProjects.length > 0) {
        throw new CommandRejectedError(
          "ERR-PINNED",
          `Open projects still pin this template: ${pinningProjects.map((r) => r.id).join(", ")}`,
        );
      }

      let retired = 0;
      for (const row of revisions) {
        if (row.artifact_state === "superseded" || row.artifact_state === "retired") continue;
        await ctx.emit({
          streamName: `dopaiosArtifact-${p["artifactId"]}`,
          type: "ArtifactStateChanged",
          data: { artifactId: p["artifactId"], revision: row.revision, artifactState: "retired" },
        });
        retired += 1;
      }
      return { artifactId: p["artifactId"] as string, retiredRevisions: retired };
    },
  });
}

// ===== Hợp đồng chất lượng =====

export type QualityContractRef = { id: string; revision: number; sha256: string };

// Hash nội dung hợp đồng: canonical JSON của đúng phần nghĩa (outputType +
// requiredChecks) — binding thật giữa sổ artifact và projection nội dung.
export function qualityContractContentSha256(content: {
  outputType: string;
  requiredChecks: string[];
}): string {
  return payloadSha256({ outputType: content.outputType, requiredChecks: content.requiredChecks });
}

// Đăng ký NỘI DUNG hợp đồng chất lượng. Guard binding: sổ artifact phải có
// đúng (id, revision) loại 'quality-contract' với sha256 bằng hash nội dung.
// Trạng thái/impact KHÔNG kiểm ở đây — hiệu lực kiểm tại điểm PIN (ready-check
// của run-fixture-execution), nên fixture đăng ký được nội dung của hợp đồng
// chưa duyệt để chứng minh pin bị chặn.
export async function registerQualityContract(
  db: Db,
  commandId: string,
  payload: {
    contractId: string;
    revision: number;
    outputType: string;
    requiredChecks: string[];
    registeredBy: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const requiredChecks = p["requiredChecks"] as string[];
      if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
        throw new CommandRejectedError("ERR-002", "requiredChecks must be a non-empty list");
      }
      const contentSha = qualityContractContentSha256({
        outputType: p["outputType"] as string,
        requiredChecks,
      });
      const ledger = await queryRows<{ sha256: string; artifact_type: string | null }>(
        ctx,
        sql`SELECT sha256, artifact_type FROM dopaios_artifacts
            WHERE id = ${p["contractId"]} AND revision = ${p["revision"]}`,
      );
      if (ledger.length === 0) {
        throw new CommandRejectedError(
          "ERR-TARGET",
          "Quality contract must be registered in the FS-002 ledger first",
        );
      }
      if (ledger[0].artifact_type !== "quality-contract") {
        throw new CommandRejectedError("ERR-TYPE", "Ledger artifact is not of type quality-contract");
      }
      if (ledger[0].sha256 !== contentSha) {
        throw new CommandRejectedError(
          "SFR-007",
          "Ledger hash does not match the canonical content hash of the contract",
        );
      }
      await ctx.emit({
        streamName: `dopaiosQualityContract-${p["contractId"]}`,
        type: "QualityContractRegistered",
        data: {
          contractId: p["contractId"],
          revision: p["revision"],
          outputType: p["outputType"],
          requiredChecks,
          sha256: contentSha,
          registeredBy: p["registeredBy"],
        },
      });
      return { contractId: p["contractId"] as string, revision: p["revision"] as number, sha256: contentSha };
    },
  });
}

// Guard PIN hợp đồng chất lượng — chạy trong transaction của lệnh nộp
// (ready-check máy-kiểm của bước): sổ artifact approved + impact ∈ {clear,
// reaffirmed} + đúng hash + nội dung tồn tại đúng loại đầu ra. Trả về
// requiredChecks để guard CHECK_PASSED dùng cùng snapshot.
// KC-15 B3 (QD-4): pin danh sách nguồn của phiên bản đầu ra theo chuẩn pin
// FS-002 — mỗi ref là ID@revision@sha256 chính xác (không "latest"); nguồn
// phải approved (superseded/draft bị chặn — "re-entry duy nhất qua revision
// được duyệt" của FS-002 d.693-696), đúng hash và impact ∈ {clear,
// reaffirmed} (trục kép — approved mà impact-pending bị chặn SỬ DỤNG).
// Danh sách rỗng/vắng mặt hợp lệ (EDGE-001) — hành vi item không pin nguồn
// giữ nguyên.
export type SourceRef = { artifactId: string; revision: number; sha256: string };

export async function validateSourceRefs(
  ctx: CommandContext,
  refs: SourceRef[] | undefined,
): Promise<void> {
  if (!refs || refs.length === 0) return;
  for (const ref of refs) {
    if (!ref?.artifactId || !ref?.revision || !ref?.sha256) {
      throw new CommandRejectedError("ERR-002", "Source ref must pin artifactId@revision@sha256");
    }
    const ledger = await queryRows<{
      sha256: string;
      artifact_state: string;
      impact_status: string;
    }>(
      ctx,
      sql`SELECT sha256, artifact_state, impact_status FROM dopaios_artifacts
          WHERE id = ${ref.artifactId} AND revision = ${ref.revision}`,
    );
    if (ledger.length === 0) {
      throw new CommandRejectedError("ERR-SOURCE", `Pinned source ${ref.artifactId}@${ref.revision} is not in the ledger`);
    }
    if (ledger[0].sha256 !== ref.sha256) {
      throw new CommandRejectedError("SFR-007", `Source pin hash mismatch for ${ref.artifactId}@${ref.revision}`);
    }
    if (ledger[0].artifact_state !== "approved") {
      throw new CommandRejectedError(
        "ERR-SOURCE",
        `Pinned source ${ref.artifactId}@${ref.revision} is ${ledger[0].artifact_state} — only an approved revision may be used (FS-002 re-entry)`,
      );
    }
    if (ledger[0].impact_status !== "clear" && ledger[0].impact_status !== "reaffirmed") {
      throw new CommandRejectedError(
        "SFR-011",
        `Pinned source ${ref.artifactId}@${ref.revision} is blocked for use inside its impact set`,
      );
    }
  }
}

export async function validateQualityContractPin(
  ctx: CommandContext,
  ref: QualityContractRef,
  outputType: string,
): Promise<string[]> {
  if (!ref || !ref.id || !ref.revision || !ref.sha256) {
    throw new CommandRejectedError("ERR-002", "Output submission must pin a quality contract ref");
  }
  const ledger = (await ctx.tx.execute(sql`
    SELECT sha256, artifact_state, impact_status, artifact_type
    FROM dopaios_artifacts WHERE id = ${ref.id} AND revision = ${ref.revision}
  `)) as unknown as Array<{
    sha256: string;
    artifact_state: string;
    impact_status: string;
    artifact_type: string | null;
  }>;
  if (ledger.length === 0) {
    throw new CommandRejectedError("ERR-QC", "Pinned quality contract is not in the ledger");
  }
  if (ledger[0].artifact_type !== "quality-contract") {
    throw new CommandRejectedError("ERR-QC", "Pinned artifact is not a quality contract");
  }
  if (ledger[0].artifact_state !== "approved") {
    throw new CommandRejectedError("ERR-QC", "Pinned quality contract is not approved");
  }
  if (ledger[0].impact_status !== "clear" && ledger[0].impact_status !== "reaffirmed") {
    throw new CommandRejectedError(
      "SFR-011",
      "Pinned quality contract is blocked for use inside its impact set",
    );
  }
  if (ledger[0].sha256 !== ref.sha256) {
    throw new CommandRejectedError("SFR-007", "Quality contract pin hash mismatch");
  }
  // KC-14 B7 (major review): hợp đồng chất lượng gác CHECK_PASSED nên hiệu
  // lực phải là hiệu lực THẬT — có Approval Record approve/AWC đúng hash,
  // chưa vô hiệu; hàng ledger bootstrap không record không đủ (cùng chuẩn
  // begin-implementation đặt cho trục artifact).
  const effective = await findEffectiveApproval(ctx, ref.id, ref.revision, ref.sha256);
  if (!effective) {
    throw new CommandRejectedError(
      "ERR-APPROVAL",
      "Pinned quality contract has no effective approval record",
    );
  }
  const content = (await ctx.tx.execute(sql`
    SELECT output_type, required_checks FROM dopaios_quality_contracts
    WHERE id = ${ref.id} AND revision = ${ref.revision} AND sha256 = ${ref.sha256}
  `)) as unknown as Array<{ output_type: string; required_checks: string[] }>;
  if (content.length === 0) {
    throw new CommandRejectedError("ERR-QC", "Quality contract content is not registered");
  }
  if (content[0].output_type !== outputType) {
    throw new CommandRejectedError(
      "ERR-QC",
      `Quality contract is for output type ${content[0].output_type}, not ${outputType}`,
    );
  }
  return content[0].required_checks;
}
