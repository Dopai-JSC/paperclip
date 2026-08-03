import { sql } from "drizzle-orm";
import {
  type CommandContext,
  type CommandResult,
  type Db,
  CommandRejectedError,
  CommandPayloadMismatchError,
  executeCommand,
  payloadSha256,
} from "./event-store.js";
import { executeAuditedCommand } from "./approval.js";
import { requireActiveContract } from "./contract.js";
import { sha256Utf8 } from "./context-package.js";

type Json = Record<string, unknown>;
type ExactRef = { id: string; revision: number; sha256: string };
type OpaqueCredentialRef =
  | { secretRef: string }
  | {
      secretRef: string;
      issuedAt: string;
      expiresAt: string;
      rotationEpoch: number;
      revokedAt: string | null;
    };
type ConnectorPolicyApprovalRef = { recordId: string };

const MAX_TIMER_MS = 2_147_483_647;
const MAX_RETRY_ATTEMPTS = 3;
const POLICY_PRECEDENCE = ["work-item", "Project", "SOP", "company"] as const;

type ConnectorConfigurationContract = {
  schema: "dopaios.connector-policy/v1";
  type: "object";
  unit: "request";
  range: {
    maxPayloadBytes: number;
    allowedTopLevelKeys: string[];
  };
};

type ConnectorInterruptionPolicy = {
  auth: "stop";
  quota: "stop";
  policy: "stop";
  transient: "retry";
  timeout: "stop";
};

export type ConnectorPolicyInput = {
  policyId: string;
  policyRevision: number;
  configuration: ConnectorConfigurationContract;
  scopeLevel: "Project";
  precedence: [...typeof POLICY_PRECEDENCE];
  approverCapability: string;
  effectiveAt: string;
  invalidation: { mode: "artifact-state-or-time"; expiresAt: string | null };
  connector: { id: string; version: string };
  projectId: string;
  purpose: string;
  action: string;
  direction: string;
  auth: { type: string; credentialRef: OpaqueCredentialRef };
  runtime: string;
  environment: string;
  dataClasses: Array<{ name: string; policyRef: ExactRef }>;
  lifecyclePolicyRef: ExactRef;
  retentionPolicyRef: ExactRef;
  scopes: string[];
  rateLimit: { limit: number; windowMs: number };
  timeoutMs: number;
  interruption: ConnectorInterruptionPolicy;
  retry: { transientMaxAttempts: number };
  backoff: { strategy: "fixed" | "exponential"; delayMs: number; maxDelayMs?: number };
  circuitBreaker: { threshold: number; reset: { mode: "after"; delayMs: number } };
  idempotency: { key: "requestId"; guarantee: "at-most-once" };
  reconciliation: { required: true; onAmbiguous: "escalate" };
  fallback:
    | { mode: "none" }
    | {
        mode: "file";
        ref: string;
        projectId: string;
        contextPackageRef: ExactRef;
        contentSha256: string;
        approvedBy: string;
      };
  audit: { mode: "structured"; appendOnlySource: "message_store"; deniedBeforeSideEffect: true };
  redaction: { keys: string[] };
  approvalRef: ConnectorPolicyApprovalRef;
  createdBy: string;
};

export type ConnectorExecutionInput = {
  requestId: string;
  projectId: string;
  action: string;
  payload: Record<string, unknown>;
  externalIdempotencyKey: string;
  signal: AbortSignal;
};

export type ConnectorAdapterIdentity = {
  connector: { id: string; version: string };
  runtime: string;
  environment: string;
  authType: string;
  credentialRef: OpaqueCredentialRef;
  supportsExternalIdempotency: boolean;
};

export interface ConnectorAdapter {
  readonly identity: ConnectorAdapterIdentity;
  execute(input: ConnectorExecutionInput): Promise<Record<string, unknown>>;
}

export type ConnectorGatewayRuntime = {
  now(): Date;
  sleep(delayMs: number): Promise<void>;
  loadStaticFallback(input: {
    ref: string;
    projectId: string;
    contextPackageRef: ExactRef;
    signal: AbortSignal;
  }): Promise<{ contentUtf8: string; value: Record<string, unknown> }>;
};

