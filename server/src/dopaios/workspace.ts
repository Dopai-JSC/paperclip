import { resolve, sep } from "node:path";
import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandContext,
  type CommandResult,
  CommandRejectedError,
  payloadSha256,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

// KC-05 B1: vòng đời workspace theo Release trên event store KC-01 (QD-1 kế
// hoạch KC-05 — CTO duyệt 02/08/2026). "Release giả lập" của spike là một SOP
// run test (nếp KC-15/QD-2); mọi tài nguyên tạm — thư mục worktree, cache,
// credential fixture, port — mang scope Release theo FR-17 và ADR-012.
//
//  - Cấp phát port/path/credential NGUYÊN TỬ trong transaction SERIALIZABLE
//    của executeCommand: guard đọc projection trong cùng snapshot, hai
//    provision song song đụng nhau thì SSI hủy một bên (40001) và lần retry
//    thấy tài nguyên đã có chủ → nhận giá trị khác hoặc bị từ chối sạch.
//  - Đĩa vật chất hóa SAU khi cấp phát commit (workspace-fs, B3); bằng chứng
//    vật chất hóa quay lại sổ qua lệnh activate — thiếu bằng chứng thì
//    workspace không ACTIVE (fail-closed).
//  - Đóng theo thứ tự ADR-012: chặn task mới (CLOSING) → purge đúng phạm vi
//    → post-check residue rỗng → event kết quả kèm phạm vi + checksum. Lỗi
//    purge → PURGE_BLOCKED, giữ nguyên tài nguyên, mang hành động khắc phục
//    owner–hạn–phạm vi còn sót (FR-17) — việc đóng KHÔNG được coi là hoàn tất.
//  - Guard hình dạng production theo ASM-001: mọi đường chặn là hành vi của
//    lệnh, không phải assertion riêng của test. Lệnh đi qua
//    executeAuditedCommand để lại vệt audit khi bị chặn (SQR-001); riêng hai
//    guard ĐỌC ngoài đường lệnh — requireActiveWorkspace (fail-closed của
//    worker) và resolveScopedPath (tầng fs) — chặn KHÔNG có vệt event, giới
//    hạn này ghi tại hồ sơ Mục 8 (B7, finding lens 1).

type Json = Record<string, unknown>;

export type WorkspaceCredentialRef = { id: string; sha256: string };

export const WORKSPACE_RESOURCE_TYPES = ["port", "path", "credential"] as const;

function workspaceStream(workspaceId: string): string {
  return `dopaiosWorkspace-${workspaceId}`;
}

type WorkspaceRow = {
  id: string;
  release_id: string;
  state: string;
  rel_path: string;
  cache_rel_path: string;
  port: number;
  credential_ref: WorkspaceCredentialRef;
  base_ref: string;
};

async function loadWorkspace(ctx: CommandContext, workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = (await ctx.tx.execute(sql`
    SELECT id, release_id, state, rel_path, cache_rel_path, port, credential_ref, base_ref
    FROM dopaios_workspaces WHERE id = ${workspaceId}
  `)) as unknown as WorkspaceRow[];
  return rows[0] ?? null;
}

// Đường dẫn tương đối của workspace suy TẤT ĐỊNH từ scope Release — mọi dữ
// liệu tạm nằm dưới đúng một prefix, là căn cứ để kiểm "purge đúng phạm vi".
export function releaseScopePrefix(releaseId: string): string {
  return `releases/${releaseId}/`;
}

// KC-05 B2: guard đường dẫn hình dạng production (ASM-001) — MỌI đường ghi/
// đọc của tầng fs (workspace-fs, B3) phải đi qua đây. Đường tuyệt đối, `..`
// hoặc bất kỳ tổ hợp nào phân giải ra ngoài gốc workspace đều bị chặn
// (FR-17 giới hạn tài nguyên theo scope; NFR-4 quyền tối thiểu).
export function resolveScopedPath(baseAbs: string, relPath: string): string {
  const base = resolve(baseAbs);
  const target = resolve(base, relPath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new CommandRejectedError(
      "ERR-WS-PATH-ESCAPE",
      `Đường dẫn ${relPath} phân giải ra ngoài scope workspace ${baseAbs} — chặn`,
    );
  }
  return target;
}

