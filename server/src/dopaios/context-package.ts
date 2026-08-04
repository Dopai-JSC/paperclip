import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type CommandContext,
  type CommandResult,
  type Db,
  CommandRejectedError,
  payloadSha256,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";

type Json = Record<string, unknown>;

export type TokenCounter = {
  id: string;
  count(content: string): number;
};

export type ContextSourceInput = {
  id: string;
  revision: number;
  sha256: string;
  type: "work-item" | "instructions" | "sop" | "project" | "dkp" | string;
  content: string;
  required: boolean;
  trust?: "trusted-instruction" | "trusted-data" | "untrusted-data";
  origin?: "approved-instruction" | "document" | "tool-output";
  reuseScope?: "project" | "global";
};

export type ContextManifestSource = {
  id: string;
  revision: number;
  sha256: string;
  type: string;
  required: boolean;
  priority: number;
  mountState: "mounted" | "omitted";
  omissionReason: string | null;
  contentBytes: number;
  tokenCount: number;
};

export type ContextManifest = {
  package: { id: string; revision: number };
  project: { id: string };
  workItem: { id: string };
  caps: { maxBytes: number; maxTokens: number };
  tokenCounterRef: string;
  hash: { algorithm: "sha256"; scope: "manifest-without-approval" };
  sources: ContextManifestSource[];
  totals: { bytes: number; tokens: number };
  approval: { id: string; revision: number; sha256: string; approvedBy: string } | null;
};

export function sha256Utf8(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return ((await ctx.tx.execute(query)) as unknown as T[])[0];
}

const SOURCE_PRIORITY: Record<string, number> = {
  "work-item": 0,
  instructions: 0,
  sop: 1,
  project: 2,
  dkp: 3,
};

function priorityOf(type: string): number {
  return SOURCE_PRIORITY[type] ?? 4;
}

function untrustedInstructionReason(source: ContextSourceInput): string | null {
  // Trust is derived from the approved ledger type, never from caller-supplied
  // trust/origin labels. Approved instruction and SOP artifacts are the only
  // instruction-bearing sources; every other class is data and is scanned.
  if (source.type === "instructions" || source.type === "sop") return null;
  if (source.reuseScope === "global") return "context-poisoning";
  const normalized = source.content.normalize("NFKC").toLowerCase();
  const overridesInstructions = /ignore\s+(all\s+)?(previous|prior|system)?\s*instructions?/u.test(normalized);
  const requestsSecret = /(reveal|print|return|exfiltrat\w*)[^.\n]{0,80}(credential|secret|token|api\s*key)/u.test(normalized);
  const requestsToolExecution = /(call|invoke|execute|run)[^.\n]{0,80}(tool|command|shell)/u.test(normalized);
  if (overridesInstructions || requestsSecret || requestsToolExecution) {
    return source.type === "tool-output" || source.origin === "tool-output"
      ? "tool-output-injection"
      : "prompt-injection";
  }
  return null;
}

function requiredFailure(reason: string): { code: string; message: string } {
  switch (reason) {
    case "impact-pending":
      return { code: "ERR-CONTEXT-IMPACT", message: "required source is impact-pending" };
    case "hash-mismatch":
    case "content-hash-mismatch":
      return { code: "ERR-CONTEXT-HASH", message: "required source hash does not match its pin" };
    case "unapproved":
    case "retired":
      return { code: "ERR-CONTEXT-UNAPPROVED", message: "required source is not approved" };
    case "scope-missing":
      return { code: "ERR-CONTEXT-SCOPE", message: "required source has no approved Project scope mapping" };
    default:
      return { code: "ERR-CONTEXT-SOURCE", message: `required source is unavailable: ${reason}` };
  }
}