const defaultRuntime: ConnectorGatewayRuntime = {
  now: () => new Date(),
  sleep: async (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  loadStaticFallback: async () => {
    throw new ConnectorDeniedError("fallback-loader-missing");
  },
};

export type ConnectorRequest = {
  requestId: string;
  actorId: string;
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
  connector: { id: string; version: string };
  projectId: string;
  purpose: string;
  action: string;
  direction: string;
  dataClasses: string[];
  scopes: string[];
  payload: Record<string, unknown>;
};

export class ConnectorDeniedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Connector request denied: ${reasonCode}`);
    this.name = "ConnectorDeniedError";
  }
}

export class ConnectorReconciliationRequiredError extends Error {
  readonly kind = "reconciliation-required" as const;

  constructor(readonly reasonCode: string, options?: { cause?: unknown }) {
    super(`Connector outcome requires reconciliation: ${reasonCode}`, options);
    this.name = "ConnectorReconciliationRequiredError";
  }
}

export function connectorPolicyApprovalSha256(policy: ConnectorPolicyInput): string {
  const { approvalRef: _approvalRef, ...candidate } = policy;
  return payloadSha256(candidate);
}

function errorKind(error: unknown): "auth" | "quota" | "policy" | "transient" | "timeout" {
  const kind = (error as { kind?: string })?.kind;
  if (kind === "auth" || kind === "quota" || kind === "policy" || kind === "transient" || kind === "timeout") {
    return kind;
  }
  return "policy";
}

function retrySafeTransient(error: unknown): boolean {
  return errorKind(error) === "transient" &&
    (error as { retrySafe?: unknown })?.retrySafe === true;
}

class ConnectorTimeoutError extends Error {
  readonly kind = "timeout" as const;

  constructor(timeoutMs: number) {
    super(`Connector exceeded its materialized timeout of ${timeoutMs}ms`);
    this.name = "ConnectorTimeoutError";
  }
}

function trustedNow(runtime: ConnectorGatewayRuntime): Date {
  const observedAt = runtime.now();
  if (!Number.isFinite(observedAt.getTime())) throw new ConnectorDeniedError("trusted-clock-invalid");
  return observedAt;
}

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | undefined> {
  return ((await ctx.tx.execute(query)) as unknown as T[])[0];
}

async function validatePolicyArtifact(
  ctx: CommandContext,
  projectId: string,
  ref: ExactRef,
  expectedType: string,
): Promise<void> {
  const row = await one<{
    sha256: string;
    artifact_state: string;
    impact_status: string;
    artifact_type: string | null;
    scope_state: string | null;
  }>(
    ctx,
    sql`SELECT a.sha256, a.artifact_state, a.impact_status, a.artifact_type, s.scope_state
        FROM dopaios_artifacts a
        LEFT JOIN dopaios_artifact_project_scopes s
          ON s.artifact_id = a.id AND s.artifact_revision = a.revision
         AND s.project_id = ${projectId}
        WHERE a.id = ${ref.id} AND a.revision = ${ref.revision}`,
  );
  if (
    !row ||
    row.sha256 !== ref.sha256 ||
    row.artifact_state !== "approved" ||
    (row.impact_status !== "clear" && row.impact_status !== "reaffirmed") ||
    row.artifact_type !== expectedType ||
    row.scope_state !== "active"
  ) {
    throw new CommandRejectedError(
      "ERR-CONNECTOR-POLICY-REF",
      `${expectedType} ${ref.id}@${ref.revision} is missing, stale, unapproved, impacted, or out of Project scope`,
    );
  }
}

async function connectorPolicyApprovalAllowed(
  ctx: CommandContext,
  policy: Pick<
    ConnectorPolicyInput,
    "policyId" | "policyRevision" | "projectId" | "approverCapability" | "approvalRef"
  > & { approvalTargetSha256: string },
  options: { allowSupersededArtifact?: boolean } = {},
): Promise<boolean> {
  const row = await one<{
    outcome: string;
    target_id: string | null;
    target_revision: number | null;
    target_sha256: string | null;
    approved_scope: { kind?: string } | null;
    invalidated_at: Date | string | null;
    actor_active: boolean | null;
    actor_kind: string | null;
    actor_capabilities: string[] | null;
    artifact_state: string | null;
    artifact_sha256: string | null;
    artifact_type: string | null;
    impact_status: string | null;
    scope_state: string | null;
  }>(
    ctx,
    sql`SELECT r.outcome, r.target_id, r.target_revision, r.target_sha256,
               r.approved_scope, r.invalidated_at,
               actor.active AS actor_active, actor.kind AS actor_kind,
               actor.capabilities AS actor_capabilities,
               artifact.artifact_state, artifact.sha256 AS artifact_sha256,
               artifact.artifact_type, artifact.impact_status, scope.scope_state
        FROM dopaios_approval_records r
        LEFT JOIN dopaios_actors actor ON actor.id = r.actor
        LEFT JOIN dopaios_artifacts artifact
          ON artifact.id = r.target_id AND artifact.revision = r.target_revision
        LEFT JOIN dopaios_artifact_project_scopes scope
          ON scope.artifact_id = r.target_id AND scope.artifact_revision = r.target_revision
         AND scope.project_id = ${policy.projectId}
        WHERE r.id = ${policy.approvalRef.recordId}`,
  );
  return Boolean(
    row &&
      row.outcome === "approve" &&
      row.target_id === policy.policyId &&
      Number(row.target_revision) === policy.policyRevision &&
      row.target_sha256 === policy.approvalTargetSha256 &&
      row.approved_scope?.kind === "full-revision" &&
      row.invalidated_at === null &&
      row.actor_active === true &&
      row.actor_kind === "human" &&
      row.actor_capabilities?.includes(policy.approverCapability) &&
      (row.artifact_state === "approved" ||
        (options.allowSupersededArtifact === true && row.artifact_state === "superseded")) &&
      row.artifact_sha256 === policy.approvalTargetSha256 &&
      row.artifact_type === "connector-policy" &&
      (row.impact_status === "clear" || row.impact_status === "reaffirmed") &&
      row.scope_state === "active",
  );
}

async function validateConnectorPolicyApproval(
  ctx: CommandContext,
  policy: ConnectorPolicyInput,
): Promise<void> {
  if (
    !(await connectorPolicyApprovalAllowed(ctx, {
      ...policy,
      approvalTargetSha256: connectorPolicyApprovalSha256(policy),
    }))
  ) {
    throw new CommandRejectedError(
      "ERR-CONNECTOR-APPROVAL",
      `Approval record ${policy.approvalRef.recordId} is not bound to the exact connector policy target, full scope, and required human capability`,
    );
  }
}

function requireCanonicalDate(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new CommandRejectedError("ERR-CONNECTOR-POLICY-SHAPE", `${field} must be a canonical ISO-8601 timestamp`);
  }
  return timestamp;
}

function isExactOpaqueCredentialRef(value: unknown): value is OpaqueCredentialRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (typeof candidate.secretRef !== "string" || !/^secret:\/\/[A-Za-z0-9._~:/-]+$/u.test(candidate.secretRef)) {
    return false;
  }
  if (keys.length === 1 && keys[0] === "secretRef") return true;
  if (keys.join(",") !== "expiresAt,issuedAt,revokedAt,rotationEpoch,secretRef") return false;
  if (
    typeof candidate.issuedAt !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    !Number.isInteger(candidate.rotationEpoch) ||
    Number(candidate.rotationEpoch) < 1 ||
    (candidate.revokedAt !== null && typeof candidate.revokedAt !== "string")
  ) {
    return false;
  }
  const issuedAt = Date.parse(candidate.issuedAt);
  const expiresAt = Date.parse(candidate.expiresAt);
  const revokedAt = candidate.revokedAt === null ? null : Date.parse(candidate.revokedAt as string);
  return Number.isFinite(issuedAt) &&
    new Date(issuedAt).toISOString() === candidate.issuedAt &&
    Number.isFinite(expiresAt) &&
    new Date(expiresAt).toISOString() === candidate.expiresAt &&
    expiresAt > issuedAt &&
    (revokedAt === null ||
      (Number.isFinite(revokedAt) && new Date(revokedAt).toISOString() === candidate.revokedAt && revokedAt >= issuedAt));
}

function requirePolicyShape(policy: ConnectorPolicyInput): void {
  const scalarValues = [
    policy.policyId,
    policy.approverCapability,
    policy.effectiveAt,
    policy.connector?.id,
    policy.connector?.version,
    policy.projectId,
    policy.purpose,
    policy.action,
    policy.direction,
    policy.auth?.type,
    policy.runtime,
    policy.environment,
    policy.createdBy,
  ];
  if (scalarValues.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new CommandRejectedError("ERR-CONNECTOR-POLICY-SHAPE", "Connector policy is missing a required scalar field");
  }
  const objectValues = [
    policy.configuration,
    policy.invalidation,
    policy.auth?.credentialRef,
    policy.lifecyclePolicyRef,
    policy.retentionPolicyRef,
    policy.rateLimit,
    policy.interruption,
    policy.retry,
    policy.backoff,
    policy.circuitBreaker,
    policy.idempotency,
    policy.reconciliation,
    policy.fallback,
    policy.audit,
    policy.redaction,
    policy.approvalRef,
  ];
  if (objectValues.some((value) => !value || typeof value !== "object")) {
    throw new CommandRejectedError("ERR-CONNECTOR-POLICY-SHAPE", "Connector policy is missing a required object field");
  }
  if (!isExactOpaqueCredentialRef(policy.auth?.credentialRef)) {
    throw new CommandRejectedError(
      "ERR-CONNECTOR-CREDENTIAL-REF",
      "Connector credentials must be represented by one opaque secret:// reference and never inline material",
    );
  }
  if ("revokedAt" in policy.auth.credentialRef && policy.auth.credentialRef.revokedAt !== null) {
    throw new CommandRejectedError(
      "ERR-CONNECTOR-CREDENTIAL-REVOKED",
      "A revoked credential reference cannot be materialized into an executable connector policy",
    );
  }
  if (
    Object.keys(policy.approvalRef).length !== 1 ||
    typeof policy.approvalRef.recordId !== "string" ||
    policy.approvalRef.recordId.trim().length === 0
  ) {
    throw new CommandRejectedError(
      "ERR-CONNECTOR-APPROVAL",
      "Connector policy approvalRef must contain exactly one KC-03 approval record ID",
    );
  }
  const effectiveAt = requireCanonicalDate(policy.effectiveAt, "effectiveAt");
  const expiresAt = policy.invalidation.expiresAt === null
    ? null
    : requireCanonicalDate(policy.invalidation.expiresAt, "invalidation.expiresAt");
  const configurationValid =
    policy.configuration.schema === "dopaios.connector-policy/v1" &&
    policy.configuration.type === "object" &&
    policy.configuration.unit === "request" &&
    policy.configuration.range &&
    typeof policy.configuration.range === "object" &&
    Number.isInteger(policy.configuration.range.maxPayloadBytes) &&
    policy.configuration.range.maxPayloadBytes > 0 &&
    policy.configuration.range.maxPayloadBytes <= 10 * 1024 * 1024 &&
    Array.isArray(policy.configuration.range.allowedTopLevelKeys) &&
    policy.configuration.range.allowedTopLevelKeys.length > 0 &&
    policy.configuration.range.allowedTopLevelKeys.every(
      (key) => typeof key === "string" && key.trim().length > 0,
    ) &&
    new Set(policy.configuration.range.allowedTopLevelKeys).size ===
      policy.configuration.range.allowedTopLevelKeys.length;
  const precedenceValid =
    Array.isArray(policy.precedence) &&
    policy.precedence.length === POLICY_PRECEDENCE.length &&
    policy.precedence.every((value, index) => value === POLICY_PRECEDENCE[index]);
  const interruptionValid =
    policy.interruption.auth === "stop" &&
    policy.interruption.quota === "stop" &&
    policy.interruption.policy === "stop" &&
    policy.interruption.transient === "retry" &&
    policy.interruption.timeout === "stop";
  const idempotencyValid =
    policy.idempotency.key === "requestId" && policy.idempotency.guarantee === "at-most-once";
  const reconciliationValid =
    policy.reconciliation.required === true && policy.reconciliation.onAmbiguous === "escalate";
  const auditValid =
    policy.audit.mode === "structured" &&
    policy.audit.appendOnlySource === "message_store" &&
    policy.audit.deniedBeforeSideEffect === true;
  if (
    !Number.isInteger(policy.policyRevision) ||
    policy.policyRevision < 1 ||
    !configurationValid ||
    policy.scopeLevel !== "Project" ||
    !precedenceValid ||
    policy.invalidation.mode !== "artifact-state-or-time" ||
    (expiresAt !== null && expiresAt <= effectiveAt) ||
    !interruptionValid ||
    !idempotencyValid ||
    !reconciliationValid ||
    !auditValid ||
    policy.dataClasses.length === 0 ||
    policy.scopes.length === 0 ||
    policy.scopes.some((scope) => typeof scope !== "string" || scope.trim().length === 0) ||
    !Number.isInteger(policy.rateLimit.limit) ||
    policy.rateLimit.limit < 1 ||
    !Number.isInteger(policy.rateLimit.windowMs) ||
    policy.rateLimit.windowMs < 1 ||
    !Number.isInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 || policy.timeoutMs > MAX_TIMER_MS ||
    !Number.isInteger(policy.retry.transientMaxAttempts) ||
    policy.retry.transientMaxAttempts < 1 || policy.retry.transientMaxAttempts > MAX_RETRY_ATTEMPTS ||
    !Number.isInteger(policy.backoff.delayMs) ||
    policy.backoff.delayMs < 0 || policy.backoff.delayMs > MAX_TIMER_MS ||
    (policy.backoff.maxDelayMs !== undefined &&
      (!Number.isInteger(policy.backoff.maxDelayMs) ||
        policy.backoff.maxDelayMs < 0 ||
        policy.backoff.maxDelayMs > MAX_TIMER_MS ||
        policy.backoff.maxDelayMs < policy.backoff.delayMs)) ||
    (policy.backoff.strategy !== "fixed" && policy.backoff.strategy !== "exponential") ||
    !Number.isInteger(policy.circuitBreaker.threshold) ||
    policy.circuitBreaker.threshold < 1 ||
    policy.circuitBreaker.reset?.mode !== "after" ||
    !Number.isInteger(policy.circuitBreaker.reset?.delayMs) ||
    policy.circuitBreaker.reset.delayMs < 1 ||
    policy.circuitBreaker.reset.delayMs > MAX_TIMER_MS
  ) {
    throw new CommandRejectedError("ERR-CONNECTOR-POLICY-SHAPE", "Connector limits and class/scope lists are invalid");
  }
  if (
    policy.fallback.mode === "file" &&
    (!policy.fallback.ref ||
      !policy.fallback.approvedBy ||
      policy.fallback.projectId !== policy.projectId ||
      !policy.fallback.contextPackageRef ||
      !/^[0-9a-f]{64}$/u.test(policy.fallback.contentSha256) ||
      policy.fallback.contextPackageRef.sha256 !== policy.fallback.contentSha256)
  ) {
    throw new CommandRejectedError(
      "ERR-CONNECTOR-FALLBACK",
      "Static fallback requires a Project-bound context-package triple, canonical content hash, file ref, and approver",
    );
  }
}

export async function materializeConnectorPolicy(
  db: Db,
  commandId: string,
  policy: ConnectorPolicyInput,
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: policy as unknown as Json,
    handler: async (ctx) => {
      requirePolicyShape(policy);
      const project = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_projects WHERE id = ${policy.projectId}`,
      );
      if (!project || project.state !== "P0_ACTIVE") {
        throw new CommandRejectedError("ERR-CONNECTOR-PROJECT", "Project is not active for connector materialization");
      }
      await validatePolicyArtifact(ctx, policy.projectId, policy.lifecyclePolicyRef, "lifecycle-policy");
      await validatePolicyArtifact(ctx, policy.projectId, policy.retentionPolicyRef, "retention-policy");
      await validateConnectorPolicyApproval(ctx, policy);
      if ("rotationEpoch" in policy.auth.credentialRef) {
        const credentialRef = policy.auth.credentialRef;
        const existingCredential = await one<{
          issued_at: Date | string;
          expires_at: Date | string;
          revoked_at: Date | string | null;
        }>(
          ctx,
          sql`SELECT issued_at, expires_at, revoked_at
              FROM dopaios_connector_credentials
              WHERE secret_ref = ${credentialRef.secretRef}
                AND rotation_epoch = ${credentialRef.rotationEpoch}`,
        );
        if (
          existingCredential &&
          (new Date(existingCredential.issued_at).toISOString() !== credentialRef.issuedAt ||
            new Date(existingCredential.expires_at).toISOString() !== credentialRef.expiresAt ||
            existingCredential.revoked_at !== null)
        ) {
          throw new CommandRejectedError(
            "ERR-CONNECTOR-CREDENTIAL-CONFLICT",
            "A secret reference and rotation epoch must retain one immutable issue, expiry, and revocation lifecycle",
          );
        }
      }
      const existingScope = await one<{ policy_id: string; latest_revision: number }>(
        ctx,
        sql`SELECT policy_id, max(policy_revision)::int AS latest_revision
            FROM dopaios_connector_policies
            WHERE connector_id = ${policy.connector.id}
              AND connector_version = ${policy.connector.version}
              AND project_id = ${policy.projectId}
              AND purpose = ${policy.purpose}
              AND action = ${policy.action}
              AND direction = ${policy.direction}
            GROUP BY policy_id`,
      );
      if (existingScope && existingScope.policy_id !== policy.policyId) {
        throw new CommandRejectedError(
          "ERR-CONNECTOR-POLICY-IDENTITY",
          "A connector policy scope must retain one stable policy_id across revisions",
        );
      }
      const expectedRevision = (existingScope?.latest_revision ?? 0) + 1;
      if (policy.policyRevision !== expectedRevision) {
        throw new CommandRejectedError(
          "ERR-CONNECTOR-POLICY-REVISION",
          `Connector policy ${policy.policyId} requires revision ${expectedRevision}`,
        );
      }
      const classNames = new Set<string>();
      for (const dataClass of policy.dataClasses) {
        if (!dataClass.name || classNames.has(dataClass.name)) {
          throw new CommandRejectedError("ERR-CONNECTOR-DATA-CLASS", "Data classes must be named and unique");
        }
        classNames.add(dataClass.name);
        await validatePolicyArtifact(ctx, policy.projectId, dataClass.policyRef, "data-policy");
      }
      if (policy.fallback.mode === "file") {
        await validatePolicyArtifact(
          ctx,
          policy.projectId,
          policy.fallback.contextPackageRef,
          "context-package",
        );
      }
      const sha256 = payloadSha256(policy);
      await ctx.emit({
        streamName: `dopaiosConnectorPolicy-${policy.policyId}`,
        type: "ConnectorPolicyMaterialized",
        data: { ...policy, state: "approved", sha256 },
        metadata: { commandId, audit: true },
        expectedVersion: policy.policyRevision - 2,
      });
      return { policyId: policy.policyId, policyRevision: policy.policyRevision, state: "approved", sha256 };
    },
  });
}