export async function provisionWorkspace(
  db: Db,
  commandId: string,
  payload: {
    workspaceId: string;
    releaseId: string;
    projectId?: string;
    portPool: number[];
    baseRef: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const releaseId = p["releaseId"] as string;
      const workspaceId = p["workspaceId"] as string;
      const portPool = p["portPool"] as number[];
      if (!Array.isArray(portPool) || portPool.length === 0) {
        throw new CommandRejectedError("ERR-WS-PORT-POOL", "Pool port rỗng — FR-17 fail-closed");
      }
      // Release (run test giả lập) phải tồn tại và chưa terminal — scope của
      // dữ liệu tạm là Release (FR-17); run đã đóng không mở workspace mới.
      const release = (await ctx.tx.execute(sql`
        SELECT state FROM dopaios_sop_runs WHERE id = ${releaseId}
      `)) as unknown as Array<{ state: string }>;
      if (release.length === 0) {
        throw new CommandRejectedError(
          "ERR-WS-RELEASE",
          `Release ${releaseId} không tồn tại trong sổ run — không cấp workspace (FR-17)`,
        );
      }
      if (release[0].state === "COMPLETED" || release[0].state === "CANCELLED") {
        throw new CommandRejectedError(
          "ERR-WS-RELEASE-TERMINAL",
          `Release ${releaseId} đã ${release[0].state} — không cấp workspace mới`,
        );
      }
      // ID workspace không tái sử dụng (nếp SFR-004).
      const existingId = (await ctx.tx.execute(sql`
        SELECT id FROM dopaios_workspaces WHERE id = ${workspaceId}
      `)) as unknown as unknown[];
      if (existingId.length > 0) {
        throw new CommandRejectedError("ERR-WS-ID", `Workspace id ${workspaceId} đã dùng — không tái sử dụng`);
      }
      // Một workspace SỐNG trên một Release (slice KC-05).
      const live = (await ctx.tx.execute(sql`
        SELECT id FROM dopaios_workspaces WHERE release_id = ${releaseId} AND state <> 'PURGED'
      `)) as unknown as Array<{ id: string }>;
      if (live.length > 0) {
        throw new CommandRejectedError(
          "ERR-WS-DUP-RELEASE",
          `Release ${releaseId} đã có workspace sống ${live[0].id} — một Release một workspace`,
        );
      }
      // Port: giá trị TỰ DO đầu tiên trong pool trên cùng snapshot. Hai
      // provision song song cùng thấy một port tự do → SSI hủy một bên,
      // lần retry thấy port đã reserved và nhận port kế tiếp.
      const reservedPorts = (await ctx.tx.execute(sql`
        SELECT value FROM dopaios_workspace_resources
        WHERE resource_type = 'port' AND state = 'reserved'
      `)) as unknown as Array<{ value: string }>;
      const taken = new Set(reservedPorts.map((r) => r.value));
      const port = portPool.find((candidate) => !taken.has(String(candidate)));
      if (port === undefined) {
        throw new CommandRejectedError(
          "ERR-WS-PORT-POOL",
          `Pool port ${JSON.stringify(portPool)} đã cạn — giới hạn tài nguyên theo FR-17, không cấp ngoài pool`,
        );
      }
      // Path + cache suy tất định từ scope Release; credential fixture theo
      // Release (không token thật — FakeEngine toàn phần).
      const relPath = `${releaseScopePrefix(releaseId)}ws`;
      const cacheRelPath = `${releaseScopePrefix(releaseId)}cache`;
      const credentialRef: WorkspaceCredentialRef = {
        id: `CRED-${releaseId}`,
        sha256: payloadSha256({ fixtureCredential: releaseId, workspaceId }),
      };
      // Invariant-check phòng thủ chiều sâu (B7, finding lens 1): path và
      // credential suy tất định từ releaseId nên ở slice này mọi xung đột đều
      // bị ERR-WS-DUP-RELEASE chặn trước — nhánh dưới chỉ chạm được khi luật
      // đặt tên đổi mà guard theo Release chưa đổi theo; giữ để lộ lệch sớm.
      for (const [resourceType, value] of [
        ["path", relPath],
        ["credential", credentialRef.id],
      ] as const) {
        const conflict = (await ctx.tx.execute(sql`
          SELECT workspace_id FROM dopaios_workspace_resources
          WHERE resource_type = ${resourceType} AND value = ${value} AND state = 'reserved'
        `)) as unknown as Array<{ workspace_id: string }>;
        if (conflict.length > 0) {
          throw new CommandRejectedError(
            "ERR-WS-RESOURCE-TAKEN",
            `Tài nguyên ${resourceType}=${value} đang thuộc workspace ${conflict[0].workspace_id} — không giẫm`,
          );
        }
      }
      await ctx.emit({
        streamName: workspaceStream(workspaceId),
        type: "WorkspaceProvisioned",
        data: {
          workspaceId,
          releaseId,
          projectId: (p["projectId"] as string | undefined) ?? null,
          relPath,
          cacheRelPath,
          port,
          credentialRef: credentialRef as unknown as Json,
          baseRef: p["baseRef"],
        },
        expectedVersion: -1,
      });
      for (const [resourceType, value] of [
        ["port", String(port)],
        ["path", relPath],
        ["credential", credentialRef.id],
      ] as const) {
        await ctx.emit({
          streamName: workspaceStream(workspaceId),
          type: "WorkspaceResourceReserved",
          data: { workspaceId, releaseId, resourceType, value },
        });
      }
      return { workspaceId, state: "PROVISIONED", port, relPath, cacheRelPath, credentialRef };
    },
  });
}

