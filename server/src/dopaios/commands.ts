import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandContext,
  type CommandResult,
  executeCommand,
  payloadSha256,
  CommandRejectedError,
} from "./event-store.js";

// KC-01 spike command set: the minimum surface needed to drive the canonical
// fixtures fx-01 (NONE → PREPARING, FS-001) and fx-02 (run-test chain,
// FS-003 US1–US7) through the event store. Guards read projections inside the
// command transaction, i.e. on the same snapshot the events commit on
// (FS-003 SFR-048/049). Rejections throw before any event is emitted, so a
// rejected command leaves no partial record (REC-001).

type Json = Record<string, unknown>;

async function one<T>(ctx: CommandContext, query: ReturnType<typeof sql>): Promise<T | null> {
  const rows = (await ctx.tx.execute(query)) as unknown as T[];
  return rows[0] ?? null;
}

async function requireActorWithCapability(
  ctx: CommandContext,
  actorId: string,
  capability: string,
): Promise<void> {
  const actor = await one<{ active: boolean; capabilities: string[] }>(
    ctx,
    sql`SELECT active, capabilities FROM dopaios_actors WHERE id = ${actorId}`,
  );
  if (!actor) {
    throw new CommandRejectedError("ERR-ACTOR-UNKNOWN", `Actor ${actorId} is not registered`);
  }
  if (!actor.active) {
    throw new CommandRejectedError("ERR-001", `Actor ${actorId} is not active`);
  }
  if (!actor.capabilities.includes(capability)) {
    throw new CommandRejectedError("SFR-004", `Actor ${actorId} lacks capability ${capability}`);
  }
}

export async function registerActor(
  db: Db,
  commandId: string,
  payload: { actorId: string; kind: string; active: boolean; capabilities: string[] },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload,
    handler: async (ctx, p) => {
      await ctx.emit({
        streamName: `dopaiosActor-${p["actorId"]}`,
        type: "ActorRegistered",
        data: p,
      });
      return { actorId: p["actorId"] as string };
    },
  });
}

// fx-01 base_command: create-project-shell (FS-001 NONE → PREPARING).
export async function createProjectShell(
  db: Db,
  commandId: string,
  payload: {
    projectId: string;
    actor: string;
    templateRef: { template_id: string; revision: number; sha256: string };
    expectedTemplateSha256: string;
    orchestrator: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const templateRef = p["templateRef"] as { sha256: string };
      await requireActorWithCapability(ctx, p["actor"] as string, "project-creator");
      await requireActorWithCapability(ctx, p["orchestrator"] as string, "orchestrator");
      if (templateRef.sha256 !== (p["expectedTemplateSha256"] as string)) {
        throw new CommandRejectedError(
          "ERR-TEMPLATE-PIN",
          "Template pin does not match the registered template hash",
        );
      }
      await ctx.emit({
        streamName: `dopaiosProject-${p["projectId"]}`,
        type: "ProjectShellCreated",
        data: {
          projectId: p["projectId"],
          templateRef: p["templateRef"],
          orchestrator: p["orchestrator"],
          createdBy: p["actor"],
        },
        metadata: { commandId, audit: true },
        expectedVersion: -1,
      });
      return { projectId: p["projectId"] as string, state: "PREPARING" };
    },
  });
}

// fx-02 S01: register the business-test SOP artifact as approved in the
// FS-002 ledger slice.
export async function registerApprovedArtifact(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number; sha256: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactRegistered",
        data: { ...p, artifactState: "approved", impactStatus: "clear" },
      });
      return { artifactId: p["artifactId"] as string, artifactState: "approved" };
    },
  });
}

// fx-02 S02: create-sop-definition pinning the approved SOP artifact.
export async function createSopDefinition(
  db: Db,
  commandId: string,
  payload: {
    definitionId: string;
    revision: number;
    sopPin: { artifactId: string; revision: number; sha256: string };
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const pin = p["sopPin"] as { artifactId: string; revision: number; sha256: string };
      const artifact = await one<{ sha256: string; artifact_state: string }>(
        ctx,
        sql`SELECT sha256, artifact_state FROM dopaios_artifacts
            WHERE id = ${pin.artifactId} AND revision = ${pin.revision}`,
      );
      if (!artifact || artifact.artifact_state !== "approved") {
        throw new CommandRejectedError("ERR-SOP-PIN", "Pinned SOP artifact is not approved");
      }
      if (artifact.sha256 !== pin.sha256) {
        throw new CommandRejectedError("ERR-SOP-PIN-HASH", "Pinned SOP hash mismatch");
      }
      await ctx.emit({
        streamName: `dopaiosSopDefinition-${p["definitionId"]}`,
        type: "SopDefinitionCreated",
        data: { definitionId: p["definitionId"], revision: p["revision"], sopPin: p["sopPin"] },
      });
      return { definitionId: p["definitionId"] as string, state: "draft" };
    },
  });
}

