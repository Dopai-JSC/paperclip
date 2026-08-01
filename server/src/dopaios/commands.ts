import { sql } from "drizzle-orm";
import {
  type Db,
  type CommandContext,
  type CommandResult,
  executeCommand,
  payloadSha256,
  CommandRejectedError,
} from "./event-store.js";
import { validateQualityContractPin } from "./lifecycle.js";

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
// FS-002 ledger slice. KC-14: optional artifactType passthrough so fixtures
// can bootstrap quality-contract ledger rows (hàng đăng ký bootstrap FS-002).
export async function registerApprovedArtifact(
  db: Db,
  commandId: string,
  payload: { artifactId: string; revision: number; sha256: string; artifactType?: string },
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

// fx-02 S06: run-fixture-execution theo đúng bảng work-item FS-003 (KC-14):
// ready-check máy-kiểm (ACCEPTED → READY — guard là pin Hợp đồng chất lượng
// hợp lệ, dependency máy-kiểm của bước) rồi ba giai đoạn CLAIMED →
// IN_PROGRESS → SUBMITTED trong MỘT transaction (SFR-049 — hai trạng thái
// giữa không bền vững giữa hai lệnh). Phiên bản đầu ra vào trục qua
// DRAFT → SUBMITTED cùng transaction — không đường tắt NONE → SUBMITTED,
// không tồn tại DRAFT bền vững (bảng đầu ra FS-003).
export async function runFixtureExecution(
  db: Db,
  commandId: string,
  payload: {
    workItemId: string;
    executor: string;
    outputId: string;
    outputRevision: number;
    contentSha256: string;
    outputType: string;
    qualityContractRef: { id: string; revision: number; sha256: string };
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
      // Ready-check (hàng ACCEPTED → READY): guard máy-kiểm được của bước —
      // pin Hợp đồng chất lượng hợp lệ trên cùng snapshot (SFR-017).
      await validateQualityContractPin(
        ctx,
        p["qualityContractRef"] as { id: string; revision: number; sha256: string },
        p["outputType"] as string,
      );
      const stream = `dopaiosWorkItem-${p["workItemId"]}`;
      for (const state of ["READY", "CLAIMED", "IN_PROGRESS", "SUBMITTED"]) {
        await ctx.emit({
          streamName: stream,
          type: "WorkItemStateChanged",
          data: { workItemId: p["workItemId"], state, executor: p["executor"] },
        });
      }
      await applyOutputRevisionEntry(ctx, {
        outputId: p["outputId"] as string,
        revision: p["outputRevision"] as number,
        workItemId: p["workItemId"] as string,
        contentSha256: p["contentSha256"] as string,
        qualityContractRef: p["qualityContractRef"] as Json,
      });
      return { workItemId: p["workItemId"] as string, state: "SUBMITTED", outputState: "SUBMITTED" };
    },
  });
}

// ===== KC-14 B4: bản sửa vào trục và side effect thay thế bản cũ =====
// Hàng DRAFT → SUBMITTED của bảng đầu ra FS-003: bản mới KHÔNG kế thừa trạng
// thái/quyết định của bản trước (SFR-030); nếu tồn tại bản trước chưa
// terminal hoặc đã APPROVED/ACCEPTED thì side effect thay thế chạy NGUYÊN TỬ
// trong cùng transaction của lệnh nộp (SFR-031); bản trước REJECTED/
// REWORK_REQUIRED là terminal đã có quyết định — chỉ ghi quan hệ thay thế.
export async function applyOutputRevisionEntry(
  ctx: CommandContext,
  input: {
    outputId: string;
    revision: number;
    workItemId: string;
    contentSha256: string;
    qualityContractRef: Json;
  },
): Promise<{ replacesRevision: number | null }> {
  const prior = await one<{ revision: number; state: string }>(
    ctx,
    sql`SELECT revision, state FROM dopaios_output_versions
        WHERE id = ${input.outputId} ORDER BY revision DESC LIMIT 1`,
  );
  const expected = (prior?.revision ?? 0) + 1;
  if (input.revision !== expected) {
    throw new CommandRejectedError("ERR-REVISION", `Output revision must be ${expected}, got ${input.revision}`);
  }
  const outputStream = `dopaiosOutput-${input.outputId}`;
  await ctx.emit({
    streamName: outputStream,
    type: "OutputVersionRecorded",
    data: {
      outputId: input.outputId,
      revision: input.revision,
      workItemId: input.workItemId,
      state: "DRAFT",
      contentSha256: input.contentSha256,
      qualityContractRef: input.qualityContractRef,
      replacesRevision: prior?.revision ?? null,
    },
    ...(prior ? {} : { expectedVersion: -1 }),
  });
  await ctx.emit({
    streamName: outputStream,
    type: "OutputVersionStateChanged",
    data: { outputId: input.outputId, revision: input.revision, state: "SUBMITTED" },
  });
  if (prior) {
    await invalidatePriorVersion(ctx, input.outputId, prior, `${input.outputId}@${input.revision}`);
  }
  return { replacesRevision: prior?.revision ?? null };
}