// Bằng chứng vật chất hóa từ đĩa quay lại sổ: worktree HEAD + port đã bind.
// Fail-closed: thiếu bằng chứng hoặc bind sai port cấp phát thì không ACTIVE.
export async function activateWorkspace(
  db: Db,
  commandId: string,
  payload: {
    workspaceId: string;
    materialized: { worktreeHead: string; boundPort: number };
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workspace = await loadWorkspace(ctx, p["workspaceId"] as string);
      if (!workspace) {
        throw new CommandRejectedError("ERR-WS-NOT-FOUND", `Workspace ${p["workspaceId"]} không tồn tại`);
      }
      if (workspace.state !== "PROVISIONED") {
        throw new CommandRejectedError(
          "ERR-WS-STATE",
          `Workspace ${workspace.id} ở ${workspace.state} — chỉ PROVISIONED được activate`,
        );
      }
      const materialized = p["materialized"] as { worktreeHead?: string; boundPort?: number } | undefined;
      if (!materialized?.worktreeHead || typeof materialized.boundPort !== "number") {
        throw new CommandRejectedError(
          "ERR-WS-MATERIALIZE",
          "Thiếu bằng chứng vật chất hóa (worktreeHead, boundPort) — không ACTIVE",
        );
      }
      if (materialized.boundPort !== workspace.port) {
        throw new CommandRejectedError(
          "ERR-WS-PORT-MISMATCH",
          `Bind port ${materialized.boundPort} khác port cấp phát ${workspace.port}`,
        );
      }
      // B7 (minor review lens 1): baseRef dạng commit sha thì worktreeHead
      // phải khớp ĐÚNG — bằng chứng vật chất hóa đối chiếu được với pin trong
      // sổ; baseRef dạng ref tượng trưng (fixture B1/B2) không đối chiếu được
      // ở tầng lệnh, ghi giới hạn trust-the-caller tại hồ sơ.
      if (/^[0-9a-f]{40}$/.test(workspace.base_ref) && materialized.worktreeHead !== workspace.base_ref) {
        throw new CommandRejectedError(
          "ERR-WS-HEAD-MISMATCH",
          `worktreeHead ${materialized.worktreeHead} khác baseRef đã pin ${workspace.base_ref}`,
        );
      }
      await ctx.emit({
        streamName: workspaceStream(workspace.id),
        type: "WorkspaceActivated",
        data: { workspaceId: workspace.id, materialized: materialized as Json },
      });
      return { workspaceId: workspace.id, state: "ACTIVE" };
    },
  });
}

// Bước 1 của thứ tự đóng ADR-012: chặn task mới. Sau CLOSING mọi lệnh cấp
// phát/kích hoạt trên workspace này bị guard trạng thái từ chối.
export async function beginWorkspaceClose(
  db: Db,
  commandId: string,
  payload: { workspaceId: string; reason: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workspace = await loadWorkspace(ctx, p["workspaceId"] as string);
      if (!workspace) {
        throw new CommandRejectedError("ERR-WS-NOT-FOUND", `Workspace ${p["workspaceId"]} không tồn tại`);
      }
      if (workspace.state !== "ACTIVE") {
        throw new CommandRejectedError(
          "ERR-WS-STATE",
          `Workspace ${workspace.id} ở ${workspace.state} — chỉ ACTIVE mới bắt đầu đóng`,
        );
      }
      await ctx.emit({
        streamName: workspaceStream(workspace.id),
        type: "WorkspaceCloseStarted",
        data: { workspaceId: workspace.id, reason: p["reason"] },
      });
      return { workspaceId: workspace.id, state: "CLOSING" };
    },
  });
}