// fx-02 S03: publish-sop-definition. The contract-suite stand-in compares the
// definition content hash against the pinned SOP artifact hash — the mismatch
// fixture (FX-02-N01) must be blocked while the definition stays draft.
export async function publishSopDefinition(
  db: Db,
  commandId: string,
  payload: { definitionId: string; definitionContentSha256: string; expectedSopSha256: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const definition = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_sop_definitions WHERE id = ${p["definitionId"]}`,
      );
      if (!definition || definition.state !== "draft") {
        throw new CommandRejectedError("ERR-DEF-STATE", "Definition is not in draft");
      }
      if (p["definitionContentSha256"] !== p["expectedSopSha256"]) {
        throw new CommandRejectedError(
          "US1-AC3",
          "Contract suite: definition diverges from the business SOP",
        );
      }
      await ctx.emit({
        streamName: `dopaiosSopDefinition-${p["definitionId"]}`,
        type: "SopDefinitionPublished",
        data: {
          definitionId: p["definitionId"],
          contractSuiteEvidence: {
            comparedSha256: p["definitionContentSha256"],
            result: "pass",
          },
        },
      });
      return { definitionId: p["definitionId"] as string, state: "published" };
    },
  });
}

// fx-02 S04: request-test-run with the pinned fixture package.
export async function requestTestRun(
  db: Db,
  commandId: string,
  payload: {
    runId: string;
    definitionRef: Json;
    decider: string;
    pod: string;
    fixturePackage: Json;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const definitionRef = p["definitionRef"] as { definitionId: string };
      const definition = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_sop_definitions WHERE id = ${definitionRef.definitionId}`,
      );
      if (!definition || definition.state !== "published") {
        throw new CommandRejectedError("ERR-DEF-NOT-PUBLISHED", "Definition is not published");
      }
      await ctx.emit({
        streamName: `dopaiosSopRun-${p["runId"]}`,
        type: "TestRunRequested",
        data: {
          runId: p["runId"],
          definitionRef: p["definitionRef"],
          decider: p["decider"],
          pod: p["pod"],
          fixturePackage: p["fixturePackage"],
        },
        expectedVersion: -1,
      });
      return { runId: p["runId"] as string, state: "NOT_ACTIVATED" };
    },
  });
}

