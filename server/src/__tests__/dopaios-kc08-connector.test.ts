import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { executeCommand, payloadSha256, replayProjections, snapshotProjections } from "../dopaios/event-store.js";
import { markArtifactImpact, registerActor, registerApprovedArtifact } from "../dopaios/commands.js";
import {
  assembleDecisionPackage,
  pinSeparationPolicy,
  recordApprovalDecision,
  registerDraftArtifact,
  submitArtifactForReview,
} from "../dopaios/approval.js";
import { bindArtifactProjectScope, sha256Utf8 } from "../dopaios/context-package.js";
import {
  ConnectorDeniedError,
  ConnectorReconciliationRequiredError,
  connectorPolicyApprovalSha256,
  executeConnectorRequest,
  materializeConnectorPolicy,
  type ConnectorAdapterIdentity,
  type ConnectorGatewayRuntime,
  type ConnectorPolicyInput,
} from "../dopaios/connector-gateway.js";
import {
  ConnectorExecutionError,
  FakeConnector,
  connectorAuthFailure,
  connectorTransientFailure,
} from "../dopaios/kc08-fixture-support.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("dopaios KC-08 connector gateway", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let seq = 0;
  let basePolicy!: ConnectorPolicyInput;
  const cmd = (label: string) => `KC08-CONN-${label}-${(seq += 1)}`;
  const projectId = "PROJECT-KC08-CONNECTOR-A";
  const auditIdentity = {
    actorId: "AI-DEV-KC08",
    sessionId: "SESSION-KC08",
    activationId: "ACT-KC08-CONNECTOR-A",
    leaseEpoch: 0,
  } as const;
  const projectBAuditIdentity = {
    actorId: "AI-DEV-KC08-B",
    sessionId: "SESSION-KC08-B",
    activationId: "ACT-KC08-CONNECTOR-B",
    leaseEpoch: 0,
  } as const;
  const fallbackContentUtf8 = '{"fallback":true}';
  const identity = (id: string): ConnectorAdapterIdentity => ({
    connector: { id, version: "2026-07-01" },
    runtime: "server",
    environment: "kc08-isolated",
    authType: "github-app",
    credentialRef: { secretRef: "secret://github-app/kc08" },
    supportsExternalIdempotency: true,
  });
  const runtimeAt = (
    at: string,
    overrides: Partial<ConnectorGatewayRuntime> = {},
  ): ConnectorGatewayRuntime => ({
    now: () => new Date(at),
    sleep: async () => undefined,
    loadStaticFallback: async () => {
      throw new Error("fallback loader not configured for this test");
    },
    ...overrides,
  });

  async function approveAndMaterialize(
    label: string,
    input: ConnectorPolicyInput,
  ): Promise<ConnectorPolicyInput> {
    const targetSha256 = connectorPolicyApprovalSha256(input);
    const recordId = `APR-${input.policyId}-R${input.policyRevision}`;
    const packageId = `PKG-${input.policyId}-R${input.policyRevision}`;
    await registerDraftArtifact(db, cmd(`${label}-draft`), {
      artifactId: input.policyId,
      revision: input.policyRevision,
      sha256: targetSha256,
      createdBy: input.createdBy,
      artifactType: "connector-policy",
      hasRegionSchema: false,
      storageRef: `db://dopaios_connector_policies/${input.policyId}/${input.policyRevision}`,
    });
    await bindArtifactProjectScope(db, cmd(`${label}-scope`), {
      artifactId: input.policyId,
      revision: input.policyRevision,
      projectId: input.projectId,
      boundBy: input.createdBy,
    });
    await submitArtifactForReview(db, cmd(`${label}-review`), {
      artifactId: input.policyId,
      revision: input.policyRevision,
    });
    const pinnedRefs = { evidence: `fixture://${input.policyId}/review/${input.policyRevision}` };
    await assembleDecisionPackage(db, cmd(`${label}-package`), {
      packageId,
      revision: 1,
      target: { artifactId: input.policyId, revision: input.policyRevision, sha256: targetSha256 },
      refs: pinnedRefs,
      fields: { decisionAsk: `Approve connector policy ${input.policyId}@${input.policyRevision}?` },
    });
    await recordApprovalDecision(db, cmd(`${label}-approval`), {
      recordId,
      packageId,
      packageRevision: 1,
      target: { artifactId: input.policyId, revision: input.policyRevision, sha256: targetSha256 },
      outcome: "approve",
      approvedScope: { kind: "full-revision" },
      findings: [],
      nonWaivableBlockers: [],
      impactSet: [],
      downstreamChecked: [],
      pinnedRefs,
      actor: "CTO-KC08",
    });
    const policy = { ...input, approvalRef: { recordId } };
    await materializeConnectorPolicy(db, cmd(`${label}-materialize`), policy);
    return policy;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc08-connector-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, cmd("author"), {
      actorId: "ORCH-KC08",
      kind: "human",
      active: true,
      capabilities: ["connector-policy-author"],
    });
    await registerActor(db, cmd("approver"), {
      actorId: "CTO-KC08",
      kind: "human",
      active: true,
      capabilities: ["connector-policy-approver"],
    });
    await pinSeparationPolicy(db, cmd("connector-separation"), {
      policyId: "SEP-CONNECTOR-POLICY-KC08",
      artifactType: "connector-policy",
      revision: 1,
      policy: {
        policy_id: "SEP-CONNECTOR-POLICY-KC08",
        scope_level: "Project",
        approver_capability: "connector-policy-approver",
        effective_at: "2026-08-03T00:00:00.000Z",
        invalidation_rule: "revision-superseded-or-impact",
      },
      pinnedBy: "CTO-KC08",
    });
    await executeCommand(db, {
      commandId: cmd("projects"),
      payload: {},
      handler: async (ctx) => {
        for (const id of [projectId, "PROJECT-KC08-CONNECTOR-B"]) {
          await ctx.emit({
            streamName: `dopaiosProject-${id}`,
            type: "ProjectShellCreated",
            data: {
              projectId: id,
              templateRef: { id: "PROJECT-TEMPLATE", revision: 1, sha256: "a".repeat(64) },
              orchestrator: "ORCH-KC08",
              createdBy: "ORCH-KC08",
            },
          });
          await ctx.emit({ streamName: `dopaiosProject-${id}`, type: "ProjectEnteredP0", data: { projectId: id } });
        }
        return {};
      },
    });

    const connectorIds = [
      "github",
      "slack",
      "linear",
      "notion",
      "fallback-loader",
      "audit-failure",
      "circuit",
      "concurrent-rate",
      "revisioned",
      "policy-shift",
    ];
    for (const binding of [
      { project: projectId, actor: auditIdentity.actorId, session: auditIdentity.sessionId, activation: auditIdentity.activationId, suffix: "A" },
      { project: "PROJECT-KC08-CONNECTOR-B", actor: projectBAuditIdentity.actorId, session: projectBAuditIdentity.sessionId, activation: projectBAuditIdentity.activationId, suffix: "B" },
    ]) {
      const workItemId = `WI-KC08-CONNECTOR-${binding.suffix}`;
      const contractId = `XC-KC08-CONNECTOR-${binding.suffix}`;
      const contextId = `CTX-KC08-CONNECTOR-${binding.suffix}`;
      const contextSha256 = sha256Utf8(`approved connector execution context ${binding.suffix}`);
      const contextRef = { id: contextId, revision: 1, sha256: contextSha256 };
      await registerApprovedArtifact(db, cmd(`context-ledger-${binding.suffix}`), {
        artifactId: contextId,
        revision: 1,
        sha256: contextSha256,
        artifactType: "context-package",
        storageRef: `db://dopaios_context_packages/${contextId}/1`,
      });
      await bindArtifactProjectScope(db, cmd(`context-scope-${binding.suffix}`), {
        artifactId: contextId,
        revision: 1,
        projectId: binding.project,
        boundBy: "ORCH-KC08",
      });
      const fields = {
        objective: "execute connector action through FS-004",
        scope: {
          projectId: binding.project,
          purposes: ["read-source"],
          actions: ["repository.read"],
          directions: ["egress"],
          dataClasses: ["source-code"],
        },
        inputs: [contextRef],
        outputs: [{ id: "CONNECTOR-RESULT" }],
        context: { packageRef: contextRef },
        permissions: ["contents:read"],
        tools: connectorIds.map((connectorId) => ({
          connectorId,
          connectorVersion: "2026-07-01",
          actions: ["repository.read"],
          scopes: ["contents:read"],
          idempotencyCapable: true,
        })),
        limits: { timeMs: 60_000, costUsd: 1, loops: 3 },
        requiredChecks: ["connector-policy"],
        requiredEvidence: ["connector-audit"],
        stopConditions: ["policy-deny"],
        escalationEvents: ["outcome-ambiguous"],
        fallbackPath: "approved-static-file-or-stop",
      };
      await executeCommand(db, {
        commandId: cmd(`binding-${binding.suffix}`),
        payload: { projectId: binding.project, workItemId, contractId, contextRef },
        handler: async (ctx) => {
          await ctx.emit({
            streamName: `dopaiosStaffAi-${binding.actor}`,
            type: "StaffAiRegistered",
            data: {
              staffId: binding.actor,
              workStatus: "active",
              capabilities: ["connector-execution"],
              skills: ["connector-gateway"],
              permissions: ["contents:read"],
              resources: ["fake-connector"],
              autonomyLimits: { externalActions: "contract-only" },
              modelVersion: "fixture-no-model-call",
              capacityLimit: 1,
              profileRevision: 1,
            },
          });
          await ctx.emit({
            streamName: `dopaiosWorkItem-${workItemId}`,
            type: "WorkItemCreated",
            data: { workItemId, projectId: binding.project, role: "AI-Build", state: "IN_PROGRESS" },
          });
          await ctx.emit({
            streamName: `dopaiosWorkItem-${workItemId}`,
            type: "WorkItemRouted",
            data: {
              workItemId,
              staffId: binding.actor,
              role: "AI-Build",
              basis: { connectorFixture: true },
            },
          });
          await ctx.emit({
            streamName: `dopaiosContextPackage-${contextId}`,
            type: "ContextPackageBuilt",
            data: {
              packageId: contextId,
              revision: 1,
              projectId: binding.project,
              workItemId,
              state: "draft",
              sha256: contextSha256,
              manifest: { schema: "dopaios.context-package/v1", sources: [], approval: null },
              maxBytes: 1024,
              maxTokens: 256,
              totalBytes: 0,
              totalTokens: 0,
              createdBy: "ORCH-KC08",
              sources: [],
            },
          });
          await ctx.emit({
            streamName: `dopaiosContextPackage-${contextId}`,
            type: "ContextPackageApproved",
            data: {
              packageId: contextId,
              revision: 1,
              approvalRef: { id: `APR-CONTEXT-${binding.suffix}`, revision: 1, sha256: "c".repeat(64) },
              approvedBy: "CTO-KC08",
            },
          });
          await ctx.emit({
            streamName: `dopaiosExecutionContract-${contractId}`,
            type: "ExecutionContractCompiled",
            data: {
              contractId,
              revision: 1,
              workItemId,
              sources: { project: { id: binding.project }, contextPackage: contextRef },
              fields,
              sha256: payloadSha256({ fields, contextRef }),
              compiledBy: "system-router",
              contextPackageRef: contextRef,
            },
          });
          await ctx.emit({
            streamName: `dopaiosActivation-${binding.activation}`,
            type: "ActivationRequested",
            data: {
              activationId: binding.activation,
              workItemId,
              agentId: binding.actor,
              engine: "fake-connector",
              contractId,
              contractRevision: 1,
              contextPackageId: contextId,
              contextPackageRevision: 1,
              contextPackageSha256: contextSha256,
            },
          });
          await ctx.emit({
            streamName: `dopaiosActivation-${binding.activation}`,
            type: "ActivationClaimed",
            data: {
              activationId: binding.activation,
              claimedBy: binding.actor,
              leaseUntil: "2035-01-01T00:00:00.000Z",
            },
          });
          await ctx.emit({
            streamName: `dopaiosAiSession-${binding.session}`,
            type: "AiSessionStarted",
            data: {
              sessionId: binding.session,
              workItemId,
              agentId: binding.actor,
              engine: "fake-connector",
              contextPackageId: contextId,
              contextPackageRevision: 1,
              contextPackageSha256: contextSha256,
            },
          });
          return {};
        },
      });
    }
    for (const [id, type] of [
      ["POL-LIFECYCLE-KC08", "lifecycle-policy"],
      ["POL-RETENTION-KC08", "retention-policy"],
      ["POL-DATA-KC08", "data-policy"],
    ] as const) {
      const content = `${id} approved`;
      await registerApprovedArtifact(db, cmd(id), {
        artifactId: id,
        revision: 1,
        sha256: sha256Utf8(content),
        artifactType: type,
        storageRef: `fixture://${id}`,
      });
      await bindArtifactProjectScope(db, cmd(`scope-${id}`), {
        artifactId: id,
        revision: 1,
        projectId,
        boundBy: "ORCH-KC08",
      });
    }
    const fallbackSha256 = sha256Utf8(fallbackContentUtf8);
    await registerApprovedArtifact(db, cmd("static-context"), {
      artifactId: "CTX-STATIC-FALLBACK-KC08",
      revision: 1,
      sha256: fallbackSha256,
      artifactType: "context-package",
      storageRef: "fixture://kc08/github-fallback.json",
    });
    await bindArtifactProjectScope(db, cmd("scope-static-context"), {
      artifactId: "CTX-STATIC-FALLBACK-KC08",
      revision: 1,
      projectId,
      boundBy: "ORCH-KC08",
    });
    const ref = (id: string) => ({ id, revision: 1, sha256: sha256Utf8(`${id} approved`) });
    basePolicy = {
      policyId: "CONN-POL-KC08-A",
      policyRevision: 1,
      configuration: {
        schema: "dopaios.connector-policy/v1",
        type: "object",
        unit: "request",
        range: {
          maxPayloadBytes: 512,
          allowedTopLevelKeys: ["repository", "authorization", "token", "classified", "password", "secret"],
        },
      },
      scopeLevel: "Project",
      precedence: ["work-item", "Project", "SOP", "company"],
      approverCapability: "connector-policy-approver",
      effectiveAt: "2026-08-03T00:00:00.000Z",
      invalidation: { mode: "artifact-state-or-time", expiresAt: null },
      connector: { id: "github", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      auth: { type: "github-app", credentialRef: { secretRef: "secret://github-app/kc08" } },
      runtime: "server",
      environment: "kc08-isolated",
      dataClasses: [{ name: "source-code", policyRef: ref("POL-DATA-KC08") }],
      lifecyclePolicyRef: ref("POL-LIFECYCLE-KC08"),
      retentionPolicyRef: ref("POL-RETENTION-KC08"),
      scopes: ["contents:read"],
      rateLimit: { limit: 3, windowMs: 60_000 },
      timeoutMs: 5_000,
      interruption: { transient: "retry", timeout: "stop", auth: "stop", quota: "stop", policy: "stop" },
      retry: { transientMaxAttempts: 2 },
      backoff: { strategy: "fixed", delayMs: 7 },
      circuitBreaker: { threshold: 2, reset: { mode: "after", delayMs: 3_600_000 } },
      idempotency: { key: "requestId", guarantee: "at-most-once" },
      reconciliation: { required: true, onAmbiguous: "escalate" },
      fallback: {
        mode: "file",
        ref: "fixture://kc08/github-fallback.json",
        projectId,
        contextPackageRef: { id: "CTX-STATIC-FALLBACK-KC08", revision: 1, sha256: fallbackSha256 },
        contentSha256: fallbackSha256,
        approvedBy: "ORCH-KC08",
      },
      audit: { mode: "structured", appendOnlySource: "message_store", deniedBeforeSideEffect: true },
      redaction: { keys: ["authorization", "token", "password", "secret"] },
      approvalRef: { recordId: "pending" },
      createdBy: "ORCH-KC08",
    };
    basePolicy = await approveAndMaterialize("policy", basePolicy);
    await approveAndMaterialize("rate-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-RATE",
      connector: { id: "slack", version: "2026-07-01" },
      rateLimit: { limit: 1, windowMs: 60_000 },
      circuitBreaker: { threshold: 99, reset: { mode: "after", delayMs: 3_600_000 } },
      fallback: { mode: "none" },
    });
    await approveAndMaterialize("concurrency-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-CONCURRENT",
      connector: { id: "linear", version: "2026-07-01" },
      rateLimit: { limit: 10, windowMs: 60_000 },
      circuitBreaker: { threshold: 99, reset: { mode: "after", delayMs: 3_600_000 } },
      fallback: { mode: "none" },
    });
    await approveAndMaterialize("timeout-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-TIMEOUT",
      connector: { id: "notion", version: "2026-07-01" },
      timeoutMs: 10,
      retry: { transientMaxAttempts: 2 },
      rateLimit: { limit: 10, windowMs: 60_000 },
      circuitBreaker: { threshold: 99, reset: { mode: "after", delayMs: 3_600_000 } },
      fallback: { mode: "none" },
    });
    await approveAndMaterialize("fallback-loader-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-FALLBACK-LOADER",
      connector: { id: "fallback-loader", version: "2026-07-01" },
      rateLimit: { limit: 20, windowMs: 60_000 },
      circuitBreaker: { threshold: 20, reset: { mode: "after", delayMs: 3_600_000 } },
    });
    await approveAndMaterialize("audit-failure-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-AUDIT-FAILURE",
      connector: { id: "audit-failure", version: "2026-07-01" },
      rateLimit: { limit: 20, windowMs: 60_000 },
      circuitBreaker: { threshold: 20, reset: { mode: "after", delayMs: 3_600_000 } },
      fallback: { mode: "none" },
    });
    await approveAndMaterialize("circuit-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-CIRCUIT",
      connector: { id: "circuit", version: "2026-07-01" },
      rateLimit: { limit: 20, windowMs: 60_000 },
      circuitBreaker: { threshold: 2, reset: { mode: "after", delayMs: 3_600_000 } },
      fallback: { mode: "none" },
    });
    await approveAndMaterialize("concurrent-rate-policy", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-CONCURRENT-RATE",
      connector: { id: "concurrent-rate", version: "2026-07-01" },
      rateLimit: { limit: 1, windowMs: 60_000 },
      circuitBreaker: { threshold: 20, reset: { mode: "after", delayMs: 3_600_000 } },
      fallback: { mode: "none" },
    });
  }, 120_000);

  afterAll(async () => tempDb?.cleanup());

  it("allows only the materialized Project/action/data-class policy and stores redacted audit", async () => {
    const connector = new FakeConnector([{ ok: true, value: { objectId: "sha-123" } }], identity("github"));
    const result = await executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-ALLOW-1",
      connector: { id: "github", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: { repository: "Dopai-JSC/paperclip", authorization: "Bearer must-not-log" },
    }, runtimeAt("2026-08-03T00:00:00Z"));
    expect(result).toEqual({ objectId: "sha-123" });
    expect(connector.invocationCount).toBe(1);
    const audit = (await db.execute(sql`
      SELECT decision, reason_code, request_summary, response_summary FROM dopaios_connector_audit_events
       WHERE request_id = 'REQ-CONN-ALLOW-1' ORDER BY attempt, decision
    `)) as unknown as Array<{
      decision: string;
      reason_code: string;
      request_summary: Record<string, unknown>;
      response_summary: Record<string, unknown> | null;
    }>;
    expect(audit.map((row) => row.decision)).toEqual(["allow", "intent", "success"]);
    expect(JSON.stringify(audit)).not.toContain("must-not-log");
    expect(JSON.stringify(audit)).not.toContain("Dopai-JSC/paperclip");
    expect(audit[0]?.request_summary).toMatchObject({ authorization: "[REDACTED]" });
    expect(audit.find((row) => row.decision === "success")?.response_summary).toMatchObject({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      summary: { objectId: "[string:7 bytes]" },
    });
    const leaked = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE data::text LIKE '%must-not-log%'
    `)) as unknown as Array<{ n: number }>;
    expect(leaked[0]?.n).toBe(0);
  });

  it("audits a cross-Project deny before returning and never invokes the connector", async () => {
    const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("github"));
    await expect(
      executeConnectorRequest(db, connector, {
        ...projectBAuditIdentity,
        requestId: "REQ-CONN-DENY-XPROJECT",
        connector: { id: "github", version: "2026-07-01" },
        projectId: "PROJECT-KC08-CONNECTOR-B",
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload: { token: "must-not-log" },
      }, runtimeAt("2026-08-03T00:01:00Z")),
    ).rejects.toBeInstanceOf(ConnectorDeniedError);
    expect(connector.invocationCount).toBe(0);
    const rows = (await db.execute(sql`
      SELECT decision, reason_code, request_summary FROM dopaios_connector_audit_events
      WHERE request_id = 'REQ-CONN-DENY-XPROJECT'
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "deny", reason_code: "policy-missing" });
    expect(JSON.stringify(rows)).not.toContain("must-not-log");
  });

  it("never retries auth, quota, or policy failures", async () => {
    const cases = [
      { id: "AUTH", at: "2026-08-03T00:02:00Z", outcome: connectorAuthFailure("bad app credential"), kind: "auth" },
      { id: "QUOTA", at: "2026-08-03T00:04:00Z", outcome: { ok: false as const, error: new ConnectorExecutionError("quota", "quota") }, kind: "quota" },
      { id: "POLICY", at: "2026-08-03T00:06:00Z", outcome: { ok: false as const, error: new ConnectorExecutionError("policy", "policy") }, kind: "policy" },
    ];
    for (const item of cases) {
      const connector = new FakeConnector([item.outcome], identity("github"));
      await expect(executeConnectorRequest(db, connector, {
        ...auditIdentity,
        requestId: `REQ-CONN-${item.id}`,
        connector: { id: "github", version: "2026-07-01" },
        projectId,
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload: {},
      }, runtimeAt(item.at))).rejects.toMatchObject({ kind: item.kind });
      expect(connector.invocationCount).toBe(1);
    }
  });

  it("retries transient failures only to the bound and then uses the approved file fallback", async () => {
    const transient = new FakeConnector([
      connectorTransientFailure("upstream unavailable"),
      connectorTransientFailure("upstream unavailable"),
    ], identity("github"));
    const delays: number[] = [];
    const fallback = await executeConnectorRequest(db, transient, {
      ...auditIdentity,
      requestId: "REQ-CONN-TRANSIENT",
      connector: { id: "github", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T00:08:00Z", {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      loadStaticFallback: async () => ({ contentUtf8: fallbackContentUtf8, value: { fallback: true } }),
    }));
    expect(transient.invocationCount).toBe(2);
    expect(fallback).toEqual({ fallback: true });
    expect(delays).toEqual([7]);
  });

  it("opens and resets a circuit using only its approved reset interval", async () => {
    const failing = new FakeConnector([
      connectorTransientFailure("circuit seed one"),
      connectorTransientFailure("circuit seed two"),
    ], identity("circuit"));
    await expect(executeConnectorRequest(db, failing, {
      ...auditIdentity,
      requestId: "REQ-CONN-CIRCUIT-SEED",
      connector: { id: "circuit", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T00:08:00Z"))).rejects.toMatchObject({ kind: "transient" });
    expect(failing.invocationCount).toBe(2);

    const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("circuit"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-CIRCUIT",
      connector: { id: "circuit", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T00:10:00Z"))).rejects.toMatchObject({ reasonCode: "circuit-open" });
    expect(connector.invocationCount).toBe(0);

    const recovered = new FakeConnector([{ ok: true, value: { recovered: true } }], identity("circuit"));
    await expect(executeConnectorRequest(db, recovered, {
      ...auditIdentity,
      requestId: "REQ-CONN-CIRCUIT-RESET",
      connector: { id: "circuit", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T01:09:00Z"))).resolves.toEqual({ recovered: true });
    expect(recovered.invocationCount).toBe(1);
  });

  it("enforces rate limit before side effect on an isolated materialized policy", async () => {
    const first = new FakeConnector([{ ok: true, value: { ok: 1 } }], identity("slack"));
    const request = {
      connector: { id: "slack", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    } as const;
    await executeConnectorRequest(db, first, {
      ...request,
      dataClasses: [...request.dataClasses],
      scopes: [...request.scopes],
      ...auditIdentity,
      requestId: "REQ-CONN-RATE-1",
    }, runtimeAt("2026-08-03T01:00:00Z"));
    const denied = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("slack"));
    await expect(executeConnectorRequest(db, denied, {
      ...request,
      dataClasses: [...request.dataClasses],
      scopes: [...request.scopes],
      ...auditIdentity,
      requestId: "REQ-CONN-RATE-2",
    }, runtimeAt("2026-08-03T01:00:01Z"))).rejects.toMatchObject({ reasonCode: "rate-limit" });
    expect(denied.invocationCount).toBe(0);
  });

  it("serializes concurrent requests at the exact rate-limit boundary", async () => {
    const connector = new FakeConnector([{ ok: true, value: { one: true } }], identity("concurrent-rate"));
    const request = {
      ...auditIdentity,
      connector: { id: "concurrent-rate", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    };
    const outcomes = await Promise.allSettled([
      executeConnectorRequest(db, connector, { ...request, requestId: "REQ-CONN-RATE-CONCURRENT-1" }, runtimeAt("2026-08-03T01:05:00Z")),
      executeConnectorRequest(db, connector, { ...request, requestId: "REQ-CONN-RATE-CONCURRENT-2" }, runtimeAt("2026-08-03T01:05:00Z")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(connector.invocationCount).toBe(1);
  });

  it("deduplicates concurrent request IDs so at most one connector side effect occurs", async () => {
    const connector = new FakeConnector([{ ok: true, value: { objectId: "one-side-effect" } }], identity("linear"));
    const request = {
      ...auditIdentity,
      requestId: "REQ-CONN-CONCURRENT",
      connector: { id: "linear", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    };
    const outcomes = await Promise.allSettled([
      executeConnectorRequest(db, connector, request, runtimeAt("2026-08-03T02:00:00Z")),
      executeConnectorRequest(db, connector, request, runtimeAt("2026-08-03T02:00:00Z")),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(connector.invocationCount).toBe(1);
  });

  it("enforces the materialized timeout and classifies it without an unbounded retry", async () => {
    let calls = 0;
    const connector = {
      identity: identity("notion"),
      execute: async (input: { signal: AbortSignal }) => {
        calls += 1;
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-TIMEOUT",
      connector: { id: "notion", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T02:30:00Z"))).rejects.toBeInstanceOf(ConnectorReconciliationRequiredError);
    expect(calls).toBe(1);
    const ambiguity = await db.execute(sql`
      SELECT decision, reason_code FROM dopaios_connector_audit_events
      WHERE request_id = 'REQ-CONN-TIMEOUT' AND decision = 'reconciliation-required'
    `);
    expect(ambiguity).toEqual([{ decision: "reconciliation-required", reason_code: "timeout" }]);
  });

  it("never retries an external side effect after the success audit fails", async () => {
    const connector = new FakeConnector([
      { ok: true, value: { remoteMutation: "done-once" } },
      { ok: true, value: { remoteMutation: "must-not-run" } },
    ], identity("audit-failure"));
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION kc08_reject_success_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.request_id = 'REQ-CONN-AUDIT-FAILURE' AND NEW.decision = 'success' THEN
          RAISE EXCEPTION 'injected audit projection failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER kc08_reject_success_audit
        BEFORE INSERT ON dopaios_connector_audit_events
        FOR EACH ROW EXECUTE FUNCTION kc08_reject_success_audit();
    `));
    try {
      await expect(executeConnectorRequest(db, connector, {
        ...auditIdentity,
        requestId: "REQ-CONN-AUDIT-FAILURE",
        connector: { id: "audit-failure", version: "2026-07-01" },
        projectId,
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload: {},
      }, runtimeAt("2026-08-03T02:40:00Z"))).rejects.toThrow();
      expect(connector.invocationCount).toBe(1);
      const durable = await db.execute(sql`
        SELECT decision, reason_code FROM dopaios_connector_audit_events
        WHERE request_id = 'REQ-CONN-AUDIT-FAILURE' ORDER BY decision
      `);
      expect(durable).toContainEqual({ decision: "intent", reason_code: "attempt-started" });
      expect(durable).toContainEqual({ decision: "reconciliation-required", reason_code: "outcome-audit-failed" });
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS kc08_reject_success_audit ON dopaios_connector_audit_events;
        DROP FUNCTION IF EXISTS kc08_reject_success_audit();
      `));
    }
  });

  it("does not retry an unclassified adapter failure", async () => {
    let calls = 0;
    const connector = {
      identity: identity("audit-failure"),
      execute: async () => {
        calls += 1;
        throw new Error("unclassified adapter failure");
      },
    };
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-UNKNOWN-ERROR",
      connector: { id: "audit-failure", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T02:41:00Z"))).rejects.toThrow("unclassified adapter failure");
    expect(calls).toBe(1);
  });

  it("denies empty data classification and scope before adapter execution", async () => {
    const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("slack"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-EMPTY-CLASSIFICATION",
      connector: { id: "slack", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: [],
      scopes: [],
      payload: { classified: false },
    }, runtimeAt("2026-08-03T02:42:00Z"))).rejects.toMatchObject({ reasonCode: "classification-missing" });
    expect(connector.invocationCount).toBe(0);
  });

  it("binds authorization to the concrete adapter identity", async () => {
    const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("linear"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-ADAPTER-MISMATCH",
      connector: { id: "slack", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T02:43:00Z"))).rejects.toMatchObject({ reasonCode: "adapter-policy-mismatch" });
    expect(connector.invocationCount).toBe(0);
  });

  it("rejects inline credential material instead of persisting it as a reference", async () => {
    await expect(materializeConnectorPolicy(db, cmd("inline-secret-policy"), {
      ...basePolicy,
      policyId: "CONN-POL-KC08-INLINE-SECRET",
      connector: { id: "inline-secret", version: "2026-07-01" },
      auth: { type: "github-app", credentialRef: { token: "must-never-persist" } as never },
      fallback: { mode: "none" },
    })).rejects.toMatchObject({ code: "ERR-CONNECTOR-CREDENTIAL-REF" });
    const leaked = (await db.execute(sql`
      SELECT count(*)::int AS n FROM message_store.messages
      WHERE data::text LIKE '%must-never-persist%'
    `)) as unknown as Array<{ n: number }>;
    expect(leaked[0]?.n).toBe(0);
  });

  it("namespaces idempotency by Project so a reused request ID cannot cause cross-Project collision", async () => {
    const allowed = new FakeConnector([{ ok: true, value: { ok: true } }], identity("github"));
    const requestId = "REQ-CONN-SAME-ID-XPROJECT";
    await executeConnectorRequest(db, allowed, {
      ...auditIdentity,
      requestId,
      connector: { id: "github", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T02:44:00Z"));
    const denied = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("github"));
    await expect(executeConnectorRequest(db, denied, {
      ...projectBAuditIdentity,
      requestId,
      connector: { id: "github", version: "2026-07-01" },
      projectId: "PROJECT-KC08-CONNECTOR-B",
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T02:44:00Z"))).rejects.toMatchObject({ reasonCode: "policy-missing" });
    expect(denied.invocationCount).toBe(0);
  });

  it("selects the newest effective policy revision and retains exact policy provenance", async () => {
    const revisionOne: ConnectorPolicyInput = {
      ...basePolicy,
      policyId: "CONN-POL-KC08-REVISIONED",
      connector: { id: "revisioned", version: "2026-07-01" },
      fallback: { mode: "none" },
    };
    await approveAndMaterialize("revisioned-policy-1", revisionOne);
    await approveAndMaterialize("revisioned-policy-2", {
      ...revisionOne,
      policyRevision: 2,
      effectiveAt: "2030-01-01T00:00:00.000Z",
      rateLimit: { limit: 9, windowMs: 60_000 },
    });
    for (const [requestId, at] of [
      ["REQ-CONN-REVISION-1", "2026-08-03T02:45:00Z"],
      ["REQ-CONN-REVISION-2", "2030-01-01T00:00:01Z"],
    ] as const) {
      const connector = new FakeConnector([{ ok: true, value: { requestId } }], identity("revisioned"));
      await executeConnectorRequest(db, connector, {
        ...auditIdentity,
        requestId,
        connector: { id: "revisioned", version: "2026-07-01" },
        projectId,
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload: {},
      }, runtimeAt(at));
    }
    const revisions = (await db.execute(sql`
      SELECT request_id, policy_revision, policy_sha256
      FROM dopaios_connector_audit_events
      WHERE request_id IN ('REQ-CONN-REVISION-1', 'REQ-CONN-REVISION-2')
        AND decision = 'allow'
      ORDER BY request_id
    `)) as unknown as Array<{ request_id: string; policy_revision: number; policy_sha256: string }>;
    expect(revisions.map((row) => [row.request_id, row.policy_revision])).toEqual([
      ["REQ-CONN-REVISION-1", 1],
      ["REQ-CONN-REVISION-2", 2],
    ]);
    expect(revisions.every((row) => /^[0-9a-f]{64}$/u.test(row.policy_sha256))).toBe(true);
  });

  it("rejects unsafe retry timer bounds", async () => {
    await expect(materializeConnectorPolicy(db, cmd("unsafe-timer-policy"), {
      ...basePolicy,
      policyId: "CONN-POL-KC08-UNSAFE-TIMER",
      connector: { id: "unsafe-timer", version: "2026-07-01" },
      backoff: { strategy: "exponential", delayMs: 1, maxDelayMs: -1 },
      fallback: { mode: "none" },
    })).rejects.toMatchObject({ code: "ERR-CONNECTOR-POLICY-SHAPE" });
  });

  it("fails closed when the FS-004 session/activation/lease binding is absent or stale", async () => {
    for (const [requestId, binding, reasonCode] of [
      ["REQ-CONN-NO-SESSION", { ...auditIdentity, sessionId: "SESSION-DOES-NOT-EXIST" }, "execution-binding-invalid"],
      ["REQ-CONN-STALE-LEASE", { ...auditIdentity, leaseEpoch: 99 }, "execution-binding-invalid"],
    ] as const) {
      const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("linear"));
      await expect(executeConnectorRequest(db, connector, {
        ...binding,
        requestId,
        connector: { id: "linear", version: "2026-07-01" },
        projectId,
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload: {},
      }, runtimeAt("2026-08-03T03:01:00Z"))).rejects.toMatchObject({ reasonCode });
      expect(connector.invocationCount).toBe(0);
    }
  });

  it("binds the adapter credential reference and external-idempotency capability", async () => {
    for (const [requestId, adapterIdentity] of [
      ["REQ-CONN-CREDENTIAL-MISMATCH", {
        ...identity("linear"),
        credentialRef: { secretRef: "secret://github-app/wrong" },
      }],
      ["REQ-CONN-NON-IDEMPOTENT", {
        ...identity("linear"),
        supportsExternalIdempotency: false,
      }],
    ] as const) {
      const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], adapterIdentity);
      await expect(executeConnectorRequest(db, connector, {
        ...auditIdentity,
        requestId,
        connector: { id: "linear", version: "2026-07-01" },
        projectId,
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload: {},
      }, runtimeAt("2026-08-03T03:02:00Z"))).rejects.toMatchObject({ reasonCode: "adapter-policy-mismatch" });
      expect(connector.invocationCount).toBe(0);
    }
  });

  it("requires a KC-03 approval record bound to the exact connector policy target", async () => {
    await expect(materializeConnectorPolicy(db, cmd("wrong-policy-approval"), {
      ...basePolicy,
      policyId: "CONN-POL-KC08-WRONG-APPROVAL",
      connector: { id: "wrong-approval", version: "2026-07-01" },
      fallback: { mode: "none" },
    })).rejects.toMatchObject({ code: "ERR-CONNECTOR-APPROVAL" });
  });

  it("enforces the materialized request range before invoking an adapter", async () => {
    for (const [requestId, payload, reasonCode] of [
      ["REQ-CONN-KEY-RANGE", { unexpected: true }, "payload-key-denied"],
      ["REQ-CONN-BYTE-RANGE", { repository: "x".repeat(600) }, "payload-size-exceeded"],
    ] as const) {
      const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("linear"));
      await expect(executeConnectorRequest(db, connector, {
        ...auditIdentity,
        requestId,
        connector: { id: "linear", version: "2026-07-01" },
        projectId,
        purpose: "read-source",
        action: "repository.read",
        direction: "egress",
        dataClasses: ["source-code"],
        scopes: ["contents:read"],
        payload,
      }, runtimeAt("2026-08-03T03:03:00Z"))).rejects.toMatchObject({ reasonCode });
      expect(connector.invocationCount).toBe(0);
    }
  });

  it("does not retry a transient failure whose commit state is ambiguous", async () => {
    const connector = new FakeConnector([{
      ok: false,
      error: new ConnectorExecutionError("transient", "connection lost after commit", false),
    }], identity("linear"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-AMBIGUOUS-TRANSIENT",
      connector: { id: "linear", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T03:04:00Z"))).rejects.toBeInstanceOf(ConnectorReconciliationRequiredError);
    expect(connector.invocationCount).toBe(1);
  });

  it("keeps idempotency stable across trusted clock changes", async () => {
    const request = {
      ...auditIdentity,
      requestId: "REQ-CONN-CLOCK-STABLE",
      connector: { id: "linear", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    };
    const connector = new FakeConnector([{ ok: true, value: { stable: true } }], identity("linear"));
    await executeConnectorRequest(db, connector, request, runtimeAt("2026-08-03T03:05:00Z"));
    await expect(executeConnectorRequest(db, connector, request, runtimeAt("2026-08-03T03:06:00Z")))
      .rejects.toMatchObject({ reasonCode: "duplicate-request" });
    const reasons = await db.execute(sql`
      SELECT reason_code FROM dopaios_connector_audit_events
      WHERE request_id = 'REQ-CONN-CLOCK-STABLE' AND decision = 'deny'
    `);
    expect(reasons).toEqual([{ reason_code: "duplicate-request" }]);
    expect(connector.invocationCount).toBe(1);
  });

  it("timestamps each retry attempt from the trusted runtime clock", async () => {
    let tick = Date.parse("2026-08-03T03:07:00.000Z");
    const connector = new FakeConnector([
      connectorTransientFailure("retry-safe transient"),
      { ok: true, value: { recovered: true } },
    ], identity("linear"));
    await executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-ATTEMPT-TIMES",
      connector: { id: "linear", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, {
      ...runtimeAt("2026-08-03T03:07:00.000Z"),
      now: () => new Date((tick += 1_000)),
    });
    const attempts = (await db.execute(sql`
      SELECT attempt, min(created_at) AS created_at
      FROM dopaios_connector_audit_events
      WHERE request_id = 'REQ-CONN-ATTEMPT-TIMES' AND attempt > 0
      GROUP BY attempt ORDER BY attempt
    `)) as unknown as Array<{ attempt: number; created_at: Date | string }>;
    expect(attempts).toHaveLength(2);
    expect(new Date(attempts[1]!.created_at).getTime()).toBeGreaterThan(new Date(attempts[0]!.created_at).getTime());
  });

  it("revalidates the currently effective policy before retrying", async () => {
    const revisionOne = await approveAndMaterialize("policy-shift-1", {
      ...basePolicy,
      policyId: "CONN-POL-KC08-POLICY-SHIFT",
      connector: { id: "policy-shift", version: "2026-07-01" },
      fallback: { mode: "none" },
      rateLimit: { limit: 20, windowMs: 60_000 },
      circuitBreaker: { threshold: 20, reset: { mode: "after", delayMs: 3_600_000 } },
    });
    const connector = new FakeConnector([
      connectorTransientFailure("retry-safe before policy shift"),
      { ok: true, value: { mustNotRun: true } },
    ], identity("policy-shift"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-POLICY-SHIFT",
      connector: { id: "policy-shift", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T03:08:00Z", {
      sleep: async () => {
        await approveAndMaterialize("policy-shift-2", {
          ...revisionOne,
          policyRevision: 2,
          effectiveAt: "2026-08-03T03:08:00.000Z",
          rateLimit: { limit: 19, windowMs: 60_000 },
        });
      },
    }))).rejects.toMatchObject({ reasonCode: "policy-replaced" });
    expect(connector.invocationCount).toBe(1);
  });

  it("hashes exact fallback bytes and rejects a semantically equal file with different bytes", async () => {
    const connector = new FakeConnector([
      connectorTransientFailure("first transient"),
      connectorTransientFailure("second transient"),
    ], identity("fallback-loader"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-FALLBACK-BYTE-HASH",
      connector: { id: "fallback-loader", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T03:09:00Z", {
      loadStaticFallback: async () => ({ contentUtf8: ' {"fallback":true}', value: { fallback: true } }),
    }))).rejects.toMatchObject({ reasonCode: "fallback-hash-mismatch" });
  });

  it("audits a static fallback loader failure before denying", async () => {
    const connector = new FakeConnector([
      connectorTransientFailure("first transient"),
      connectorTransientFailure("second transient"),
    ], identity("fallback-loader"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-FALLBACK-LOAD-FAILURE",
      connector: { id: "fallback-loader", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T03:05:00Z", {
      loadStaticFallback: async () => {
        throw new Error("fallback file unavailable");
      },
    }))).rejects.toMatchObject({ reasonCode: "fallback-load-failed" });
    const audit = (await db.execute(sql`
      SELECT decision, reason_code FROM dopaios_connector_audit_events
      WHERE request_id = 'REQ-CONN-FALLBACK-LOAD-FAILURE'
      ORDER BY attempt, decision
    `)) as unknown as Array<{ decision: string; reason_code: string }>;
    expect(audit).toContainEqual({ decision: "fallback-deny", reason_code: "fallback-load-failed" });
  });

  it("re-checks every policy artifact before retry and blocks a newly impacted fallback", async () => {
    const connector = new FakeConnector([
      connectorTransientFailure("first transient"),
      connectorTransientFailure("second transient"),
    ], identity("github"));
    let invalidated = false;
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-FALLBACK-INVALIDATED",
      connector: { id: "github", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T03:10:00Z", {
      sleep: async () => {
        if (!invalidated) {
          invalidated = true;
          await markArtifactImpact(db, cmd("fallback-impact"), {
            artifactId: "CTX-STATIC-FALLBACK-KC08",
            revision: 1,
            impactStatus: "impact-pending",
          });
        }
      },
      loadStaticFallback: async () => ({ contentUtf8: fallbackContentUtf8, value: { fallback: true } }),
    }))).rejects.toMatchObject({ reasonCode: "policy-reference-invalid" });
    expect(connector.invocationCount).toBe(1);
    const audit = (await db.execute(sql`
      SELECT decision, reason_code FROM dopaios_connector_audit_events
      WHERE request_id = 'REQ-CONN-FALLBACK-INVALIDATED'
      ORDER BY attempt, decision
    `)) as unknown as Array<{ decision: string; reason_code: string }>;
    expect(audit).toContainEqual({ decision: "deny", reason_code: "policy-reference-invalid" });
  });

  it("re-checks materialized policy artifacts and denies impact-pending data policy before side effect", async () => {
    await markArtifactImpact(db, cmd("data-policy-impact"), {
      artifactId: "POL-DATA-KC08",
      revision: 1,
      impactStatus: "impact-pending",
    });
    const connector = new FakeConnector([{ ok: true, value: { impossible: true } }], identity("linear"));
    await expect(executeConnectorRequest(db, connector, {
      ...auditIdentity,
      requestId: "REQ-CONN-POLICY-IMPACT",
      connector: { id: "linear", version: "2026-07-01" },
      projectId,
      purpose: "read-source",
      action: "repository.read",
      direction: "egress",
      dataClasses: ["source-code"],
      scopes: ["contents:read"],
      payload: {},
    }, runtimeAt("2026-08-03T03:00:00Z"))).rejects.toMatchObject({ reasonCode: "policy-reference-invalid" });
    expect(connector.invocationCount).toBe(0);
  });

  it("requires every populated connector audit policy pin to be complete and exact", async () => {
    const allowed = (await db.execute(sql`
      SELECT id FROM dopaios_connector_audit_events
      WHERE decision = 'allow' AND policy_id IS NOT NULL
      ORDER BY created_at
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    expect(allowed[0]).toBeDefined();

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE dopaios_connector_audit_events SET policy_sha256 = NULL
        WHERE id = ${allowed[0]!.id}
      `);
      throw new Error("DATABASE_ACCEPTED_PARTIAL_CONNECTOR_POLICY_PIN");
    })).rejects.toMatchObject({ cause: { code: "23514" } });

    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE dopaios_connector_audit_events
        SET policy_id = 'CONN-POL-KC08-FORGED', policy_revision = 99,
            policy_sha256 = ${"f".repeat(64)}
        WHERE id = ${allowed[0]!.id}
      `);
      throw new Error("DATABASE_ACCEPTED_NONEXISTENT_CONNECTOR_POLICY_PIN");
    })).rejects.toMatchObject({ cause: { code: "23503" } });

    for (const mutation of [
      sql`UPDATE dopaios_connector_audit_events
          SET project_id = 'PROJECT-KC08-CONNECTOR-B'
          WHERE id = ${allowed[0]!.id}`,
      sql`UPDATE dopaios_connector_audit_events
          SET action = 'repository.write'
          WHERE id = ${allowed[0]!.id}`,
    ]) {
      await expect(db.transaction(async (tx) => {
        await tx.execute(mutation);
        throw new Error("DATABASE_ACCEPTED_MISATTRIBUTED_CONNECTOR_POLICY");
      })).rejects.toMatchObject({ cause: { code: "23503" } });
    }

    const prePolicyDenials = await db.execute(sql`
      SELECT id FROM dopaios_connector_audit_events
      WHERE decision = 'deny' AND policy_id IS NULL
        AND policy_revision IS NULL AND policy_sha256 IS NULL
      LIMIT 1
    `);
    expect(prePolicyDenials.length).toBeGreaterThan(0);
  });

  it("replays connector policies and structured audit byte-identically", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    expect(await snapshotProjections(db)).toEqual(before);
  });
});