export type WorkspacePurgeReport = {
  actor: string;
  // Danh sách đường dẫn (tương đối gốc spike) đã xóa — phải nằm trọn trong
  // prefix scope của Release (purge ĐÚNG phạm vi).
  purgedScope: string[];
  // Checksum nội dung trước khi xóa (ADR-012 — bằng chứng kiểm tra).
  checksums: Record<string, string>;
  // Inventory post-check: còn sót gì dưới prefix scope sau khi xóa.
  residue: string[];
};

export type WorkspacePurgeFailure = {
  reason: string;
  leftoverScope: string[];
  // FR-17 nguyên văn: hành động khắc phục có owner, hạn, TRẠNG THÁI, phạm vi
  // còn sót. state khởi tạo 'open'; purge retry thành công đóng nó qua event
  // (correctiveActionState=closed trên projection) — B7, finding lens 1.
  correctiveAction: { owner: string; dueMs: number; scope: string[]; state: "open" };
};

// Bước cuối của thứ tự đóng ADR-012, hai nhánh:
//  - purged: post-check residue RỖNG, mọi đường trong purgedScope nằm trọn
//    prefix Release → PURGED + release tài nguyên;
//  - failed: PURGE_BLOCKED, GIỮ tài nguyên, hồ sơ thất bại mang hành động
//    khắc phục owner–hạn–phạm vi còn sót (FR-17). Đóng KHÔNG hoàn tất.
export async function recordWorkspacePurge(
  db: Db,
  commandId: string,
  payload:
    | { workspaceId: string; outcome: "purged"; report: WorkspacePurgeReport }
    | { workspaceId: string; outcome: "failed"; failure: WorkspacePurgeFailure },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workspace = await loadWorkspace(ctx, p["workspaceId"] as string);
      if (!workspace) {
        throw new CommandRejectedError("ERR-WS-NOT-FOUND", `Workspace ${p["workspaceId"]} không tồn tại`);
      }
      if (workspace.state !== "CLOSING" && workspace.state !== "PURGE_BLOCKED") {
        throw new CommandRejectedError(
          "ERR-WS-STATE",
          `Workspace ${workspace.id} ở ${workspace.state} — purge chỉ chạy sau khi bắt đầu đóng`,
        );
      }
      // B7 (blocker vòng review đối kháng, cả hai lens): bước 2 của thứ tự
      // ADR-012 — "đóng phiên" — phải là GUARD của lệnh, không phải kỷ luật
      // caller. Còn phiên RUNNING hoặc claim sống trên work-item của Release
      // thì writer có thể ghi tiếp và tái tạo cây scope NGAY SAU khi đĩa vừa
      // xóa (mkdir đệ quy của checkpoint) — sổ ghi "purged sạch" thành nói
      // dối. Đọc projection trong cùng transaction SERIALIZABLE.
      const openWriters = (await ctx.tx.execute(sql`
        SELECT s.id AS session_id, NULL AS activation_id
        FROM dopaios_ai_sessions s
        JOIN dopaios_work_items w ON w.id = s.work_item_id
        WHERE w.run_id = ${workspace.release_id} AND s.state = 'RUNNING'
        UNION ALL
        SELECT NULL AS session_id, a.id AS activation_id
        FROM dopaios_activations a
        JOIN dopaios_work_items w ON w.id = a.work_item_id
        WHERE w.run_id = ${workspace.release_id} AND a.state = 'RUNNING'
      `)) as unknown as Array<{ session_id: string | null; activation_id: string | null }>;
      if (openWriters.length > 0) {
        const detail = openWriters
          .map((w) => w.session_id ?? w.activation_id)
          .join(", ");
        throw new CommandRejectedError(
          "ERR-WS-SESSIONS-OPEN",
          `Release ${workspace.release_id} còn phiên/claim sống (${detail}) — đóng phiên trước khi purge (ADR-012 bước 2)`,
        );
      }
      if (p["outcome"] === "purged") {
        const report = p["report"] as WorkspacePurgeReport | undefined;
        if (!report?.actor || !Array.isArray(report.purgedScope) || !report.checksums || !Array.isArray(report.residue)) {
          throw new CommandRejectedError(
            "ERR-WS-PURGE-REPORT",
            "Hồ sơ purge thiếu trường bắt buộc (actor, purgedScope, checksums, residue) — ADR-012",
          );
        }
        const prefix = releaseScopePrefix(workspace.release_id);
        const outOfScope = report.purgedScope.filter((entry) => !entry.startsWith(prefix));
        if (outOfScope.length > 0) {
          throw new CommandRejectedError(
            "ERR-WS-PURGE-SCOPE",
            `Purge chạm ngoài phạm vi Release ${workspace.release_id}: ${outOfScope.join(", ")}`,
          );
        }
        // B7 (minor review lens 1): evidence ràng với phạm vi — mỗi mục khai
        // xóa phải có checksum nội dung trước khi xóa (ADR-012).
        const missingChecksum = report.purgedScope.filter((entry) => !report.checksums[entry]);
        if (missingChecksum.length > 0) {
          throw new CommandRejectedError(
            "ERR-WS-PURGE-REPORT",
            `Thiếu checksum cho ${missingChecksum.length} mục đã khai xóa (${missingChecksum[0]}…) — ADR-012`,
          );
        }
        if (report.residue.length > 0) {
          throw new CommandRejectedError(
            "ERR-WS-RESIDUE",
            `Post-check còn sót ${report.residue.length} mục dưới scope — không được ghi purged (ADR-012)`,
          );
        }
        await ctx.emit({
          streamName: workspaceStream(workspace.id),
          type: "WorkspacePurged",
          data: {
            workspaceId: workspace.id,
            report: report as unknown as Json,
            // Purge retry thành công sau PURGE_BLOCKED đóng hành động khắc
            // phục của hồ sơ thất bại (FR-17 vòng đời corrective action).
            resolvesCorrectiveAction: workspace.state === "PURGE_BLOCKED",
          },
        });
        for (const [resourceType, value] of [
          ["port", String(workspace.port)],
          ["path", workspace.rel_path],
          ["credential", workspace.credential_ref.id],
        ] as const) {
          await ctx.emit({
            streamName: workspaceStream(workspace.id),
            type: "WorkspaceResourceReleased",
            data: { workspaceId: workspace.id, resourceType, value },
          });
        }
        return { workspaceId: workspace.id, state: "PURGED" };
      }
      // B7 (major review lens 1): từng trường của FR-17 được guard RIÊNG —
      // hạn phải dương, phạm vi còn sót và phạm vi khắc phục không rỗng và
      // nằm trọn prefix Release (nhánh failed trước đây không có guard phạm vi).
      const failure = p["failure"] as WorkspacePurgeFailure | undefined;
      if (!failure?.reason || !Array.isArray(failure.leftoverScope) || !failure.correctiveAction) {
        throw new CommandRejectedError(
          "ERR-WS-PURGE-FAILURE",
          "Hồ sơ thất bại purge thiếu reason/leftoverScope/correctiveAction — FR-17",
        );
      }
      const action = failure.correctiveAction;
      if (!action.owner) {
        throw new CommandRejectedError("ERR-WS-PURGE-FAILURE", "Hành động khắc phục thiếu owner — FR-17");
      }
      if (typeof action.dueMs !== "number" || action.dueMs <= 0) {
        throw new CommandRejectedError("ERR-WS-PURGE-FAILURE", "Hành động khắc phục thiếu hạn dương (dueMs) — FR-17");
      }
      if (action.state !== "open") {
        throw new CommandRejectedError("ERR-WS-PURGE-FAILURE", "Hành động khắc phục phải khởi tạo state 'open' — FR-17");
      }
      const failPrefix = releaseScopePrefix(workspace.release_id);
      if (
        failure.leftoverScope.length === 0 ||
        failure.leftoverScope.some((entry) => !entry.startsWith(failPrefix))
      ) {
        throw new CommandRejectedError(
          "ERR-WS-PURGE-FAILURE",
          `Phạm vi còn sót phải không rỗng và nằm trọn prefix ${failPrefix} — FR-17`,
        );
      }
      if (
        !Array.isArray(action.scope) ||
        action.scope.length === 0 ||
        action.scope.some((entry) => !entry.startsWith(failPrefix))
      ) {
        throw new CommandRejectedError(
          "ERR-WS-PURGE-FAILURE",
          `Phạm vi hành động khắc phục phải không rỗng và nằm trọn prefix ${failPrefix} — FR-17`,
        );
      }
      await ctx.emit({
        streamName: workspaceStream(workspace.id),
        type: "WorkspacePurgeFailed",
        data: { workspaceId: workspace.id, failure: failure as unknown as Json },
      });
      return { workspaceId: workspace.id, state: "PURGE_BLOCKED" };
    },
  });
}