// fx-02 S05: activate-sop-run. Run RUNNING plus the T1 work-item passing
// PROPOSED → ACCEPTED inside the same activation transaction (SFR-017);
// activation is idempotent per command_id (SFR-011).
export async function activateSopRun(
  db: Db,
  commandId: string,
  payload: { runId: string; workItemId: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const run = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_sop_runs WHERE id = ${p["runId"]}`,
      );
      if (!run || run.state !== "NOT_ACTIVATED") {
        throw new CommandRejectedError("SFR-011", "Run is not in NOT_ACTIVATED");
      }
      const runStream = `dopaiosSopRun-${p["runId"]}`;
      await ctx.emit({
        streamName: runStream,
        type: "SopRunStateChanged",
        data: { runId: p["runId"], state: "RUNNING" },
      });
      const workItemStream = `dopaiosWorkItem-${p["workItemId"]}`;
      await ctx.emit({
        streamName: workItemStream,
        type: "WorkItemCreated",
        data: { workItemId: p["workItemId"], runId: p["runId"], state: "PROPOSED" },
        expectedVersion: -1,
      });
      await ctx.emit({
        streamName: workItemStream,
        type: "WorkItemStateChanged",
        data: { workItemId: p["workItemId"], state: "ACCEPTED" },
      });
      return { runId: p["runId"] as string, state: "RUNNING", workItem: "ACCEPTED" };
    },
  });
}

// fx-02 S06: run-fixture-execution — CLAIMED → IN_PROGRESS → SUBMITTED in one
// atomic transaction (SFR-049) plus the first output version.
export async function runFixtureExecution(
  db: Db,
  commandId: string,
  payload: {
    workItemId: string;
    executor: string;
    outputId: string;
    outputRevision: number;
    contentSha256: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workItem = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_work_items WHERE id = ${p["workItemId"]}`,
      );
      if (!workItem || workItem.state !== "ACCEPTED") {
        throw new CommandRejectedError("DEV-010", "Work item is not ACCEPTED");
      }
      const stream = `dopaiosWorkItem-${p["workItemId"]}`;
      for (const state of ["CLAIMED", "IN_PROGRESS", "SUBMITTED"]) {
        await ctx.emit({
          streamName: stream,
          type: "WorkItemStateChanged",
          data: { workItemId: p["workItemId"], state, executor: p["executor"] },
        });
      }
      await ctx.emit({
        streamName: `dopaiosOutput-${p["outputId"]}`,
        type: "OutputVersionRecorded",
        data: {
          outputId: p["outputId"],
          revision: p["outputRevision"],
          workItemId: p["workItemId"],
          state: "SELF_CHECK",
          contentSha256: p["contentSha256"],
        },
        expectedVersion: -1,
      });
      return { workItemId: p["workItemId"] as string, state: "SUBMITTED" };
    },
  });
}

// fx-02 S07: self-check then independent review — reviewer must differ from
// executor (SFR-019/020); output SELF_CHECK → INDEPENDENT_CHECK →
// CHECK_PASSED; work item UNDER_REVIEW → COMPLETED.
export async function reviewFixtureExecution(
  db: Db,
  commandId: string,
  payload: {
    workItemId: string;
    outputId: string;
    outputRevision: number;
    executor: string;
    reviewer: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      if (p["reviewer"] === p["executor"]) {
        throw new CommandRejectedError("SFR-019", "Reviewer must differ from executor");
      }
      const workItemStream = `dopaiosWorkItem-${p["workItemId"]}`;
      const outputStream = `dopaiosOutput-${p["outputId"]}`;
      await ctx.emit({
        streamName: workItemStream,
        type: "WorkItemStateChanged",
        data: { workItemId: p["workItemId"], state: "UNDER_REVIEW" },
      });
      for (const state of ["INDEPENDENT_CHECK", "CHECK_PASSED"]) {
        await ctx.emit({
          streamName: outputStream,
          type: "OutputVersionStateChanged",
          data: { outputId: p["outputId"], revision: p["outputRevision"], state },
        });
      }
      await ctx.emit({
        streamName: workItemStream,
        type: "WorkItemStateChanged",
        data: { workItemId: p["workItemId"], state: "COMPLETED" },
      });
      return { workItemId: p["workItemId"] as string, state: "COMPLETED" };
    },
  });
}

// fx-02 S08: advance-step to T2 — decision package with pinned refs plus the
// decision-type action request, output AWAITING_DECISION.
export async function advanceToDecision(
  db: Db,
  commandId: string,
  payload: {
    runId: string;
    outputId: string;
    outputRevision: number;
    packageId: string;
    packageRevision: number;
    refs: Json;
    requestId: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      // KC-03 (FX-03-B04, AC-FR-24.2): output AI chỉ được trình duyệt khi đã
      // qua trọn chuỗi tự kiểm → kiểm độc lập (CHECK_PASSED) — thiếu chuỗi
      // review độc lập thì chặn ngay tại bước trình.
      const output = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_output_versions
            WHERE id = ${p["outputId"]} AND revision = ${p["outputRevision"]}`,
      );
      if (!output || output.state !== "CHECK_PASSED") {
        throw new CommandRejectedError(
          "AC-FR-24.2",
          "Output lacks the independent review chain — self-check and independent check must pass before advancing to decision",
        );
      }
      await ctx.emit({
        streamName: `dopaiosOutput-${p["outputId"]}`,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["outputRevision"], state: "AWAITING_DECISION" },
      });
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageAssembled",
        data: { packageId: p["packageId"], revision: p["packageRevision"], refs: p["refs"] },
        expectedVersion: -1,
      });
      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["requestId"]}`,
        type: "ActionRequestCreated",
        data: { requestId: p["requestId"], kind: "decision", runId: p["runId"] },
        expectedVersion: -1,
      });
      return { packageId: p["packageId"] as string, requestState: "OPEN" };
    },
  });
}

