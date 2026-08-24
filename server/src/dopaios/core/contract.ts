import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandResult,
  type CommandContext,
  CommandRejectedError,
  payloadSha256,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";
import { requireApprovedContextPackage } from "./context-package.js";

// KC-13 B3: Hợp đồng thực hiện AI (PRD FR-63 — FS-003 chủ đích không định
// nghĩa, toàn bộ ngữ nghĩa lấy từ PRD). Biên dịch từ BỐN nguồn có phiên bản:
// SOP definition, Team Manifest đúng giai đoạn, Project, work-item. Thiếu
// trường bắt buộc thì AI không bắt đầu (fail-closed); sửa hợp đồng tạo
// revision mới và KHÔNG đổi âm thầm Phiên chạy AI đang hoạt động — cưỡng chế
// bằng pin (contractId, revision) ghi trên activation lúc kích hoạt, cộng
// impact record mở cho revision cũ còn lượt chạy (tái dùng bảng impact KC-03).

type Json = Record<string, unknown>;

// Bộ trường bắt buộc theo lời FR-63: mục tiêu/phạm vi, nguồn và phiên bản
// đầu vào, đầu ra cùng tiêu chí chất lượng, ngữ cảnh/tri thức, quyền, công
// cụ/tài nguyên, giới hạn thời gian–chi phí–vòng lặp, kiểm tra và bằng chứng
// bắt buộc, điều kiện dừng, sự kiện chuyển cấp, đường dự phòng.
export const CONTRACT_REQUIRED_FIELDS = [
  "objective",
  "scope",
  "inputs",
  "outputs",
  "context",
  "permissions",
  "tools",
  "limits",
  "requiredChecks",
  "requiredEvidence",
  "stopConditions",
  "escalationEvents",
  "fallbackPath",
] as const;

const LIMIT_KEYS = ["timeMs", "costUsd", "loops"] as const;

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return ((await ctx.tx.execute(query)) as unknown as T[])[0];
}

export function requireContractFields(fields: Json): void {
  for (const key of CONTRACT_REQUIRED_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null || value === "") {
      throw new CommandRejectedError(
        "ERR-CONTRACT-FIELD",
        `Execution contract is missing required field ${key} — AI must not start (FR-63)`,
      );
    }
  }
  const limits = fields["limits"] as Json;
  for (const key of LIMIT_KEYS) {
    if (typeof limits?.[key] !== "number") {
      throw new CommandRejectedError(
        "ERR-CONTRACT-FIELD",
        `Execution contract limits must pin numeric ${key} (FR-63 time–cost–loop bounds)`,
      );
    }
  }
}