// Guard của đường worker (B3/B4): work-item thuộc một Release chỉ được chạy
// phiên trong workspace ACTIVE của ĐÚNG Release đó — không có workspace sống
// thì không chạy (fail-closed). Tích hợp guard này vào claim của engine
// thuộc FS-004/FS-006; slice giữ ở tầng gọi phiên, ghi giới hạn tại hồ sơ.
export async function requireActiveWorkspace(
  db: Db,
  releaseId: string,
): Promise<{ id: string; relPath: string; cacheRelPath: string; port: number; credentialRef: WorkspaceCredentialRef }> {
  const rows = (await db.execute(sql`
    SELECT id, rel_path, cache_rel_path, port, credential_ref
    FROM dopaios_workspaces WHERE release_id = ${releaseId} AND state = 'ACTIVE'
  `)) as unknown as Array<{
    id: string;
    rel_path: string;
    cache_rel_path: string;
    port: number;
    credential_ref: WorkspaceCredentialRef;
  }>;
  if (rows.length === 0) {
    throw new CommandRejectedError(
      "ERR-WS-NO-ACTIVE",
      `Release ${releaseId} không có workspace ACTIVE — không chạy phiên (FR-17 fail-closed)`,
    );
  }
  return {
    id: rows[0].id,
    relPath: rows[0].rel_path,
    cacheRelPath: rows[0].cache_rel_path,
    port: rows[0].port,
    credentialRef: rows[0].credential_ref,
  };
}