// fx-02 S09: acknowledge + record approval. The approval must pin refs
// byte-equivalent to the decision package (SFR-028); request DECIDED and
// output APPROVED commit in the same transaction.
export async function recordApproval(
  db: Db,
  commandId: string,
  payload: {
    requestId: string;
    recordId: string;
    packageId: string;
    packageRevision: number;
    pinnedRefs: Json;
    actor: string;
    outputId: string;
    outputRevision: number;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      // KC-13 B7 (finding review đối kháng — SFR-023/SFR-042): S09 là điểm
      // quyết định mà runner dừng chờ, nên thẩm quyền phải đóng fail-closed:
      // actor phải ĐÚNG người quyết được pin của run tại request-test-run và
      // là actor NGƯỜI đang active — AI hay định danh lạ đều bị chặn. KC-01
      // để trống guard này vì slice chưa có consumer tự động.
      const request = await one<{ run_id: string }>(
        ctx,
        sql`SELECT run_id FROM dopaios_action_requests WHERE id = ${p["requestId"]}`,
      );
      if (!request) {
        throw new CommandRejectedError("ERR-REQUEST", "Action request not found");
      }
      const run = await one<{ decider: string }>(
        ctx,
        sql`SELECT decider FROM dopaios_sop_runs WHERE id = ${request.run_id}`,
      );
      if (!run || run.decider !== p["actor"]) {
        throw new CommandRejectedError("SFR-042", "Actor is not the pinned decider of this run");
      }
      const deciderActor = await one<{ kind: string; active: boolean }>(
        ctx,
        sql`SELECT kind, active FROM dopaios_actors WHERE id = ${p["actor"]}`,
      );
      if (!deciderActor || !deciderActor.active) {
        throw new CommandRejectedError("ERR-ACTOR", "Decider is not a registered active actor");
      }
      if (deciderActor.kind !== "human") {
        throw new CommandRejectedError(
          "SFR-023",
          "AI holds no approval authority — the run decider must be a human Staff",
        );
      }
      const pkg = await one<{ refs: Json }>(
        ctx,
        sql`SELECT refs FROM dopaios_decision_packages
            WHERE id = ${p["packageId"]} AND revision = ${p["packageRevision"]}`,
      );
      if (!pkg) {
        throw new CommandRejectedError("ERR-PKG", "Decision package not found");
      }
      if (payloadSha256(pkg.refs) !== payloadSha256(p["pinnedRefs"])) {
        throw new CommandRejectedError(
          "SFR-028",
          "Approval refs are not byte-equivalent to the decision package",
        );
      }
      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["requestId"]}`,
        type: "ActionRequestStateChanged",
        data: { requestId: p["requestId"], state: "ACKNOWLEDGED", decidedBy: p["actor"] },
      });
      await ctx.emit({
        streamName: `dopaiosApprovalRecord-${p["recordId"]}`,
        type: "ApprovalRecorded",
        data: {
          recordId: p["recordId"],
          packageId: p["packageId"],
          packageRevision: p["packageRevision"],
          outcome: "approve",
          pinnedRefs: p["pinnedRefs"],
          actor: p["actor"],
        },
        expectedVersion: -1,
      });
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageStateChanged",
        data: { packageId: p["packageId"], state: "DECIDED" },
      });
      await ctx.emit({
        streamName: `dopaiosOutput-${p["outputId"]}`,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["outputRevision"], state: "APPROVED" },
      });
      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["requestId"]}`,
        type: "ActionRequestStateChanged",
        data: { requestId: p["requestId"], state: "DECIDED", decidedBy: p["actor"] },
      });
      return { recordId: p["recordId"] as string, outcome: "approve" };
    },
  });
}