async function sourceDisposition(
  ctx: CommandContext,
  projectId: string,
  source: ContextSourceInput,
): Promise<{ allowed: boolean; reason: string | null }> {
  const artifact = await one<{
    sha256: string;
    artifact_state: string;
    impact_status: string;
    artifact_type: string | null;
  }>(
    ctx,
    sql`SELECT sha256, artifact_state, impact_status, artifact_type
        FROM dopaios_artifacts WHERE id = ${source.id} AND revision = ${source.revision}`,
  );
  if (!artifact) return { allowed: false, reason: "missing" };
  if (artifact.artifact_type !== source.type) return { allowed: false, reason: "type-mismatch" };
  if (artifact.sha256 !== source.sha256) return { allowed: false, reason: "hash-mismatch" };
  if (sha256Utf8(source.content) !== source.sha256) {
    return { allowed: false, reason: "content-hash-mismatch" };
  }
  if (artifact.artifact_state === "retired" || artifact.artifact_state === "superseded") {
    return { allowed: false, reason: "retired" };
  }
  if (artifact.artifact_state !== "approved") return { allowed: false, reason: "unapproved" };
  if (artifact.impact_status !== "clear" && artifact.impact_status !== "reaffirmed") {
    return { allowed: false, reason: "impact-pending" };
  }
  const scope = await one<{ scope_state: string }>(
    ctx,
    sql`SELECT scope_state FROM dopaios_artifact_project_scopes
        WHERE artifact_id = ${source.id} AND artifact_revision = ${source.revision}
          AND project_id = ${projectId}`,
  );
  if (!scope || scope.scope_state !== "active") return { allowed: false, reason: "scope-missing" };
  return { allowed: true, reason: null };
}