export async function revokeConnectorCredential(
  db: Db,
  commandId: string,
  payload: {
    policyId: string;
    policyRevision: number;
    secretRef: string;
    rotationEpoch: number;
    revokedAt: string;
    actorId: string;
  },
): Promise<CommandResult> {
  return executeAuditedCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const actorId = p["actorId"] as string;
      const actor = await one<{ active: boolean; capabilities: string[] }>(
        ctx,
        sql`SELECT active, capabilities FROM dopaios_actors WHERE id = ${actorId}`,
      );
      if (!actor?.active || !actor.capabilities.includes("credential-admin")) {
        throw new CommandRejectedError(
          "ERR-CONNECTOR-CREDENTIAL-AUTH",
          `Actor ${actorId} is not an active registered credential administrator`,
        );
      }
      const revokedAt = p["revokedAt"] as string;
      const revokedTimestamp = Date.parse(revokedAt);
      if (!Number.isFinite(revokedTimestamp) || new Date(revokedTimestamp).toISOString() !== revokedAt) {
        throw new CommandRejectedError(
          "ERR-CONNECTOR-CREDENTIAL-TIME",
          "revokedAt must be a canonical ISO-8601 timestamp",
        );
      }
      const credential = await one<{
        credential_ref: OpaqueCredentialRef;
        issued_at: Date | string | null;
        revoked_at: Date | string | null;
        database_now: Date | string;
      }>(
        ctx,
        sql`SELECT policy.credential_ref, credential.issued_at, credential.revoked_at,
                   CURRENT_TIMESTAMP AS database_now
            FROM dopaios_connector_policies policy
            LEFT JOIN dopaios_connector_credentials credential
              ON credential.secret_ref = policy.credential_ref ->> 'secretRef'
             AND credential.rotation_epoch = (policy.credential_ref ->> 'rotationEpoch')::int
            WHERE policy.policy_id = ${p["policyId"]}
              AND policy.policy_revision = ${p["policyRevision"]}`,
      );
      if (
        !credential ||
        !("rotationEpoch" in credential.credential_ref) ||
        credential.issued_at === null ||
        credential.credential_ref.secretRef !== p["secretRef"] ||
        credential.credential_ref.rotationEpoch !== p["rotationEpoch"]
      ) {
        throw new CommandRejectedError(
          "ERR-CONNECTOR-CREDENTIAL-REF",
          "Credential revocation must match an exact materialized secret reference and rotation epoch",
        );
      }
      if (
        revokedTimestamp < new Date(credential.issued_at).getTime() ||
        revokedTimestamp > new Date(credential.database_now).getTime()
      ) {
        throw new CommandRejectedError(
          "ERR-CONNECTOR-CREDENTIAL-TIME",
          "revokedAt must be at or after issuance and no later than the trusted database clock",
        );
      }
      if (credential.revoked_at !== null) {
        throw new CommandRejectedError("ERR-CONNECTOR-CREDENTIAL-REVOKED", "Credential is already revoked");
      }
      await ctx.emit({
        streamName: `dopaiosConnectorCredential-${payloadSha256({
          secretRef: p["secretRef"],
          rotationEpoch: p["rotationEpoch"],
        }).slice(0, 32)}`,
        type: "ConnectorCredentialRevoked",
        data: {
          policyId: p["policyId"],
          policyRevision: p["policyRevision"],
          secretRef: p["secretRef"],
          rotationEpoch: p["rotationEpoch"],
          revokedAt,
          actorId,
        },
        expectedVersion: -1,
      });
      return { secretRef: p["secretRef"], rotationEpoch: p["rotationEpoch"], state: "revoked" };
    },
  });
}