export async function compileExecutionContract(
  db: Db,
  commandId: string,
  payload: {
    contractId: string;
    workItemId: string;
    compiledBy: string;
    sopRef: { id: string; revision: number; sha256: string };
    fields: Json;
    contextPackageRef?: { id: string; revision: number; sha256: string };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      // Nguồn 4 — work-item đang hiệu lực.
      const workItem = await one<{ state: string; project_id: string | null }>(
        ctx,
        sql`SELECT state, project_id FROM dopaios_work_items WHERE id = ${p["workItemId"]}`,
      );
      if (!workItem) {
        throw new CommandRejectedError("ERR-WORKITEM", `Work item ${p["workItemId"]} not found`);
      }
      // Nguồn 3 — Project đang hiệu lực (work-item gắn Project phải qua P0-01).
      let projectPin: Json | null = null;
      let manifestPin: Json | null = null;
      if (workItem.project_id) {
        const project = await one<{ state: string }>(
          ctx,
          sql`SELECT state FROM dopaios_projects WHERE id = ${workItem.project_id}`,
        );
        if (!project || project.state !== "P0_ACTIVE") {
          throw new CommandRejectedError(
            "SFR-003",
            `Project ${workItem.project_id} does not allow AI execution (state ${project?.state ?? "unknown"})`,
          );
        }
        projectPin = { id: workItem.project_id, state: project.state };
        // Nguồn 2 — Team Manifest ĐÚNG GIAI ĐOẠN đang hiệu lực của Project.
        const manifest = await one<{ id: string; revision: number; sha256: string }>(
          ctx,
          sql`SELECT id, revision, sha256 FROM dopaios_team_manifests
              WHERE project_id = ${workItem.project_id} AND stage = 'bootstrap' AND state = 'approved'
              ORDER BY revision DESC LIMIT 1`,
        );
        if (!manifest) {
          throw new CommandRejectedError(
            "ERR-MANIFEST-STATE",
            `Project ${workItem.project_id} has no approved bootstrap Team Manifest (FR-63 source 2)`,
          );
        }
        manifestPin = { id: manifest.id, revision: manifest.revision, sha256: manifest.sha256 };
      } else {
        throw new CommandRejectedError(
          "ERR-WORKITEM-PROJECT",
          `Work item ${p["workItemId"]} is not bound to a Project — execution contracts compile for Project work items`,
        );
      }
      // Nguồn 1 — SOP definition đúng pin và đã published.
      const sopRef = p["sopRef"] as { id: string; revision: number; sha256: string };
      const sop = await one<{ revision: number; state: string }>(
        ctx,
        sql`SELECT revision, state FROM dopaios_sop_definitions WHERE id = ${sopRef.id}`,
      );
      if (!sop || Number(sop.revision) !== Number(sopRef.revision) || sop.state !== "published") {
        throw new CommandRejectedError(
          "ERR-SOP-PIN",
          `SOP definition ${sopRef.id}@${sopRef.revision} is not the published revision (FR-63 source 1)`,
        );
      }

      const fields = p["fields"] as Json;
      requireContractFields(fields);
      const contextPackageRef = p["contextPackageRef"] as
        | { id: string; revision: number; sha256: string }
        | undefined;
      if (contextPackageRef) {
        await requireApprovedContextPackage(ctx, contextPackageRef, {
          projectId: workItem.project_id,
          workItemId: p["workItemId"] as string,
        });
      }

      const prior = (await ctx.tx.execute(sql`
        SELECT revision, state FROM dopaios_execution_contracts
        WHERE id = ${p["contractId"]} ORDER BY revision
      `)) as unknown as Array<{ revision: number; state: string }>;
      const revision = prior.length === 0 ? 1 : Math.max(...prior.map((r) => r.revision)) + 1;

      const sources: Json = {
        sop: sopRef,
        manifest: manifestPin,
        project: projectPin,
        workItem: { id: p["workItemId"], state: workItem.state },
        ...(contextPackageRef ? { contextPackage: contextPackageRef } : {}),
      };
      const sha256 = payloadSha256({ sources, fields });

      await ctx.emit({
        streamName: `dopaiosExecutionContract-${p["contractId"]}`,
        type: "ExecutionContractCompiled",
        data: {
          contractId: p["contractId"],
          revision,
          workItemId: p["workItemId"],
          sources,
          fields,
          sha256,
          compiledBy: p["compiledBy"],
          contextPackageRef: contextPackageRef ?? null,
        },
        metadata: { commandId, audit: true },
      });

      // Sửa hợp đồng = revision mới: supersede revision active cũ trong cùng
      // transaction, và mở impact record cho mỗi lượt ĐANG CHẠY còn pin
      // revision cũ (FR-63: "đánh giá ảnh hưởng tới lượt đang chạy" — phiên
      // giữ pin cũ, không bị đổi âm thầm).
      for (const r of prior.filter((r) => r.state === "active")) {
        await ctx.emit({
          streamName: `dopaiosExecutionContract-${p["contractId"]}`,
          type: "ExecutionContractRevisionStateChanged",
          data: { contractId: p["contractId"], revision: r.revision, state: "superseded" },
          metadata: { commandId, audit: true },
        });
        const running = (await ctx.tx.execute(sql`
          SELECT id FROM dopaios_activations
          WHERE contract_id = ${p["contractId"]} AND contract_revision = ${r.revision}
            AND state = 'RUNNING'
        `)) as unknown as Array<{ id: string }>;
        for (const activation of running) {
          await ctx.emit({
            streamName: `dopaiosImpact-XC-${activation.id}-${revision}`,
            type: "ImpactRecordOpened",
            data: {
              impactId: `IMP-XC-${activation.id}-${revision}`,
              artifactId: p["contractId"],
              artifactRevision: r.revision,
              source: "contract-revised",
              sourceRef: `revision-${revision}`,
            },
            metadata: { commandId, audit: true },
          });
        }
      }

      return { contractId: p["contractId"] as string, revision, sha256 };
    },
  });
}

// Guard dùng ở đường kích hoạt (B4/B5): hợp đồng phải tồn tại đúng pin, còn
// active và đủ trường — thiếu là AI không bắt đầu.
export async function requireActiveContract(
  ctx: CommandContext,
  contractId: string,
  revision: number,
): Promise<{
  fields: Json;
  sha256: string;
  workItemId: string;
  contextPackageRef: { id: string; revision: number; sha256: string } | null;
}> {
  const contract = await one<{
    fields: Json;
    state: string;
    sha256: string;
    work_item_id: string;
    project_id: string | null;
    context_package_id: string | null;
    context_package_revision: number | null;
    context_package_sha256: string | null;
  }>(
    ctx,
    sql`SELECT c.fields, c.state, c.sha256, c.work_item_id, w.project_id,
               c.context_package_id, c.context_package_revision, c.context_package_sha256
        FROM dopaios_execution_contracts c
        JOIN dopaios_work_items w ON w.id = c.work_item_id
        WHERE c.id = ${contractId} AND c.revision = ${revision}`,
  );
  if (!contract) {
    throw new CommandRejectedError(
      "ERR-CONTRACT",
      `Execution contract ${contractId}@${revision} not found — AI must not start (FR-63)`,
    );
  }
  if (contract.state !== "active") {
    throw new CommandRejectedError(
      "ERR-CONTRACT-STATE",
      `Execution contract ${contractId}@${revision} is ${contract.state} — only the active revision may activate`,
    );
  }
  requireContractFields(contract.fields);
  const contextColumns = [
    contract.context_package_id,
    contract.context_package_revision,
    contract.context_package_sha256,
  ];
  if (contextColumns.some((value) => value !== null) && contextColumns.some((value) => value === null)) {
    throw new CommandRejectedError("ERR-CONTEXT-PIN", "Execution contract carries a partial Context Package pin");
  }
  const contextPackageRef = contract.context_package_id
    ? {
        id: contract.context_package_id,
        revision: Number(contract.context_package_revision),
        sha256: contract.context_package_sha256!,
      }
    : null;
  if (contextPackageRef) {
    if (!contract.project_id) {
      throw new CommandRejectedError("ERR-CONTEXT-PIN", "Context-pinned contract has no Project-bound work item");
    }
    await requireApprovedContextPackage(ctx, contextPackageRef, {
      projectId: contract.project_id,
      workItemId: contract.work_item_id,
    });
  }
  return {
    fields: contract.fields,
    sha256: contract.sha256,
    workItemId: contract.work_item_id,
    contextPackageRef,
  };
}