export async function bindArtifactProjectScope(
  db: Db,
  commandId: string,
  payload: {
    artifactId: string;
    revision: number;
    projectId: string;
    boundBy: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const artifact = await one<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_artifacts WHERE id = ${p["artifactId"]} AND revision = ${p["revision"]}`,
      );
      const project = await one<{ id: string }>(
        ctx,
        sql`SELECT id FROM dopaios_projects WHERE id = ${p["projectId"]}`,
      );
      if (!artifact || !project) {
        throw new CommandRejectedError(
          "ERR-CONTEXT-SCOPE",
          "Artifact and Project must exist before a scope can be bound",
        );
      }
      await ctx.emit({
        streamName: `dopaiosArtifactScope-${p["artifactId"]}-${p["revision"]}`,
        type: "ArtifactProjectScopeBound",
        data: {
          artifactId: p["artifactId"],
          artifactRevision: p["revision"],
          projectId: p["projectId"],
          scopeState: "active",
          boundBy: p["boundBy"],
        },
        metadata: { commandId, audit: true },
      });
      return { artifactId: p["artifactId"] as string, projectId: p["projectId"] as string };
    },
  });
}

export async function buildContextPackage(
  db: Db,
  commandId: string,
  payload: {
    packageId: string;
    projectId: string;
    workItemId: string;
    createdBy: string;
    caps: { maxBytes: number; maxTokens: number };
    tokenCounter: TokenCounter;
    sources: ContextSourceInput[];
  },
): Promise<{
  packageId: string;
  revision: number;
  sha256: string;
  state: "draft";
  manifest: ContextManifest;
}> {
  const commandPayload = {
    packageId: payload.packageId,
    projectId: payload.projectId,
    workItemId: payload.workItemId,
    createdBy: payload.createdBy,
    caps: payload.caps,
    tokenCounterRef: payload.tokenCounter.id,
    sources: payload.sources,
  };
  const result = await executeAuditedCommand(db, {
    commandId,
    payload: commandPayload as unknown as Json,
    handler: async (ctx, p) => {
      if (
        !Number.isInteger(payload.caps.maxBytes) ||
        !Number.isInteger(payload.caps.maxTokens) ||
        payload.caps.maxBytes < 0 ||
        payload.caps.maxTokens < 0
      ) {
        throw new CommandRejectedError("ERR-CONTEXT-CAP", "Context byte/token caps must be non-negative integers");
      }
      const workItem = await one<{ project_id: string | null }>(
        ctx,
        sql`SELECT project_id FROM dopaios_work_items WHERE id = ${p["workItemId"]}`,
      );
      if (!workItem || workItem.project_id !== p["projectId"]) {
        throw new CommandRejectedError(
          "ERR-CONTEXT-WORKITEM",
          `Work item ${String(p["workItemId"])} is not bound to Project ${String(p["projectId"])}`,
        );
      }
      const project = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_projects WHERE id = ${p["projectId"]}`,
      );
      if (!project || project.state !== "P0_ACTIVE") {
        throw new CommandRejectedError("ERR-CONTEXT-PROJECT", "Project does not allow an AI context package");
      }
      const prior = (await ctx.tx.execute(sql`
        SELECT revision, project_id, work_item_id FROM dopaios_context_packages
        WHERE id = ${p["packageId"]} ORDER BY revision
      `)) as unknown as Array<{ revision: number; project_id: string; work_item_id: string }>;
      if (
        prior.some(
          (row) => row.project_id !== p["projectId"] || row.work_item_id !== p["workItemId"],
        )
      ) {
        throw new CommandRejectedError(
          "ERR-CONTEXT-LINEAGE",
          `Context Package ${String(p["packageId"])} cannot move across Project or work-item lineage`,
        );
      }
      const revision = prior.length === 0 ? 1 : Math.max(...prior.map((row) => row.revision)) + 1;

      const ordered = [...payload.sources].sort((left, right) => {
        const byPriority = priorityOf(left.type) - priorityOf(right.type);
        if (byPriority !== 0) return byPriority;
        if (left.required !== right.required) return left.required ? -1 : 1;
        return left.id.localeCompare(right.id) || left.revision - right.revision;
      });
      const seen = new Set<string>();
      const manifestSources: ContextManifestSource[] = [];
      const projectedSources: Array<ContextManifestSource & { content: string | null }> = [];
      let totalBytes = 0;
      let totalTokens = 0;

      for (const source of ordered) {
        if (typeof source.required !== "boolean") {
          throw new CommandRejectedError(
            "ERR-CONTEXT-REQUIRED",
            `Source ${source.id} must explicitly declare required=true or required=false`,
          );
        }
        const untrustedReason = untrustedInstructionReason(source);
        if (source.required && untrustedReason) {
          throw new CommandRejectedError(
            "ERR-CONTEXT-UNTRUSTED",
            `Required untrusted source ${source.id}@${source.revision} was quarantined: ${untrustedReason}`,
          );
        }
        const key = `${source.id}@${source.revision}`;
        if (seen.has(source.id)) {
          throw new CommandRejectedError(
            "ERR-CONTEXT-DUPLICATE",
            `Context Package cannot mount multiple pins for source ${source.id}`,
          );
        }
        seen.add(source.id);
        const disposition = await sourceDisposition(ctx, payload.projectId, source);
        const contentBytes = Buffer.byteLength(source.content, "utf8");
        const tokenCount = payload.tokenCounter.count(source.content);
        if (!Number.isInteger(tokenCount) || tokenCount < 0) {
          throw new CommandRejectedError("ERR-CONTEXT-TOKEN", "Pinned TokenCounter returned an invalid count");
        }
        let mountState: "mounted" | "omitted" = "mounted";
        let omissionReason: string | null = null;
        if (untrustedReason) {
          mountState = "omitted";
          omissionReason = untrustedReason;
        } else if (!disposition.allowed) {
          if (source.required) {
            const failure = requiredFailure(disposition.reason ?? "unknown");
            throw new CommandRejectedError(failure.code, `${failure.message}: ${key}`);
          }
          mountState = "omitted";
          omissionReason = disposition.reason;
        } else if (totalBytes + contentBytes > payload.caps.maxBytes || totalTokens + tokenCount > payload.caps.maxTokens) {
          if (source.required) {
            throw new CommandRejectedError(
              "ERR-CONTEXT-CAP",
              `Required source ${key} cannot fit without splitting; package creation is blocked`,
            );
          }
          mountState = "omitted";
          omissionReason = "optional-cap-exceeded";
        }
        if (mountState === "mounted") {
          totalBytes += contentBytes;
          totalTokens += tokenCount;
        }
        const item: ContextManifestSource = {
          id: source.id,
          revision: source.revision,
          sha256: source.sha256,
          type: source.type,
          required: source.required,
          priority: priorityOf(source.type),
          mountState,
          omissionReason,
          contentBytes,
          tokenCount,
        };
        manifestSources.push(item);
        projectedSources.push({ ...item, content: mountState === "mounted" ? source.content : null });
      }

      const manifest: ContextManifest = {
        package: { id: payload.packageId, revision },
        project: { id: payload.projectId },
        workItem: { id: payload.workItemId },
        caps: payload.caps,
        tokenCounterRef: payload.tokenCounter.id,
        hash: { algorithm: "sha256", scope: "manifest-without-approval" },
        sources: manifestSources,
        totals: { bytes: totalBytes, tokens: totalTokens },
        approval: null,
      };
      const sha256 = payloadSha256({ ...manifest, approval: undefined });
      await ctx.emit({
        streamName: `dopaiosContextPackage-${payload.packageId}`,
        type: "ContextPackageBuilt",
        data: {
          packageId: payload.packageId,
          revision,
          projectId: payload.projectId,
          workItemId: payload.workItemId,
          state: "draft",
          sha256,
          manifest,
          maxBytes: payload.caps.maxBytes,
          maxTokens: payload.caps.maxTokens,
          totalBytes,
          totalTokens,
          createdBy: payload.createdBy,
          sources: projectedSources,
        },
        metadata: { commandId, audit: true },
      });
      return { packageId: payload.packageId, revision, sha256, state: "draft", manifest };
    },
  });
  return result as unknown as {
    packageId: string;
    revision: number;
    sha256: string;
    state: "draft";
    manifest: ContextManifest;
  };
}