function redactValue(value: unknown, keys: Set<string>): unknown {
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        keys.has(key.toLowerCase()) || [...keys].some((needle) => key.toLowerCase().includes(needle))
          ? "[REDACTED]"
          : redactValue(nested, keys),
      ]),
    );
  }
  if (typeof value === "string") return `[string:${Buffer.byteLength(value, "utf8")} bytes]`;
  if (value === null) return "[null]";
  return `[${typeof value}]`;
}

type MaterializedPolicy = {
  policy_id: string;
  policy_revision: number;
  connector_id: string;
  connector_version: string;
  configuration: ConnectorConfigurationContract;
  scope_level: "Project";
  precedence: string[];
  approver_capability: string;
  effective_at: Date;
  invalidation: ConnectorPolicyInput["invalidation"];
  sha256: string;
  project_id: string;
  auth_type: string;
  credential_ref: OpaqueCredentialRef;
  runtime: string;
  environment: string;
  data_classes: Array<{ name: string; policyRef: ExactRef }>;
  lifecycle_policy_ref: ExactRef;
  retention_policy_ref: ExactRef;
  approval_ref: ConnectorPolicyApprovalRef;
  scopes: string[];
  rate_limit: { limit: number; windowMs: number };
  retry: { transientMaxAttempts: number };
  interruption: ConnectorInterruptionPolicy;
  idempotency: ConnectorPolicyInput["idempotency"];
  reconciliation: ConnectorPolicyInput["reconciliation"];
  audit: ConnectorPolicyInput["audit"];
  backoff: ConnectorPolicyInput["backoff"];
  timeout_ms: number;
  circuit_breaker: ConnectorPolicyInput["circuitBreaker"];
  fallback: ConnectorPolicyInput["fallback"];
  redaction: { keys: string[] };
  state: string;
};

async function currentPolicyArtifactAllowed(
  ctx: CommandContext,
  projectId: string,
  ref: ExactRef,
  expectedType: string,
): Promise<boolean> {
  const row = await one<{
    sha256: string;
    artifact_state: string;
    impact_status: string;
    artifact_type: string | null;
    scope_state: string | null;
  }>(
    ctx,
    sql`SELECT a.sha256, a.artifact_state, a.impact_status, a.artifact_type, scope.scope_state
        FROM dopaios_artifacts a
        LEFT JOIN dopaios_artifact_project_scopes scope
          ON scope.artifact_id = a.id AND scope.artifact_revision = a.revision
         AND scope.project_id = ${projectId}
        WHERE a.id = ${ref.id} AND a.revision = ${ref.revision}`,
  );
  return Boolean(
    row &&
      row.sha256 === ref.sha256 &&
      row.artifact_state === "approved" &&
      (row.impact_status === "clear" || row.impact_status === "reaffirmed") &&
      row.artifact_type === expectedType &&
      row.scope_state === "active",
  );
}