// Hai hàng bản-cũ của bảng đầu ra (SFR-031) + tái chặn bước (SFR-050):
//  - AWAITING_DECISION → REWORK_REQUIRED (terminal); gói đang chờ hết hiệu
//    lực; mọi Yêu cầu liên kết đang mở kết thúc SUPERSEDED-TARGET-CHANGED;
//  - APPROVED | ACCEPTED → GIỮ NGUYÊN (lịch sử không viết lại); Approval
//    Record hết hiệu lực trong đúng impact set, bước đã mở theo record đó bị
//    tái chặn; gói EXCEPTION đang chờ trên bản cũ (nếu có) hết hiệu lực.
async function invalidatePriorVersion(
  ctx: CommandContext,
  outputId: string,
  prior: { revision: number; state: string },
  sourceEvent: string,
): Promise<void> {
  if (prior.state === "AWAITING_DECISION") {
    await ctx.emit({
      streamName: `dopaiosOutput-${outputId}`,
      type: "OutputVersionStateChanged",
      data: { outputId, revision: prior.revision, state: "REWORK_REQUIRED" },
    });
    await invalidateOpenPackagesAndRequests(ctx, outputId, prior.revision, sourceEvent);
    return;
  }
  if (prior.state === "APPROVED" || prior.state === "ACCEPTED") {
    const records = (await ctx.tx.execute(sql`
      SELECT id FROM dopaios_approval_records
      WHERE target_id = ${outputId} AND target_revision = ${prior.revision}
        AND outcome IN ('approve', 'approve-with-conditions')
        AND invalidated_at IS NULL
      ORDER BY id
    `)) as unknown as Array<{ id: string }>;
    for (const record of records) {
      await ctx.emit({
        streamName: `dopaiosApprovalRecord-${record.id}`,
        type: "ApprovalInvalidated",
        data: { recordId: record.id, reason: `target-changed: ${sourceEvent} vào trục (SFR-031)` },
      });
      const steps = (await ctx.tx.execute(sql`
        SELECT run_id, step_id FROM dopaios_run_steps
        WHERE opened_by_record_id = ${record.id} AND state = 'open'
        ORDER BY run_id, step_id
      `)) as unknown as Array<{ run_id: string; step_id: string }>;
      for (const step of steps) {
        await ctx.emit({
          streamName: `dopaiosRunStep-${step.run_id}-${step.step_id}`,
          type: "RunStepReblocked",
          data: { runId: step.run_id, stepId: step.step_id },
        });
      }
    }
    await invalidateOpenPackagesAndRequests(ctx, outputId, prior.revision, sourceEvent);
    return;
  }
  // REJECTED / REWORK_REQUIRED: terminal đã có quyết định — không side effect
  // vô hiệu (SFR-045); các trạng thái chưa quyết định khác không hợp lệ cho
  // đường bản sửa và bị guard của lệnh nộp chặn trước khi tới đây.
}

async function invalidateOpenPackagesAndRequests(
  ctx: CommandContext,
  outputId: string,
  revision: number,
  sourceEvent: string,
): Promise<void> {
  const packages = (await ctx.tx.execute(sql`
    SELECT id, revision FROM dopaios_decision_packages
    WHERE state IN ('OPEN', 'AWAITING_INFO')
      AND target->>'outputId' = ${outputId}
      AND (target->>'revision')::int = ${revision}
    ORDER BY id, revision
  `)) as unknown as Array<{ id: string; revision: number }>;
  for (const pkg of packages) {
    await ctx.emit({
      streamName: `dopaiosDecisionPackage-${pkg.id}`,
      type: "DecisionPackageRevisionStateChanged",
      data: { packageId: pkg.id, revision: pkg.revision, state: "INVALIDATED-TARGET-CHANGED" },
    });
    const requests = (await ctx.tx.execute(sql`
      SELECT id FROM dopaios_action_requests
      WHERE package_id = ${pkg.id} AND package_revision = ${pkg.revision}
        AND state IN ('OPEN', 'ROUTED', 'ACKNOWLEDGED', 'EXPIRED')
      ORDER BY id
    `)) as unknown as Array<{ id: string }>;
    for (const request of requests) {
      await ctx.emit({
        streamName: `dopaiosActionRequest-${request.id}`,
        type: "ActionRequestInvalidated",
        data: {
          requestId: request.id,
          invalidation: { reason: "target-changed", sourceEvent },
        },
      });
    }
  }
}