// Cấp quyền đọc credential theo scope (NFR-4 quyền tối thiểu, chiều "chặn cả
// đọc" của KC-09 cho ĐƯỜNG CẤP QUA SỔ): chéo Release, Release đã terminal,
// workspace rời ACTIVE, hoặc actor không phải claimer đang giữ Release — đều
// bị chặn kèm vệt audit. GIỚI HẠN slice (B7, finding lens 1): lệnh này chỉ
// gác đường cấp MỚI; actor đã cầm ref từ trước vẫn đọc được file fixture cho
// tới khi purge xóa file — thu hồi vật lý là bước purge, ghi tại hồ sơ Mục 8.
export async function accessWorkspaceCredential(
  db: Db,
  commandId: string,
  payload: { workspaceId: string; forReleaseId: string; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workspace = await loadWorkspace(ctx, p["workspaceId"] as string);
      if (!workspace) {
        throw new CommandRejectedError("ERR-WS-NOT-FOUND", `Workspace ${p["workspaceId"]} không tồn tại`);
      }
      if (workspace.release_id !== p["forReleaseId"]) {
        throw new CommandRejectedError(
          "ERR-WS-CRED-SCOPE",
          `Credential của Release ${workspace.release_id} không cấp cho ${p["forReleaseId"]} — NFR-4 quyền tối thiểu`,
        );
      }
      if (workspace.state !== "ACTIVE") {
        throw new CommandRejectedError(
          "ERR-WS-CRED-REVOKED",
          `Workspace ${workspace.id} ở ${workspace.state} — không cấp credential khi đã rời ACTIVE (AC-NFR-4.2)`,
        );
      }
      // B7 (major review lens 1): Release kết thúc thì không cấp mới nữa —
      // phạm vi đã đóng theo FR-17, chờ chuỗi đóng workspace chạy.
      const release = (await ctx.tx.execute(sql`
        SELECT state FROM dopaios_sop_runs WHERE id = ${workspace.release_id}
      `)) as unknown as Array<{ state: string }>;
      if (release.length === 0 || release[0].state === "COMPLETED" || release[0].state === "CANCELLED") {
        throw new CommandRejectedError(
          "ERR-WS-RELEASE-TERMINAL",
          `Release ${workspace.release_id} đã kết thúc (${release[0]?.state ?? "unknown"}) — không cấp credential mới`,
        );
      }
      // B7 (major review lens 1): actor không tự khai — phải là claimer của
      // một activation ĐANG RUNNING trên work-item thuộc Release này, đọc
      // trong cùng transaction (permission binding theo AC-FR-47.1).
      const holding = (await ctx.tx.execute(sql`
        SELECT a.id FROM dopaios_activations a
        JOIN dopaios_work_items w ON w.id = a.work_item_id
        WHERE w.run_id = ${workspace.release_id} AND a.state = 'RUNNING'
          AND a.claimed_by = ${p["actor"]}
      `)) as unknown as Array<{ id: string }>;
      if (holding.length === 0) {
        throw new CommandRejectedError(
          "ERR-WS-CRED-ACTOR",
          `Actor ${p["actor"]} không giữ claim RUNNING nào trên Release ${workspace.release_id} — không cấp credential (NFR-4)`,
        );
      }
      await ctx.emit({
        streamName: workspaceStream(workspace.id),
        type: "WorkspaceCredentialAccessed",
        data: { workspaceId: workspace.id, actor: p["actor"], credentialId: workspace.credential_ref.id },
      });
      return { workspaceId: workspace.id, credentialRef: workspace.credential_ref as unknown as Json };
    },
  });
}