function requestScopeKey(request: ConnectorRequest): string {
  return payloadSha256({
    requestId: request.requestId,
    projectId: request.projectId,
    connector: request.connector,
    purpose: request.purpose,
    action: request.action,
    direction: request.direction,
  }).slice(0, 32);
}

function sameCredentialRef(left: OpaqueCredentialRef, right: OpaqueCredentialRef): boolean {
  if (left.secretRef !== right.secretRef) return false;
  const leftHasLifecycle = "rotationEpoch" in left;
  const rightHasLifecycle = "rotationEpoch" in right;
  if (leftHasLifecycle !== rightHasLifecycle) return false;
  if (!leftHasLifecycle || !rightHasLifecycle) return true;
  return left.rotationEpoch === right.rotationEpoch &&
    left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt &&
    left.revokedAt === right.revokedAt;
}

function adapterMatchesPolicy(adapter: ConnectorAdapterIdentity, policy: MaterializedPolicy): boolean {
  return (
    adapter.connector.id === policy.connector_id &&
    adapter.connector.version === policy.connector_version &&
    adapter.runtime === policy.runtime &&
    adapter.environment === policy.environment &&
    adapter.authType === policy.auth_type &&
    sameCredentialRef(adapter.credentialRef, policy.credential_ref) &&
    adapter.supportsExternalIdempotency === true
  );
}

async function currentConnectorApprovalAllowed(
  ctx: CommandContext,
  policy: MaterializedPolicy,
): Promise<boolean> {
  const approval = await one<{ target_sha256: string | null }>(
    ctx,
    sql`SELECT target_sha256 FROM dopaios_approval_records
        WHERE id = ${policy.approval_ref.recordId}`,
  );
  if (!approval?.target_sha256) return false;
  return connectorPolicyApprovalAllowed(
    ctx,
    {
      policyId: policy.policy_id,
      policyRevision: policy.policy_revision,
      projectId: policy.project_id,
      approverCapability: policy.approver_capability,
      approvalRef: policy.approval_ref,
      approvalTargetSha256: approval.target_sha256,
    },
    { allowSupersededArtifact: true },
  );
}

async function allPolicyRefsAllowed(ctx: CommandContext, policy: MaterializedPolicy): Promise<boolean> {
  const checks = [
    await currentPolicyArtifactAllowed(ctx, policy.project_id, policy.lifecycle_policy_ref, "lifecycle-policy"),
    await currentPolicyArtifactAllowed(ctx, policy.project_id, policy.retention_policy_ref, "retention-policy"),
    await currentConnectorApprovalAllowed(ctx, policy),
    ...(await Promise.all(
      policy.data_classes.map((item) =>
        currentPolicyArtifactAllowed(ctx, policy.project_id, item.policyRef, "data-policy"),
      ),
    )),
    ...(policy.fallback.mode === "file"
      ? [
          await currentPolicyArtifactAllowed(
            ctx,
            policy.project_id,
            policy.fallback.contextPackageRef,
            "context-package",
          ),
        ]
      : []),
  ];
  return checks.every(Boolean);
}

function sameContextRef(
  left: { id: string; revision: number; sha256: string } | null,
  right: { id: string; revision: number; sha256: string } | null,
): boolean {
  if (!left || !right) return false;
  return left.id === right.id && left.revision === right.revision && left.sha256 === right.sha256;
}

function contractGrantsConnectorAction(fields: Json, request: ConnectorRequest): boolean {
  const scope = fields["scope"] as {
    projectId?: string;
    purposes?: string[];
    actions?: string[];
    directions?: string[];
    dataClasses?: string[];
  } | undefined;
  const permissions = fields["permissions"];
  const tools = fields["tools"];
  if (
    !scope ||
    scope.projectId !== request.projectId ||
    !scope.purposes?.includes(request.purpose) ||
    !scope.actions?.includes(request.action) ||
    !scope.directions?.includes(request.direction) ||
    request.dataClasses.some((item) => !scope.dataClasses?.includes(item)) ||
    !Array.isArray(permissions) ||
    request.scopes.some((item) => !permissions.includes(item)) ||
    !Array.isArray(tools)
  ) {
    return false;
  }
  return tools.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const tool = entry as Record<string, unknown>;
    const actions = tool["actions"];
    const scopes = tool["scopes"];
    return tool["connectorId"] === request.connector.id &&
      tool["connectorVersion"] === request.connector.version &&
      tool["idempotencyCapable"] === true &&
      Array.isArray(actions) && actions.includes(request.action) &&
      Array.isArray(scopes) && request.scopes.every((item) => scopes.includes(item));
  });
}

async function executionBindingAllowed(
  ctx: CommandContext,
  request: ConnectorRequest,
  observedAt: Date,
): Promise<boolean> {
  const row = await one<{
    session_state: string;
    session_agent_id: string;
    session_work_item_id: string;
    session_context_id: string | null;
    session_context_revision: number | null;
    session_context_sha256: string | null;
    activation_state: string;
    activation_agent_id: string;
    activation_claimed_by: string | null;
    activation_work_item_id: string;
    claim_lease_until: Date | string | null;
    lease_epoch: number;
    contract_id: string | null;
    contract_revision: number | null;
    activation_context_id: string | null;
    activation_context_revision: number | null;
    activation_context_sha256: string | null;
    project_id: string | null;
    project_state: string | null;
    routed_to: string | null;
    staff_work_status: string | null;
  }>(
    ctx,
    sql`SELECT session.state AS session_state,
               session.agent_id AS session_agent_id,
               session.work_item_id AS session_work_item_id,
               session.context_package_id AS session_context_id,
               session.context_package_revision AS session_context_revision,
               session.context_package_sha256 AS session_context_sha256,
               activation.state AS activation_state,
               activation.agent_id AS activation_agent_id,
               activation.claimed_by AS activation_claimed_by,
               activation.work_item_id AS activation_work_item_id,
               activation.claim_lease_until, activation.lease_epoch,
               activation.contract_id, activation.contract_revision,
               activation.context_package_id AS activation_context_id,
               activation.context_package_revision AS activation_context_revision,
               activation.context_package_sha256 AS activation_context_sha256,
               work_item.project_id, project.state AS project_state,
               work_item.routed_to, staff.work_status AS staff_work_status
        FROM dopaios_ai_sessions session
        JOIN dopaios_activations activation ON activation.id = ${request.activationId}
        JOIN dopaios_work_items work_item ON work_item.id = session.work_item_id
        LEFT JOIN dopaios_projects project ON project.id = work_item.project_id
        LEFT JOIN dopaios_staff_ai staff ON staff.id = session.agent_id
        WHERE session.id = ${request.sessionId}`,
  );
  if (
    !row ||
    row.session_state !== "RUNNING" ||
    row.activation_state !== "RUNNING" ||
    row.session_agent_id !== request.actorId ||
    row.activation_agent_id !== request.actorId ||
    row.activation_claimed_by !== request.actorId ||
    row.session_work_item_id !== row.activation_work_item_id ||
    row.project_id !== request.projectId ||
    row.project_state !== "P0_ACTIVE" ||
    row.routed_to !== request.actorId ||
    row.staff_work_status !== "active" ||
    !row.contract_id ||
    !row.contract_revision ||
    Number(row.lease_epoch) !== request.leaseEpoch ||
    !row.claim_lease_until ||
    new Date(row.claim_lease_until).getTime() <= observedAt.getTime()
  ) {
    return false;
  }
  const sessionContext = row.session_context_id
    ? { id: row.session_context_id, revision: Number(row.session_context_revision), sha256: row.session_context_sha256! }
    : null;
  const activationContext = row.activation_context_id
    ? { id: row.activation_context_id, revision: Number(row.activation_context_revision), sha256: row.activation_context_sha256! }
    : null;
  if (!sameContextRef(sessionContext, activationContext)) return false;
  try {
    const contract = await requireActiveContract(ctx, row.contract_id, Number(row.contract_revision));
    return contract.workItemId === row.session_work_item_id &&
      sameContextRef(contract.contextPackageRef, sessionContext) &&
      contractGrantsConnectorAction(contract.fields, request);
  } catch (error) {
    if (error instanceof CommandRejectedError) return false;
    throw error;
  }
}