// Hàng SUBMITTED → SELF_CHECK: validate-self-check (runtime tự động). Guard:
// run test đang RUNNING (SFR-057); bằng chứng self-check đúng hash đã pin
// trong gói fixture và đúng target. Sai bằng chứng: TỪ CHỐI, giữ SUBMITTED —
// lệnh nộp trước đó không bị ảnh hưởng (transaction riêng).
export async function validateSelfCheck(
  db: Db,
  commandId: string,
  payload: {
    outputId: string;
    outputRevision: number;
    evidence: { ref: string; sha256: string; targetSha256: string; by: string };
    expectedSha256: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const output = await one<{ state: string; content_sha256: string; work_item_id: string }>(
        ctx,
        sql`SELECT state, content_sha256, work_item_id FROM dopaios_output_versions
            WHERE id = ${p["outputId"]} AND revision = ${p["outputRevision"]}`,
      );
      if (!output) {
        throw new CommandRejectedError("ERR-TARGET", "Output version not found");
      }
      await requireRunningRunOfWorkItem(ctx, output.work_item_id);
      if (output.state !== "SUBMITTED") {
        throw new CommandRejectedError("ERR-STATE", `validate-self-check requires SUBMITTED, got ${output.state}`);
      }
      const evidence = p["evidence"] as { ref: string; sha256: string; targetSha256: string; by: string };
      if (!evidence?.ref || !evidence?.sha256 || !evidence?.targetSha256 || !evidence?.by) {
        throw new CommandRejectedError("ERR-002", "Self-check evidence is missing required fields");
      }
      if (evidence.sha256 !== (p["expectedSha256"] as string)) {
        throw new CommandRejectedError("SFR-020", "Self-check evidence does not match the pinned hash");
      }
      if (evidence.targetSha256 !== output.content_sha256) {
        throw new CommandRejectedError("SFR-020", "Self-check evidence does not target this output content");
      }
      const outputStream = `dopaiosOutput-${p["outputId"]}`;
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionCheckEvidenceAdded",
        data: {
          outputId: p["outputId"],
          revision: p["outputRevision"],
          checkKey: "self-check",
          evidence,
        },
      });
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["outputRevision"], state: "SELF_CHECK" },
      });
      return { outputId: p["outputId"] as string, state: "SELF_CHECK" };
    },
  });
}

// Guard chung SFR-057: mọi lệnh/sự kiện trên record thuộc run terminal bị từ
// chối kèm audit — đọc run của work-item trên cùng snapshot.
export async function requireRunningRunOfWorkItem(ctx: CommandContext, workItemId: string): Promise<string> {
  const row = await one<{ run_id: string | null; run_state: string | null }>(
    ctx,
    sql`SELECT w.run_id, r.state AS run_state
        FROM dopaios_work_items w
        LEFT JOIN dopaios_sop_runs r ON r.id = w.run_id
        WHERE w.id = ${workItemId}`,
  );
  if (!row || !row.run_id) {
    throw new CommandRejectedError("ERR-TARGET", "Work item has no run — slice commands require a test run");
  }
  if (row.run_state !== "RUNNING") {
    throw new CommandRejectedError("SFR-057", `Run ${row.run_id} is ${row.run_state} — command refused`);
  }
  return row.run_id;
}

// Đủ-bằng-chứng (runtime tự động, dùng chung): khi MỌI kiểm bắt buộc theo
// Hợp đồng chất lượng ĐƯỢC PIN có bằng chứng hợp lệ — work-item UNDER_REVIEW
// → COMPLETED trước, rồi side effect chuyển phiên bản INDEPENDENT_CHECK →
// CHECK_PASSED qua đúng hàng bảng đầu ra (SFR-044). Thiếu kiểm: giữ nguyên,
// lý do ghi trong kết quả lệnh bền vững (dopaios_commands).
export async function maybePassChecks(
  ctx: CommandContext,
  input: { outputId: string; outputRevision: number },
): Promise<{ passed: boolean; missing: string[] }> {
  const output = await one<{
    state: string;
    work_item_id: string;
    quality_contract_ref: { id: string; revision: number; sha256: string } | null;
    check_evidence: Record<string, unknown> | null;
  }>(
    ctx,
    sql`SELECT state, work_item_id, quality_contract_ref, check_evidence
        FROM dopaios_output_versions
        WHERE id = ${input.outputId} AND revision = ${input.outputRevision}`,
  );
  if (!output || output.state !== "INDEPENDENT_CHECK") {
    return { passed: false, missing: ["output not in INDEPENDENT_CHECK"] };
  }
  if (!output.quality_contract_ref) {
    return { passed: false, missing: ["no quality contract pinned"] };
  }
  const contract = await one<{ required_checks: string[] }>(
    ctx,
    sql`SELECT required_checks FROM dopaios_quality_contracts
        WHERE id = ${output.quality_contract_ref.id}
          AND revision = ${output.quality_contract_ref.revision}`,
  );
  if (!contract) {
    return { passed: false, missing: ["pinned quality contract content missing"] };
  }
  const evidence = output.check_evidence ?? {};
  const missing = contract.required_checks.filter((check) => evidence[check] === undefined);
  if (missing.length > 0) {
    return { passed: false, missing };
  }
  const workItem = await one<{ state: string }>(
    ctx,
    sql`SELECT state FROM dopaios_work_items WHERE id = ${output.work_item_id}`,
  );
  if (workItem && workItem.state === "UNDER_REVIEW") {
    await ctx.emit({
      streamName: `dopaiosWorkItem-${output.work_item_id}`,
      type: "WorkItemStateChanged",
      data: { workItemId: output.work_item_id, state: "COMPLETED" },
    });
  }
  await ctx.emit({
    streamName: `dopaiosOutput-${input.outputId}`,
    type: "OutputVersionStateChanged",
    data: { outputId: input.outputId, revision: input.outputRevision, state: "CHECK_PASSED" },
  });
  return { passed: true, missing: [] };
}