export async function approveContextPackage(
  db: Db,
  commandId: string,
  payload: {
    packageRef: { id: string; revision: number; sha256: string };
    approvalRef: { id: string; revision: number; sha256: string };
    approvedBy: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const packageRef = p["packageRef"] as typeof payload.packageRef;
      const approvalRef = p["approvalRef"] as typeof payload.approvalRef;
      const context = await one<{ state: string; sha256: string; project_id: string }>(
        ctx,
        sql`SELECT state, sha256, project_id FROM dopaios_context_packages
            WHERE id = ${packageRef.id} AND revision = ${packageRef.revision}`,
      );
      if (!context || context.state !== "draft" || context.sha256 !== packageRef.sha256) {
        throw new CommandRejectedError("ERR-CONTEXT-PIN", "Context package draft does not match the exact pin");
      }
      const ledger = await one<{ artifact_state: string; impact_status: string; sha256: string; artifact_type: string | null }>(
        ctx,
        sql`SELECT artifact_state, impact_status, sha256, artifact_type FROM dopaios_artifacts
            WHERE id = ${packageRef.id} AND revision = ${packageRef.revision}`,
      );
      if (
        !ledger ||
        ledger.artifact_state !== "approved" ||
        (ledger.impact_status !== "clear" && ledger.impact_status !== "reaffirmed") ||
        ledger.sha256 !== packageRef.sha256 ||
        ledger.artifact_type !== "context-package"
      ) {
        throw new CommandRejectedError("ERR-CONTEXT-UNAPPROVED", "Context package ledger approval is missing or stale");
      }
      const approval = await one<{ artifact_state: string; impact_status: string; sha256: string; artifact_type: string | null }>(
        ctx,
        sql`SELECT artifact_state, impact_status, sha256, artifact_type FROM dopaios_artifacts
            WHERE id = ${approvalRef.id} AND revision = ${approvalRef.revision}`,
      );
      const approvalScope = await one<{ scope_state: string }>(
        ctx,
        sql`SELECT scope_state FROM dopaios_artifact_project_scopes
            WHERE artifact_id = ${approvalRef.id} AND artifact_revision = ${approvalRef.revision}
              AND project_id = ${context.project_id}`,
      );
      if (
        !approval ||
        approval.artifact_state !== "approved" ||
        (approval.impact_status !== "clear" && approval.impact_status !== "reaffirmed") ||
        approval.sha256 !== approvalRef.sha256 ||
        approval.artifact_type !== "approval-record" ||
        approvalScope?.scope_state !== "active"
      ) {
        throw new CommandRejectedError("ERR-CONTEXT-APPROVAL", "Approval triple is missing, unapproved, stale, or out of Project scope");
      }
      await ctx.emit({
        streamName: `dopaiosContextPackage-${packageRef.id}`,
        type: "ContextPackageApproved",
        data: {
          packageId: packageRef.id,
          revision: packageRef.revision,
          approvalRef,
          approvedBy: p["approvedBy"],
        },
        metadata: { commandId, audit: true },
      });
      return { ...packageRef, state: "approved" };
    },
  });
}