function requestRangeDenial(policy: MaterializedPolicy, request: ConnectorRequest): string | null {
  const range = policy.configuration.range;
  const payloadBytes = Buffer.byteLength(JSON.stringify(request.payload), "utf8");
  if (payloadBytes > range.maxPayloadBytes) return "payload-size-exceeded";
  const allowedKeys = new Set(range.allowedTopLevelKeys);
  if (Object.keys(request.payload).some((key) => !allowedKeys.has(key))) return "payload-key-denied";
  return null;
}

async function currentPolicyDenial(
  ctx: CommandContext,
  connector: ConnectorAdapter,
  request: ConnectorRequest,
  policy: MaterializedPolicy,
  observedAt: Date,
): Promise<string | null> {
  const project = await one<{ state: string }>(
    ctx,
    sql`SELECT state FROM dopaios_projects WHERE id = ${request.projectId}`,
  );
  if (project?.state !== "P0_ACTIVE") return "project-inactive";
  const exact = await one<{
    state: string;
    sha256: string;
    invalidation: ConnectorPolicyInput["invalidation"];
    credential_ref: OpaqueCredentialRef;
  }>(
    ctx,
    sql`SELECT state, sha256, invalidation, credential_ref FROM dopaios_connector_policies
        WHERE policy_id = ${policy.policy_id} AND policy_revision = ${policy.policy_revision}`,
  );
  const expiresAt = exact?.invalidation.expiresAt === null
    ? null
    : Date.parse(exact?.invalidation.expiresAt ?? "");
  if (
    !exact ||
    exact.state !== "approved" ||
    exact.sha256 !== policy.sha256 ||
    (expiresAt !== null && expiresAt <= observedAt.getTime())
  ) {
    return "policy-invalidated";
  }
  if ("rotationEpoch" in exact.credential_ref) {
    const credentialStatus = await one<{
      expires_at: Date | string;
      revoked_at: Date | string | null;
    }>(
      ctx,
      sql`SELECT expires_at, revoked_at FROM dopaios_connector_credentials
          WHERE secret_ref = ${exact.credential_ref.secretRef}
            AND rotation_epoch = ${exact.credential_ref.rotationEpoch}`,
    );
    if (!credentialStatus) return "credential-state-missing";
    if (
      credentialStatus.revoked_at !== null &&
      new Date(credentialStatus.revoked_at).getTime() <= observedAt.getTime()
    ) {
      return "credential-revoked";
    }
    if (new Date(credentialStatus.expires_at).getTime() <= observedAt.getTime()) {
      return "credential-expired";
    }
  }
  const current = await one<{ policy_id: string; policy_revision: number; sha256: string }>(
    ctx,
    sql`SELECT policy_id, policy_revision, sha256 FROM dopaios_connector_policies
        WHERE connector_id = ${request.connector.id}
          AND connector_version = ${request.connector.version}
          AND project_id = ${request.projectId}
          AND purpose = ${request.purpose}
          AND action = ${request.action}
          AND direction = ${request.direction}
          AND effective_at <= ${observedAt.toISOString()}::timestamptz
        ORDER BY policy_revision DESC LIMIT 1`,
  );
  if (
    !current ||
    current.policy_id !== policy.policy_id ||
    Number(current.policy_revision) !== policy.policy_revision ||
    current.sha256 !== policy.sha256
  ) {
    return "policy-replaced";
  }
  if (
    "rotationEpoch" in connector.identity.credentialRef &&
    "rotationEpoch" in exact.credential_ref &&
    connector.identity.credentialRef.rotationEpoch !== exact.credential_ref.rotationEpoch
  ) {
    return "credential-rotation-mismatch";
  }
  if (!adapterMatchesPolicy(connector.identity, { ...policy, credential_ref: exact.credential_ref })) {
    return "adapter-policy-mismatch";
  }
  if (!(await executionBindingAllowed(ctx, request, observedAt))) return "execution-binding-invalid";
  if (!(await allPolicyRefsAllowed(ctx, policy))) return "policy-reference-invalid";
  return requestRangeDenial(policy, request);
}

async function emitAudit(
  ctx: CommandContext,
  request: ConnectorRequest,
  observedAt: Date,
  policy: MaterializedPolicy | undefined,
  input: {
    id: string;
    decision: string;
    reasonCode: string;
    requestSummary: Record<string, unknown>;
    responseSummary?: Record<string, unknown>;
    retryClass: string;
    attempt: number;
  },
): Promise<void> {
  await ctx.emit({
    streamName: `dopaiosConnectorAudit-${requestScopeKey(request)}`,
    type: "ConnectorAuditRecorded",
    data: {
      auditId: input.id,
      projectId: request.projectId,
      actorId: request.actorId,
      sessionId: request.sessionId,
      connectorId: request.connector.id,
      connectorVersion: request.connector.version,
      purpose: request.purpose,
      action: request.action,
      direction: request.direction,
      policyId: policy?.policy_id ?? null,
      policyRevision: policy?.policy_revision ?? null,
      policySha256: policy?.sha256 ?? null,
      runtime: policy?.runtime ?? null,
      environment: policy?.environment ?? null,
      approvalRef: policy?.approval_ref ?? null,
      fallbackContextRef: policy?.fallback.mode === "file" ? policy.fallback.contextPackageRef : null,
      decision: input.decision,
      reasonCode: input.reasonCode,
      requestId: request.requestId,
      requestSummary: input.requestSummary,
      responseSummary: input.responseSummary ?? null,
      retryClass: input.retryClass,
      attempt: input.attempt,
      createdAt: observedAt.toISOString(),
    },
    metadata: { audit: true },
  });
}