// B7 (major review lens 2 — ngõ cụt PROVISIONED): hủy cấp phát khi vật chất
// hóa thất bại hoặc không diễn ra (crash giữa provision-commit và
// materialize). Chỉ từ PROVISIONED — chưa có gì trên đĩa thuộc sổ nên trả
// tài nguyên ngay; workspace sang PURGED (report ghi aborted) để Release cấp
// lại được. Dọn đĩa mồ côi (worktree/branch dở dang) là việc của
// materializeWorkspace idempotent ở lần cấp sau.
export async function abortWorkspace(
  db: Db,
  commandId: string,
  payload: { workspaceId: string; reason: string; actor: string },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workspace = await loadWorkspace(ctx, p["workspaceId"] as string);
      if (!workspace) {
        throw new CommandRejectedError("ERR-WS-NOT-FOUND", `Workspace ${p["workspaceId"]} không tồn tại`);
      }
      if (workspace.state !== "PROVISIONED") {
        throw new CommandRejectedError(
          "ERR-WS-STATE",
          `Workspace ${workspace.id} ở ${workspace.state} — abort chỉ dành cho PROVISIONED chưa vật chất hóa`,
        );
      }
      await ctx.emit({
        streamName: workspaceStream(workspace.id),
        type: "WorkspaceAborted",
        data: {
          workspaceId: workspace.id,
          report: { aborted: true, actor: p["actor"], reason: p["reason"] },
        },
      });
      for (const [resourceType, value] of [
        ["port", String(workspace.port)],
        ["path", workspace.rel_path],
        ["credential", workspace.credential_ref.id],
      ] as const) {
        await ctx.emit({
          streamName: workspaceStream(workspace.id),
          type: "WorkspaceResourceReleased",
          data: { workspaceId: workspace.id, resourceType, value },
        });
      }
      return { workspaceId: workspace.id, state: "PURGED", aborted: true };
    },
  });
}

// B7 (major review lens 1 — nối vòng đời Release ↔ workspace): rule dạng tick
// theo nếp runner KC-13 — run terminal mà workspace còn ACTIVE thì tự bắt đầu
// chuỗi đóng ADR-012, command id tất định theo workspace nên tick lặp là
// idempotent. Chiều ngược (chặn đóng Release khi workspace PURGE_BLOCKED)
// đụng lệnh completeSopRun của nền đã Đạt — ghi giới hạn tại hồ sơ, thuộc FS.
export async function closeWorkspacesForTerminalReleases(db: Db): Promise<Array<Record<string, unknown>>> {
  const stale = (await db.execute(sql`
    SELECT ws.id FROM dopaios_workspaces ws
    JOIN dopaios_sop_runs r ON r.id = ws.release_id
    WHERE ws.state = 'ACTIVE' AND r.state IN ('COMPLETED', 'CANCELLED')
    ORDER BY ws.id
  `)) as unknown as Array<{ id: string }>;
  const results: Array<Record<string, unknown>> = [];
  for (const ws of stale) {
    results.push(
      await beginWorkspaceClose(db, `AUTO-WSCLOSE-${ws.id}`, {
        workspaceId: ws.id,
        reason: "release-terminal",
      }),
    );
  }
  return results;
}