// fx-02 S07: run-fixture-review — nhận review độc lập theo đúng hai bảng:
// work-item SUBMITTED → UNDER_REVIEW (gắn Review Evidence, DEV-011), phiên
// bản SELF_CHECK → INDEPENDENT_CHECK (validate-independent-check), rồi nếu
// mọi kiểm bắt buộc theo Hợp đồng chất lượng đã có bằng chứng: COMPLETED +
// CHECK_PASSED (SFR-044). Reviewer khác executor (SFR-019); Review Evidence
// kết luận not-ready hoặc thiếu trường bị TỪ CHỐI TẠI CỬA (SFR-020).
export async function reviewFixtureExecution(
  db: Db,
  commandId: string,
  payload: {
    workItemId: string;
    outputId: string;
    outputRevision: number;
    executor: string;
    reviewer: string;
    reviewEvidence: { ref: string; sha256: string; targetSha256: string; conclusion: string };
    expectedReviewSha256: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      if (p["reviewer"] === p["executor"]) {
        throw new CommandRejectedError("SFR-019", "Reviewer must differ from executor");
      }
      await requireRunningRunOfWorkItem(ctx, p["workItemId"] as string);
      const workItem = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_work_items WHERE id = ${p["workItemId"]}`,
      );
      if (!workItem || workItem.state !== "SUBMITTED") {
        throw new CommandRejectedError("ERR-STATE", "run-fixture-review requires work item SUBMITTED");
      }
      const output = await one<{ state: string; content_sha256: string }>(
        ctx,
        sql`SELECT state, content_sha256 FROM dopaios_output_versions
            WHERE id = ${p["outputId"]} AND revision = ${p["outputRevision"]}`,
      );
      if (!output) {
        throw new CommandRejectedError("ERR-TARGET", "Output version not found");
      }
      if (output.state !== "SELF_CHECK") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `validate-independent-check requires SELF_CHECK, got ${output.state}`,
        );
      }
      const evidence = p["reviewEvidence"] as {
        ref: string;
        sha256: string;
        targetSha256: string;
        conclusion: string;
      };
      if (!evidence?.ref || !evidence?.sha256 || !evidence?.targetSha256 || !evidence?.conclusion) {
        throw new CommandRejectedError("SFR-020", "Review Evidence is missing required fields");
      }
      if (evidence.conclusion !== "ready") {
        throw new CommandRejectedError("SFR-020", "Review Evidence with a not-ready conclusion is refused at the door");
      }
      if (evidence.sha256 !== (p["expectedReviewSha256"] as string)) {
        throw new CommandRejectedError("SFR-020", "Review Evidence does not match the pinned hash");
      }
      if (evidence.targetSha256 !== output.content_sha256) {
        throw new CommandRejectedError("SFR-020", "Review Evidence does not target this output content");
      }
      const workItemStream = `dopaiosWorkItem-${p["workItemId"]}`;
      const outputStream = `dopaiosOutput-${p["outputId"]}`;
      await ctx.emit({
        streamName: workItemStream,
        type: "WorkItemStateChanged",
        data: { workItemId: p["workItemId"], state: "UNDER_REVIEW" },
      });
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionCheckEvidenceAdded",
        data: {
          outputId: p["outputId"],
          revision: p["outputRevision"],
          checkKey: "independent-review",
          evidence: { ...evidence, by: p["reviewer"] },
        },
      });
      await ctx.emit({
        streamName: outputStream,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["outputRevision"], state: "INDEPENDENT_CHECK" },
      });
      const checks = await maybePassChecks(ctx, {
        outputId: p["outputId"] as string,
        outputRevision: p["outputRevision"] as number,
      });
      return {
        workItemId: p["workItemId"] as string,
        state: checks.passed ? "COMPLETED" : "UNDER_REVIEW",
        outputState: checks.passed ? "CHECK_PASSED" : "INDEPENDENT_CHECK",
        missingChecks: checks.missing,
      };
    },
  });
}

// Gắn bằng chứng cho một loại kiểm bắt buộc KHÁC ngoài self-check/review độc
// lập (Hợp đồng chất lượng có thể đòi thêm, vd build-log). Khi bằng chứng đủ
// bộ, chính lệnh này kích hoạt COMPLETED + CHECK_PASSED (runtime tự động).
export async function attachCheckEvidence(
  db: Db,
  commandId: string,
  payload: {
    outputId: string;
    outputRevision: number;
    checkKey: string;
    evidence: { ref: string; sha256: string; targetSha256: string; by: string };
    expectedSha256: string;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const output = await one<{
        state: string;
        content_sha256: string;
        work_item_id: string;
        quality_contract_ref: { id: string; revision: number; sha256: string } | null;
      }>(
        ctx,
        sql`SELECT state, content_sha256, work_item_id, quality_contract_ref
            FROM dopaios_output_versions
            WHERE id = ${p["outputId"]} AND revision = ${p["outputRevision"]}`,
      );
      if (!output) {
        throw new CommandRejectedError("ERR-TARGET", "Output version not found");
      }
      await requireRunningRunOfWorkItem(ctx, output.work_item_id);
      if (output.state !== "SELF_CHECK" && output.state !== "INDEPENDENT_CHECK") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `attach-check-evidence applies between SELF_CHECK and CHECK_PASSED, got ${output.state}`,
        );
      }
      if (!output.quality_contract_ref) {
        throw new CommandRejectedError("ERR-QC", "Output version pins no quality contract");
      }
      const contract = await one<{ required_checks: string[] }>(
        ctx,
        sql`SELECT required_checks FROM dopaios_quality_contracts
            WHERE id = ${output.quality_contract_ref.id}
              AND revision = ${output.quality_contract_ref.revision}`,
      );
      if (!contract || !contract.required_checks.includes(p["checkKey"] as string)) {
        throw new CommandRejectedError(
          "ERR-QC",
          `Check ${p["checkKey"]} is not required by the pinned quality contract`,
        );
      }
      const evidence = p["evidence"] as { ref: string; sha256: string; targetSha256: string; by: string };
      if (!evidence?.ref || !evidence?.sha256 || !evidence?.targetSha256 || !evidence?.by) {
        throw new CommandRejectedError("ERR-002", "Check evidence is missing required fields");
      }
      if (evidence.sha256 !== (p["expectedSha256"] as string)) {
        throw new CommandRejectedError("SFR-020", "Check evidence does not match the pinned hash");
      }
      if (evidence.targetSha256 !== output.content_sha256) {
        throw new CommandRejectedError("SFR-020", "Check evidence does not target this output content");
      }
      await ctx.emit({
        streamName: `dopaiosOutput-${p["outputId"]}`,
        type: "OutputVersionCheckEvidenceAdded",
        data: {
          outputId: p["outputId"],
          revision: p["outputRevision"],
          checkKey: p["checkKey"],
          evidence,
        },
      });
      const checks =
        output.state === "INDEPENDENT_CHECK"
          ? await maybePassChecks(ctx, {
              outputId: p["outputId"] as string,
              outputRevision: p["outputRevision"] as number,
            })
          : { passed: false, missing: ["awaiting independent check"] };
      return {
        outputId: p["outputId"] as string,
        checkKey: p["checkKey"] as string,
        outputState: checks.passed ? "CHECK_PASSED" : output.state,
        missingChecks: checks.missing,
      };
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
      // KC-14 (SFR-057): run terminal không nhận thêm lệnh trình điểm.
      const runRow = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_sop_runs WHERE id = ${p["runId"]}`,
      );
      if (!runRow || runRow.state !== "RUNNING") {
        throw new CommandRejectedError("SFR-057", `Run ${p["runId"]} is not RUNNING — command refused`);
      }
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
      // KC-14 B4: gói revision > 1 là "gói mới" của cùng điểm phê duyệt
      // (SFR-053 sau vòng sửa) — revision trước phải tồn tại và đã kết thúc;
      // gói đang mở thì phải đi đường vô hiệu SFR-031, không chồng gói.
      const packageRevision = p["packageRevision"] as number;
      if (packageRevision > 1) {
        const prior = await one<{ state: string }>(
          ctx,
          sql`SELECT state FROM dopaios_decision_packages
              WHERE id = ${p["packageId"]} AND revision = ${packageRevision - 1}`,
        );
        if (!prior) {
          throw new CommandRejectedError("SFR-047", `Package revision ${packageRevision - 1} does not exist`);
        }
        if (prior.state === "OPEN" || prior.state === "AWAITING_INFO") {
          throw new CommandRejectedError("SFR-047", "Prior package revision is still open — invalidate or decide it first");
        }
      }
      await ctx.emit({
        streamName: `dopaiosOutput-${p["outputId"]}`,
        type: "OutputVersionStateChanged",
        data: { outputId: p["outputId"], revision: p["outputRevision"], state: "AWAITING_DECISION" },
      });
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageAssembled",
        data: {
          packageId: p["packageId"],
          revision: packageRevision,
          refs: p["refs"],
          // KC-14: gói đường run pin target phiên bản để vô hiệu theo
          // target đổi tra được (SFR-031).
          target: { outputId: p["outputId"], revision: p["outputRevision"] },
        },
        ...(packageRevision === 1 ? { expectedVersion: -1 } : {}),
      });
      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["requestId"]}`,
        type: "ActionRequestCreated",
        data: {
          requestId: p["requestId"],
          kind: "decision",
          runId: p["runId"],
          packageId: p["packageId"],
          packageRevision,
        },
        expectedVersion: -1,
      });
      return { packageId: p["packageId"] as string, requestState: "OPEN" };
    },
  });
}

// fx-02 S09: acknowledge + record approval — KC-14 mở đủ BỐN outcome của
// điểm phê duyệt trên trục Phiên bản đầu ra (bảng FS-003 d.1599-1603):
//  - approve            → APPROVED; mở đúng bước khai (SFR-029, RunStepOpened);
//  - approve-with-conditions → ACCEPTED + condition theo dõi được (SFR-033),
//    condition blocks_next_step chặn quyết định (SFR-022); mở bước như approve;
//  - reject             → REJECTED terminal, KHÔNG mở bước; đường tiếp là bản
//    sửa (submit-fixture-revision) hoặc hủy run (SFR-045/051);
//  - reject kèm reEntryPoint (kết quả nghiệp vụ "yêu cầu sửa") → REJECTED +
//    tạo work-item rework liên kết bản trước, PROPOSED → ACCEPTED máy-kiểm
//    cùng transaction (SFR-022/017);
//  - request-more-information → output GIỮ AWAITING_DECISION; record RMI ghi
//    phần cần bổ sung + điểm quay lại; đúng một Yêu cầu clarification định
//    tuyến Pod-của-run (SFR-046); không mở bước nào.
// Mọi outcome: transaction nguyên tử trên cả hai trục; record pin target
// ID@revision@hash của phiên bản để hiệu lực tra được về sau (SFR-030/031).
export type RunApprovalCondition = {
  conditionId: string;
  scope: Json;
  risk: string;
  owner: string;
  deadline: string;
  closureCriteria: string;
  blocksNextStep: boolean;
};

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
    outcome?: "approve" | "approve-with-conditions" | "reject" | "request-more-information";
    conditions?: RunApprovalCondition[];
    reEntryPoint?: string;
    reworkWorkItemId?: string;
    requiredInfo?: string;
    clarificationRequestId?: string;
    openedStep?: string;
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
      const request = await one<{ run_id: string; state: string }>(
        ctx,
        sql`SELECT run_id, state FROM dopaios_action_requests WHERE id = ${p["requestId"]}`,
      );
      if (!request) {
        throw new CommandRejectedError("ERR-REQUEST", "Action request not found");
      }
      // KC-14: yêu cầu đã kết thúc (DECIDED hoặc vô hiệu do target đổi)
      // không nhận quyết định nữa (SFR-031/048).
      if (request.state === "DECIDED" || request.state === "SUPERSEDED-TARGET-CHANGED") {
        throw new CommandRejectedError("SFR-048", `Action request is ${request.state} — no further decision`);
      }
      const run = await one<{ decider: string; state: string }>(
        ctx,
        sql`SELECT decider, state FROM dopaios_sop_runs WHERE id = ${request.run_id}`,
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
      // KC-14 (SFR-057 + hàng record-approval): guard thẩm quyền đứng trước
      // (thứ tự KC-13 B7 cố định), rồi mới tới trạng thái run — run không
      // RUNNING từ chối mọi quyết định trên record thuộc run.
      if (run.state !== "RUNNING") {
        throw new CommandRejectedError("SFR-057", `Run ${request.run_id} is ${run.state} — command refused`);
      }
      const pkg = await one<{ refs: Json; state: string }>(
        ctx,
        sql`SELECT refs, state FROM dopaios_decision_packages
            WHERE id = ${p["packageId"]} AND revision = ${p["packageRevision"]}`,
      );
      if (!pkg) {
        throw new CommandRejectedError("ERR-PKG", "Decision package not found");
      }
      // SFR-031/047: chỉ gói revision hiện hành còn hiệu lực nhận quyết định.
      if (pkg.state !== "OPEN") {
        throw new CommandRejectedError("SFR-047", `Decision package is ${pkg.state} — decisions apply to the open revision only`);
      }
      if (payloadSha256(pkg.refs) !== payloadSha256(p["pinnedRefs"])) {
        throw new CommandRejectedError(
          "SFR-028",
          "Approval refs are not byte-equivalent to the decision package",
        );
      }
      const output = await one<{ state: string; content_sha256: string; work_item_id: string }>(
        ctx,
        sql`SELECT state, content_sha256, work_item_id FROM dopaios_output_versions
            WHERE id = ${p["outputId"]} AND revision = ${p["outputRevision"]}`,
      );
      if (!output) {
        throw new CommandRejectedError("ERR-TARGET", "Output version not found");
      }
      // from_state của mọi hàng quyết định là AWAITING_DECISION — trạng thái
      // quyết định của một revision là bất biến sau khi ghi (không đường lùi).
      if (output.state !== "AWAITING_DECISION") {
        throw new CommandRejectedError(
          "ERR-STATE",
          `Decision applies to AWAITING_DECISION only, got ${output.state}`,
        );
      }

      const outcome = (p["outcome"] as string | undefined) ?? "approve";
      const conditions = (p["conditions"] as RunApprovalCondition[] | undefined) ?? [];
      if (!["approve", "approve-with-conditions", "reject", "request-more-information"].includes(outcome)) {
        throw new CommandRejectedError("ERR-002", `Unknown outcome: ${outcome}`);
      }
      if (outcome === "approve" && conditions.length > 0) {
        throw new CommandRejectedError("ERR-002", "Conditions are only valid with approve-with-conditions");
      }
      if (outcome === "approve-with-conditions") {
        if (conditions.length === 0) {
          throw new CommandRejectedError("ERR-002", "Approve-with-conditions requires at least one condition");
        }
        for (const condition of conditions) {
          for (const field of [
            "conditionId",
            "scope",
            "risk",
            "owner",
            "deadline",
            "closureCriteria",
            "blocksNextStep",
          ]) {
            if ((condition as unknown as Json)[field] === undefined) {
              throw new CommandRejectedError("SFR-033", `Condition is missing required field ${field}`);
            }
          }
          if (condition.blocksNextStep === true) {
            throw new CommandRejectedError("SFR-022", "A condition with blocks_next_step: true blocks the decision");
          }
        }
      }
      if (outcome === "request-more-information" && !p["requiredInfo"]) {
        throw new CommandRejectedError("SFR-046", "request-more-information must state the missing part");
      }
      if (outcome === "request-more-information" && !p["clarificationRequestId"]) {
        throw new CommandRejectedError("SFR-046", "request-more-information requires the clarification request id");
      }
      const reworkRequested = outcome === "reject" && Boolean(p["reEntryPoint"]);
      if (reworkRequested && !p["reworkWorkItemId"]) {
        throw new CommandRejectedError("SFR-022", "Re-entry requires the rework work-item id");
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
          outcome,
          pinnedRefs: p["pinnedRefs"],
          actor: p["actor"],
          // Pin target ID@revision@hash của phiên bản (SFR-030) — hiệu lực
          // của approval tra được và vô hiệu được về sau (SFR-031/034).
          targetId: p["outputId"],
          targetRevision: p["outputRevision"],
          targetSha256: output.content_sha256,
          reEntryPoint: p["reEntryPoint"] ?? null,
          openedStep: outcome === "approve" || outcome === "approve-with-conditions" ? (p["openedStep"] ?? null) : null,
          findings:
            outcome === "reject"
              ? [{ firstArtifactToFix: { outputId: p["outputId"], revision: p["outputRevision"] } }]
              : outcome === "request-more-information"
                ? [{ requiredInfo: p["requiredInfo"], returnPoint: "AWAITING_DECISION" }]
                : null,
        },
        expectedVersion: -1,
      });
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageRevisionStateChanged",
        data: {
          packageId: p["packageId"],
          revision: p["packageRevision"],
          state: outcome === "request-more-information" ? "AWAITING_INFO" : "DECIDED",
        },
      });

      if (outcome === "approve" || outcome === "approve-with-conditions") {
        await ctx.emit({
          streamName: `dopaiosOutput-${p["outputId"]}`,
          type: "OutputVersionStateChanged",
          data: {
            outputId: p["outputId"],
            revision: p["outputRevision"],
            state: outcome === "approve" ? "APPROVED" : "ACCEPTED",
          },
        });
        for (const condition of conditions) {
          await ctx.emit({
            streamName: `dopaiosCondition-${condition.conditionId}`,
            type: "ConditionOpened",
            data: {
              conditionId: condition.conditionId,
              recordId: p["recordId"],
              scope: condition.scope,
              risk: condition.risk,
              owner: condition.owner,
              deadline: condition.deadline,
              closureCriteria: condition.closureCriteria,
              compensatingObligation: null,
              blocksNextStep: condition.blocksNextStep,
            },
            expectedVersion: -1,
          });
        }
        // SFR-029: mở ĐÚNG bước được khai trong định nghĩa điểm kiểm soát,
        // không bước nào khác.
        if (p["openedStep"]) {
          await ctx.emit({
            streamName: `dopaiosRunStep-${request.run_id}-${p["openedStep"]}`,
            type: "RunStepOpened",
            data: { runId: request.run_id, stepId: p["openedStep"], recordId: p["recordId"] },
          });
        }
      } else if (outcome === "reject") {
        await ctx.emit({
          streamName: `dopaiosOutput-${p["outputId"]}`,
          type: "OutputVersionStateChanged",
          data: { outputId: p["outputId"], revision: p["outputRevision"], state: "REJECTED" },
        });
        if (reworkRequested) {
          // SFR-022: work-item rework liên kết work-item và phiên bản trước;
          // acceptance máy-kiểm trong CÙNG transaction (SFR-017) — bước khai
          // trực tiếp trong định nghĩa sinh ra nó.
          const reworkStream = `dopaiosWorkItem-${p["reworkWorkItemId"]}`;
          await ctx.emit({
            streamName: reworkStream,
            type: "WorkItemCreated",
            data: {
              workItemId: p["reworkWorkItemId"],
              runId: request.run_id,
              state: "PROPOSED",
              reworkOfWorkItemId: output.work_item_id,
              reworkOfOutputRef: { outputId: p["outputId"], revision: p["outputRevision"] },
            },
            expectedVersion: -1,
          });
          await ctx.emit({
            streamName: reworkStream,
            type: "WorkItemStateChanged",
            data: { workItemId: p["reworkWorkItemId"], state: "ACCEPTED" },
          });
        }
      } else if (outcome === "request-more-information") {
        // SFR-046: output GIỮ AWAITING_DECISION — không event trạng thái nào
        // trên trục đầu ra; đúng một Yêu cầu bổ sung loại clarification định
        // tuyến Pod-của-run.
        await ctx.emit({
          streamName: `dopaiosActionRequest-${p["clarificationRequestId"]}`,
          type: "ActionRequestCreated",
          data: {
            requestId: p["clarificationRequestId"],
            kind: "clarification",
            runId: request.run_id,
            packageId: p["packageId"],
            packageRevision: p["packageRevision"],
          },
          expectedVersion: -1,
        });
      }

      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["requestId"]}`,
        type: "ActionRequestStateChanged",
        data: { requestId: p["requestId"], state: "DECIDED", decidedBy: p["actor"] },
      });
      return {
        recordId: p["recordId"] as string,
        outcome,
        reworkWorkItemId: reworkRequested ? (p["reworkWorkItemId"] as string) : null,
      };
    },
  });
}