async function recordOutcomeAudit(
  db: Db,
  request: ConnectorRequest,
  observedAt: Date,
  policy: MaterializedPolicy | undefined,
  requestSummary: Record<string, unknown>,
  input: {
    decision: string;
    reasonCode: string;
    retryClass: string;
    attempt: number;
    response?: Record<string, unknown>;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const scopeKey = requestScopeKey(request);
  const redactionKeys = new Set(
    ["authorization", "token", "password", "secret", ...(policy?.redaction.keys ?? [])].map((key) =>
      key.toLowerCase(),
    ),
  );
  const responseSummary = input.response
    ? {
        classification: input.reasonCode,
        sha256: payloadSha256(input.response),
        summary: redactValue(input.response, redactionKeys),
        ...(input.details ?? {}),
      }
    : { classification: input.reasonCode, ...(input.details ?? {}) };
  const outcomeIdentity = payloadSha256({
    requestSummarySha256: payloadSha256(requestSummary),
    policyRef: policy ? { id: policy.policy_id, revision: policy.policy_revision, sha256: policy.sha256 } : null,
    decision: input.decision,
    reasonCode: input.reasonCode,
    retryClass: input.retryClass,
    attempt: input.attempt,
    responseSha256: input.response ? payloadSha256(input.response) : null,
    detailsSha256: input.details ? payloadSha256(input.details) : null,
  }).slice(0, 16);
  await executeCommand(db, {
    commandId: `KC08-CONNECTOR-AUDIT-${scopeKey}-${input.decision}-${input.attempt}-${outcomeIdentity}`,
    payload: {
      requestId: request.requestId,
      requestSummarySha256: payloadSha256(requestSummary),
      policyRef: policy ? { id: policy.policy_id, revision: policy.policy_revision, sha256: policy.sha256 } : null,
      decision: input.decision,
      reasonCode: input.reasonCode,
      retryClass: input.retryClass,
      attempt: input.attempt,
      responseSha256: input.response ? payloadSha256(input.response) : null,
      detailsSha256: input.details ? payloadSha256(input.details) : null,
    },
    handler: async (ctx) => {
      await emitAudit(ctx, request, observedAt, policy, {
        id: `${scopeKey}-${input.decision}-${input.attempt}-${outcomeIdentity}`,
        decision: input.decision,
        reasonCode: input.reasonCode,
        requestSummary,
        responseSummary,
        retryClass: input.retryClass,
        attempt: input.attempt,
      });
      return {};
    },
  });
}

async function authorizeConnectorRequest(
  db: Db,
  connector: ConnectorAdapter,
  request: ConnectorRequest,
  observedAt: Date,
): Promise<{ policy: MaterializedPolicy; requestSummary: Record<string, unknown> } | { denied: string }> {
  const scopeKey = requestScopeKey(request);
  const safeSummary = redactValue(
    request.payload,
    new Set(["authorization", "token", "password", "secret"]),
  ) as Record<string, unknown>;
  let result: CommandResult;
  try {
    result = await executeCommand(db, {
      commandId: `KC08-CONNECTOR-AUTHZ-${scopeKey}`,
      payload: {
        ...request,
        adapterIdentity: connector.identity,
        payload: "redacted-before-command-log",
        payloadSha256: payloadSha256(request.payload),
      } as unknown as Json,
      handler: async (ctx) => {
        const policy = await one<MaterializedPolicy>(
          ctx,
          sql`SELECT policy_id, policy_revision, connector_id, connector_version,
                     configuration, scope_level, precedence,
                     approver_capability, effective_at, invalidation, sha256, project_id,
                     auth_type, credential_ref, runtime, environment, data_classes,
                     lifecycle_policy_ref, retention_policy_ref, approval_ref, scopes,
                     rate_limit, interruption, retry, idempotency, reconciliation, audit,
                     circuit_breaker, backoff, timeout_ms, fallback, redaction, state
              FROM dopaios_connector_policies
              WHERE connector_id = ${request.connector.id}
                AND connector_version = ${request.connector.version}
                AND project_id = ${request.projectId}
                AND purpose = ${request.purpose}
                AND action = ${request.action}
                AND direction = ${request.direction}
                AND effective_at <= ${observedAt.toISOString()}::timestamptz
              ORDER BY policy_revision DESC
              LIMIT 1`,
        );
        const redactionKeys = new Set(
          ["authorization", "token", "password", "secret", ...(policy?.redaction?.keys ?? [])].map((key) =>
            key.toLowerCase(),
          ),
        );
        const requestSummary = redactValue(request.payload, redactionKeys) as Record<string, unknown>;
        let denied: string | null = null;
        if (!policy || policy.state !== "approved") {
          denied = "policy-missing";
        } else {
          denied = await currentPolicyDenial(ctx, connector, request, policy, observedAt);
          if (!denied && (request.dataClasses.length === 0 || request.scopes.length === 0)) {
            denied = "classification-missing";
          }
          const allowedClasses = new Set(policy.data_classes.map((item) => item.name));
          const allowedScopes = new Set(policy.scopes);
          if (!denied && request.dataClasses.some((item) => !allowedClasses.has(item))) denied = "data-class-denied";
          if (!denied && request.scopes.some((item) => !allowedScopes.has(item))) denied = "scope-denied";
          if (!denied) {
            const rateSince = new Date(observedAt.getTime() - policy.rate_limit.windowMs).toISOString();
            const rate = await one<{ n: number }>(
              ctx,
              sql`SELECT count(*)::int AS n FROM dopaios_connector_audit_events
                  WHERE project_id = ${request.projectId}
                    AND policy_id = ${policy.policy_id}
                    AND decision = 'allow'
                    AND created_at >= ${rateSince}::timestamptz`,
            );
            if (Number(rate?.n ?? 0) >= policy.rate_limit.limit) denied = "rate-limit";
          }
          if (!denied) {
            const resetSince = new Date(
              observedAt.getTime() - policy.circuit_breaker.reset.delayMs,
            ).toISOString();
            const failures = await one<{ n: number }>(
              ctx,
              sql`SELECT count(*)::int AS n FROM dopaios_connector_audit_events
                  WHERE project_id = ${request.projectId}
                    AND policy_id = ${policy.policy_id}
                    AND decision = 'error'
                    AND retry_class = 'transient'
                    AND created_at >= ${resetSince}::timestamptz`,
            );
            if (Number(failures?.n ?? 0) >= policy.circuit_breaker.threshold) denied = "circuit-open";
          }
        }
        await emitAudit(ctx, request, observedAt, policy, {
          id: `${scopeKey}-authorize-0`,
          decision: denied ? "deny" : "allow",
          reasonCode: denied ?? "policy-approved",
          requestSummary,
          retryClass: "none",
          attempt: 0,
        });
        return denied ? { denied } : { policy, requestSummary };
      },
    });
  } catch (error) {
    if (!(error instanceof CommandPayloadMismatchError)) throw error;
    await recordOutcomeAudit(db, request, observedAt, undefined, safeSummary, {
      decision: "deny",
      reasonCode: "request-id-payload-mismatch",
      retryClass: "policy",
      attempt: 0,
    });
    return { denied: "request-id-payload-mismatch" };
  }
  const authorization = result as unknown as {
    policy: MaterializedPolicy;
    requestSummary: Record<string, unknown>;
    denied?: string;
    idempotentReplay?: boolean;
  };
  if (authorization.idempotentReplay === true) {
    await recordOutcomeAudit(
      db,
      request,
      observedAt,
      authorization.policy,
      authorization.requestSummary ?? safeSummary,
      { decision: "deny", reasonCode: "duplicate-request", retryClass: "policy", attempt: 0 },
    );
    return { denied: "duplicate-request" };
  }
  return result as unknown as
    | { policy: MaterializedPolicy; requestSummary: Record<string, unknown> }
    | { denied: string };
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([
    operationPromise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ConnectorTimeoutError(timeoutMs));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function revalidateConnectorExecution(
  db: Db,
  connector: ConnectorAdapter,
  request: ConnectorRequest,
  policy: MaterializedPolicy,
  observedAt: Date,
  attempt: number,
  phase: "attempt" | "fallback",
): Promise<string | null> {
  const result = await executeCommand(db, {
    commandId: `KC08-CONNECTOR-REVALIDATE-${requestScopeKey(request)}-${phase}-${attempt}`,
    payload: {
      policyRef: { id: policy.policy_id, revision: policy.policy_revision, sha256: policy.sha256 },
      adapterIdentity: connector.identity,
      executionBinding: {
        actorId: request.actorId,
        sessionId: request.sessionId,
        activationId: request.activationId,
        leaseEpoch: request.leaseEpoch,
      },
      phase,
    },
    handler: async (ctx) => {
      return { denied: await currentPolicyDenial(ctx, connector, request, policy, observedAt) };
    },
  });
  return typeof result["denied"] === "string" ? result["denied"] : null;
}

export async function executeConnectorRequest(
  db: Db,
  connector: ConnectorAdapter,
  request: ConnectorRequest,
  runtime: ConnectorGatewayRuntime = defaultRuntime,
): Promise<Record<string, unknown>> {
  const observedAt = trustedNow(runtime);
  const authorization = await authorizeConnectorRequest(db, connector, request, observedAt);
  if ("denied" in authorization) throw new ConnectorDeniedError(authorization.denied);
  const { policy, requestSummary } = authorization;
  const maxAttempts = policy.retry.transientMaxAttempts;
  const externalIdempotencyKey = `kc08:${requestScopeKey(request)}`;
  let lastTransientError: unknown;
  let finalAttempt = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    finalAttempt = attempt;
    const attemptObservedAt = trustedNow(runtime);
    const revalidationDenial = await revalidateConnectorExecution(
      db,
      connector,
      request,
      policy,
      attemptObservedAt,
      attempt,
      "attempt",
    );
    if (revalidationDenial) {
      await recordOutcomeAudit(db, request, trustedNow(runtime), policy, requestSummary, {
        decision: "deny",
        reasonCode: revalidationDenial,
        retryClass: "policy",
        attempt,
      });
      throw new ConnectorDeniedError(revalidationDenial);
    }
    await recordOutcomeAudit(db, request, attemptObservedAt, policy, requestSummary, {
      decision: "intent",
      reasonCode: "attempt-started",
      retryClass: "none",
      attempt,
      details: { externalIdempotencyKey },
    });
    let output: Record<string, unknown>;
    try {
      output = await withTimeout(policy.timeout_ms, (signal) =>
        connector.execute({
          requestId: request.requestId,
          projectId: request.projectId,
          action: request.action,
          payload: request.payload,
          externalIdempotencyKey,
          signal,
        }),
      );
    } catch (error) {
      const kind = errorKind(error);
      const outcomeObservedAt = trustedNow(runtime);
      if (kind === "timeout" || (kind === "transient" && !retrySafeTransient(error))) {
        await recordOutcomeAudit(db, request, outcomeObservedAt, policy, requestSummary, {
          decision: "reconciliation-required",
          reasonCode: kind === "timeout" ? "timeout" : "ambiguous-transient",
          retryClass: kind,
          attempt,
          details: { externalIdempotencyKey },
        });
        throw new ConnectorReconciliationRequiredError(
          kind === "timeout" ? "timeout" : "ambiguous-transient",
          { cause: error },
        );
      }
      await recordOutcomeAudit(db, request, outcomeObservedAt, policy, requestSummary, {
        decision: "error",
        reasonCode: kind,
        retryClass: kind,
        attempt,
      });
      if (kind !== "transient") throw error;
      lastTransientError = error;
      if (attempt < maxAttempts) {
        const exponential = Math.min(MAX_TIMER_MS, policy.backoff.delayMs * 2 ** (attempt - 1));
        const delayMs = policy.backoff.strategy === "fixed"
          ? policy.backoff.delayMs
          : Math.min(exponential, policy.backoff.maxDelayMs ?? exponential);
        await runtime.sleep(delayMs);
        continue;
      }
      break;
    }
    // Keep audit persistence outside the adapter-error catch: an audit failure must
    // never cause a completed external side effect to be executed again.
    try {
      await recordOutcomeAudit(db, request, trustedNow(runtime), policy, requestSummary, {
        decision: "success",
        reasonCode: "connector-success",
        retryClass: "none",
        attempt,
        response: output,
      });
    } catch (error) {
      await recordOutcomeAudit(db, request, trustedNow(runtime), policy, requestSummary, {
        decision: "reconciliation-required",
        reasonCode: "outcome-audit-failed",
        retryClass: "policy",
        attempt,
        details: { externalIdempotencyKey, responseSha256: payloadSha256(output) },
      });
      throw new ConnectorReconciliationRequiredError("outcome-audit-failed", { cause: error });
    }
    return output;
  }

  if (policy.fallback.mode !== "file") throw lastTransientError;
  const fallbackObservedAt = trustedNow(runtime);
  const fallbackDenial = await revalidateConnectorExecution(
    db,
    connector,
    request,
    policy,
    fallbackObservedAt,
    finalAttempt,
    "fallback",
  );
  if (fallbackDenial) {
    await recordOutcomeAudit(db, request, fallbackObservedAt, policy, requestSummary, {
      decision: "fallback-deny",
      reasonCode: fallbackDenial,
      retryClass: "policy",
      attempt: finalAttempt,
    });
    throw new ConnectorDeniedError(fallbackDenial);
  }

  const fallback = policy.fallback;
  let fallbackFile: { contentUtf8: string; value: Record<string, unknown> };
  try {
    fallbackFile = await withTimeout(policy.timeout_ms, (signal) =>
      runtime.loadStaticFallback({
        ref: fallback.ref,
        projectId: fallback.projectId,
        contextPackageRef: fallback.contextPackageRef,
        signal,
      }),
    );
  } catch (error) {
    const reasonCode = error instanceof ConnectorTimeoutError ? "fallback-timeout" : "fallback-load-failed";
    await recordOutcomeAudit(db, request, fallbackObservedAt, policy, requestSummary, {
      decision: "fallback-deny",
      reasonCode,
      retryClass: "policy",
      attempt: finalAttempt,
    });
    throw new ConnectorDeniedError(reasonCode);
  }
  let parsedFallback: unknown;
  try {
    parsedFallback = JSON.parse(fallbackFile.contentUtf8);
  } catch {
    parsedFallback = undefined;
  }
  if (
    sha256Utf8(fallbackFile.contentUtf8) !== fallback.contentSha256 ||
    !parsedFallback ||
    typeof parsedFallback !== "object" ||
    Array.isArray(parsedFallback) ||
    payloadSha256(parsedFallback) !== payloadSha256(fallbackFile.value)
  ) {
    await recordOutcomeAudit(db, request, fallbackObservedAt, policy, requestSummary, {
      decision: "fallback-deny",
      reasonCode: "fallback-hash-mismatch",
      retryClass: "policy",
      attempt: finalAttempt,
    });
    throw new ConnectorDeniedError("fallback-hash-mismatch");
  }
  await recordOutcomeAudit(db, request, fallbackObservedAt, policy, requestSummary, {
    decision: "fallback",
    reasonCode: "approved-file-fallback",
    retryClass: "transient",
    attempt: finalAttempt,
    response: fallbackFile.value,
  });
  return fallbackFile.value;
}