// Retry–continue–reassign chain of a sample work item (PRD Mục 3): each hop is
// its own event on the same stream, history is appended, never merged or
// rewritten; reassignment changes the executor explicitly.
export async function interruptRetryReassign(
  db: Db,
  commandId: string,
  payload: { workItemId: string; firstExecutor: string; secondExecutor: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const workItem = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_work_items WHERE id = ${p["workItemId"]}`,
      );
      if (!workItem || workItem.state !== "ACCEPTED") {
        throw new CommandRejectedError("DEV-010", "Work item is not ACCEPTED");
      }
      const stream = `dopaiosWorkItem-${p["workItemId"]}`;
      const hops: Array<{ state: string; executor?: string }> = [
        { state: "CLAIMED", executor: p["firstExecutor"] as string },
        { state: "IN_PROGRESS" },
        { state: "INTERRUPTED" },
        { state: "IN_PROGRESS" }, // retry: tiếp tục cùng executor, không mất lịch sử
        { state: "INTERRUPTED" },
        { state: "CLAIMED", executor: p["secondExecutor"] as string }, // giao lại
        { state: "IN_PROGRESS" },
        { state: "SUBMITTED" },
      ];
      for (const hop of hops) {
        await ctx.emit({
          streamName: stream,
          type: "WorkItemStateChanged",
          data: { workItemId: p["workItemId"], ...hop },
          metadata: { chain: "retry-continue-reassign" },
        });
      }
      return { workItemId: p["workItemId"] as string, state: "SUBMITTED", hops: hops.length };
    },
  });
}

// Product Baseline pins concrete (id, revision, sha256) triples — never
// "latest" (FS-002). Every pinned item must exist in the artifact ledger with
// exactly that hash and an approved state, checked on the same snapshot.
export async function pinProductBaseline(
  db: Db,
  commandId: string,
  payload: {
    baselineId: string;
    revision: number;
    pinnedBy: string;
    items: Array<{ artifactId: string; revision: number; sha256: string }>;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const items = p["items"] as Array<{ artifactId: string; revision: number; sha256: string }>;
      for (const item of items) {
        const artifact = await one<{ sha256: string; artifact_state: string }>(
          ctx,
          sql`SELECT sha256, artifact_state FROM dopaios_artifacts
              WHERE id = ${item.artifactId} AND revision = ${item.revision}`,
        );
        if (!artifact || artifact.artifact_state !== "approved") {
          throw new CommandRejectedError("ERR-BASELINE-ITEM", `Artifact ${item.artifactId}@${item.revision} is not approved`);
        }
        if (artifact.sha256 !== item.sha256) {
          throw new CommandRejectedError("ERR-BASELINE-HASH", `Artifact ${item.artifactId}@${item.revision} hash mismatch`);
        }
      }
      await ctx.emit({
        streamName: `dopaiosBaseline-${p["baselineId"]}`,
        type: "BaselinePinned",
        data: {
          baselineId: p["baselineId"],
          revision: p["revision"],
          items,
          pinnedBy: p["pinnedBy"],
        },
        expectedVersion: -1,
      });
      return { baselineId: p["baselineId"] as string, itemCount: items.length };
    },
  });
}

// Artifact impact axis (FS-002 trục kép): a source change marks dependents
// impact-pending without touching artifact_state.
export async function markArtifactImpact(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number; impactStatus: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      await ctx.emit({
        streamName: `dopaiosArtifact-${p["artifactId"]}`,
        type: "ArtifactImpactChanged",
        data: { artifactId: p["artifactId"], revision: p["revision"], impactStatus: p["impactStatus"] },
      });
      return { artifactId: p["artifactId"] as string, impactStatus: p["impactStatus"] as string };
    },
  });
}

// fx-02 S10: complete-sop-run once every obligation has a terminal
// disposition (open action requests block completion).
export async function completeSopRun(
  db: Db,
  commandId: string,
  payload: { runId: string },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const open = await one<{ n: string | number }>(
        ctx,
        sql`SELECT count(*)::bigint AS n FROM dopaios_action_requests
            WHERE run_id = ${p["runId"]} AND state NOT IN ('DECIDED', 'CLOSED')`,
      );
      if (Number(open?.n ?? 0) > 0) {
        throw new CommandRejectedError("ERR-OPEN-OBLIGATION", "Run has undecided obligations");
      }
      await ctx.emit({
        streamName: `dopaiosSopRun-${p["runId"]}`,
        type: "SopRunStateChanged",
        data: { runId: p["runId"], state: "COMPLETED" },
      });
      return { runId: p["runId"] as string, state: "COMPLETED" };
    },
  });
}