// SFR-047 (nhánh run): câu trả lời của Yêu cầu clarification tạo Gói quyết
// định revision mới supersede gói trước và ĐÚNG MỘT Yêu cầu quyết định mới —
// CHỈ khi gói nguồn còn hiệu lực (AWAITING_INFO của RMI) và target vẫn là
// phiên bản hiện hành; gói đã vô hiệu do target đổi thì không tạo gì.
export async function answerClarification(
  db: Db,
  commandId: string,
  payload: {
    clarificationRequestId: string;
    answer: string;
    answeredBy: string;
    packageId: string;
    newPackageRevision: number;
    refs: Json;
    newDecisionRequestId: string;
    outputId: string;
    outputRevision: number;
  },
): Promise<CommandResult> {
  return executeCommand(db, {
    commandId,
    payload: payload as unknown as Json,
    handler: async (ctx, p) => {
      const clarification = await one<{ state: string; run_id: string }>(
        ctx,
        sql`SELECT state, run_id FROM dopaios_action_requests WHERE id = ${p["clarificationRequestId"]}`,
      );
      if (!clarification || clarification.state === "DECIDED" || clarification.state === "SUPERSEDED-TARGET-CHANGED") {
        throw new CommandRejectedError("SFR-046", "Clarification request is missing or already closed/invalidated");
      }
      const run = await one<{ state: string; pod: string }>(
        ctx,
        sql`SELECT state, pod FROM dopaios_sop_runs WHERE id = ${clarification.run_id}`,
      );
      if (!run || run.state !== "RUNNING") {
        throw new CommandRejectedError("SFR-057", "Run of the clarification is not RUNNING");
      }
      // Pod-của-run là đích định tuyến của clarification (SFR-046) — người
      // trả lời phải đúng Pod.
      if ((p["answeredBy"] as string) !== run.pod) {
        throw new CommandRejectedError("SFR-046", "Clarifications are answered by the run Pod");
      }
      if (!p["answer"]) {
        throw new CommandRejectedError("SFR-052", "Answer must state its content, scope and impacted revisions");
      }
      const priorRevision = (p["newPackageRevision"] as number) - 1;
      const prior = await one<{ state: string; refs: Json }>(
        ctx,
        sql`SELECT state, refs FROM dopaios_decision_packages
            WHERE id = ${p["packageId"]} AND revision = ${priorRevision}`,
      );
      if (!prior) {
        throw new CommandRejectedError("SFR-047", `Package revision ${priorRevision} does not exist`);
      }
      // Gói nguồn phải còn hiệu lực (đang chờ bổ sung) — đã vô hiệu do target
      // đổi thì KHÔNG tạo gói/yêu cầu mới (SFR-047).
      if (prior.state !== "AWAITING_INFO") {
        throw new CommandRejectedError(
          "SFR-047",
          `Package revision ${priorRevision} is ${prior.state} — no new package is assembled`,
        );
      }
      // Yêu cầu mới cùng LOẠI với yêu cầu của gói trước (SFR-047): gói
      // EXCEPTION → exception; gói thường → decision. Target hiện hành của
      // EXCEPTION là phiên bản ACCEPTED, của gói thường là AWAITING_DECISION.
      const isException = (prior.refs as Json)["kind"] === "EXCEPTION";
      const expectedTargetState = isException ? "ACCEPTED" : "AWAITING_DECISION";
      const newRequestKind = isException ? "exception" : "decision";
      const output = await one<{ state: string }>(
        ctx,
        sql`SELECT state FROM dopaios_output_versions
            WHERE id = ${p["outputId"]} AND revision = ${p["outputRevision"]}`,
      );
      if (!output || output.state !== expectedTargetState) {
        throw new CommandRejectedError("SFR-047", "Target is no longer the current version for this package kind");
      }

      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["clarificationRequestId"]}`,
        type: "ActionRequestStateChanged",
        data: { requestId: p["clarificationRequestId"], state: "DECIDED", decidedBy: p["answeredBy"] },
      });
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageRevisionStateChanged",
        data: { packageId: p["packageId"], revision: priorRevision, state: "SUPERSEDED" },
      });
      await ctx.emit({
        streamName: `dopaiosDecisionPackage-${p["packageId"]}`,
        type: "DecisionPackageAssembled",
        data: {
          packageId: p["packageId"],
          revision: p["newPackageRevision"],
          refs: p["refs"],
          target: { outputId: p["outputId"], revision: p["outputRevision"] },
          fields: { answer: p["answer"], answeredBy: p["answeredBy"] },
        },
      });
      await ctx.emit({
        streamName: `dopaiosActionRequest-${p["newDecisionRequestId"]}`,
        type: "ActionRequestCreated",
        data: {
          requestId: p["newDecisionRequestId"],
          kind: newRequestKind,
          runId: clarification.run_id,
          packageId: p["packageId"],
          packageRevision: p["newPackageRevision"],
        },
        expectedVersion: -1,
      });
      return {
        packageId: p["packageId"] as string,
        newPackageRevision: p["newPackageRevision"] as number,
        newDecisionRequestId: p["newDecisionRequestId"] as string,
      };
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