export async function requireApprovedContextPackage(
  ctx: CommandContext,
  ref: { id: string; revision: number; sha256: string },
  expected: { projectId: string; workItemId: string },
): Promise<{ manifest: ContextManifest }> {
  const row = await one<{
    state: string;
    sha256: string;
    project_id: string;
    work_item_id: string;
    manifest: ContextManifest;
  }>(
    ctx,
    sql`SELECT state, sha256, project_id, work_item_id, manifest
        FROM dopaios_context_packages WHERE id = ${ref.id} AND revision = ${ref.revision}`,
  );
  if (
    !row ||
    row.state !== "approved" ||
    row.sha256 !== ref.sha256 ||
    row.project_id !== expected.projectId ||
    row.work_item_id !== expected.workItemId
  ) {
    throw new CommandRejectedError(
      "ERR-CONTEXT-PIN",
      `Approved context package ${ref.id}@${ref.revision} does not match Project/work-item/exact hash`,
    );
  }
  const ledger = await one<{
    artifact_state: string;
    impact_status: string;
    sha256: string;
    artifact_type: string | null;
  }>(
    ctx,
    sql`SELECT artifact_state, impact_status, sha256, artifact_type FROM dopaios_artifacts
        WHERE id = ${ref.id} AND revision = ${ref.revision}`,
  );
  if (
    !ledger ||
    ledger.artifact_state !== "approved" ||
    (ledger.impact_status !== "clear" && ledger.impact_status !== "reaffirmed") ||
    ledger.sha256 !== ref.sha256 ||
    ledger.artifact_type !== "context-package"
  ) {
    throw new CommandRejectedError(
      "ERR-CONTEXT-UNAPPROVED",
      `Context package ${ref.id}@${ref.revision} is stale, unapproved, retired, or impact-pending in the current ledger`,
    );
  }
  const blockedSources = (await ctx.tx.execute(sql`
    SELECT s.source_id, s.source_revision, a.artifact_state, a.impact_status,
           a.sha256 AS artifact_sha256, scope.scope_state
    FROM dopaios_context_package_sources s
    LEFT JOIN dopaios_artifacts a
      ON a.id = s.source_id AND a.revision = s.source_revision
    LEFT JOIN dopaios_artifact_project_scopes scope
      ON scope.artifact_id = s.source_id AND scope.artifact_revision = s.source_revision
     AND scope.project_id = ${expected.projectId}
    WHERE s.context_package_id = ${ref.id} AND s.context_package_revision = ${ref.revision}
      AND s.mount_state = 'mounted'
      AND (
        a.id IS NULL OR a.artifact_state <> 'approved'
        OR a.impact_status NOT IN ('clear', 'reaffirmed')
        OR a.sha256 <> s.source_sha256 OR scope.scope_state IS DISTINCT FROM 'active'
      )
  `)) as unknown as Array<{
    source_id: string;
    source_revision: number;
    impact_status: string | null;
  }>;
  if (blockedSources.length > 0) {
    const blocked = blockedSources[0];
    throw new CommandRejectedError(
      blocked.impact_status === "impact-pending" ? "ERR-CONTEXT-IMPACT" : "ERR-CONTEXT-SOURCE",
      `Mounted source ${blocked.source_id}@${blocked.source_revision} no longer satisfies current Project policy`,
    );
  }
  return { manifest: row.manifest };
}
