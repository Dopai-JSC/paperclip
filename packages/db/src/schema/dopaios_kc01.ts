import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  primaryKey,
  customType,
  doublePrecision,
  numeric,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";

const vector4 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(4)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return value
      .slice(1, -1)
      .split(",")
      .map((part) => Number(part));
  },
});

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// KC-01 spike (Dopaios verification batch 1): command log + read projections
// for the seven canonical state types of FS-003 SQR-003. Events are the source
// of truth (message_store.messages, migration 0501); these Drizzle tables are
// rebuildable read projections. Column sets are the minimum the KC-01 contract
// tests need — not the production Dopaios schema.

export const dopaiosCommands = pgTable("dopaios_commands", {
  commandId: text("command_id").primaryKey(),
  payloadSha256: text("payload_sha256").notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dopaiosActors = pgTable("dopaios_actors", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  active: boolean("active").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull(),
});

export const dopaiosProjects = pgTable("dopaios_projects", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  templateRef: jsonb("template_ref").$type<Record<string, unknown>>().notNull(),
  orchestrator: text("orchestrator").notNull(),
  createdBy: text("created_by").notNull(),
});

export const dopaiosArtifacts = pgTable(
  "dopaios_artifacts",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    sha256: text("sha256").notNull(),
    artifactState: text("artifact_state").notNull(),
    impactStatus: text("impact_status").notNull(),
    // KC-03: separation rule FS-002 SFR-013 tách theo định danh Staff đã TẠO
    // revision; policy tra theo LOẠI artifact (SFR-014); AWC theo vùng chỉ
    // trên loại có schema region (SFR-024/025). Nullable vì event KC-01 cũ
    // không mang các trường này.
    createdBy: text("created_by"),
    artifactType: text("artifact_type"),
    hasRegionSchema: boolean("has_region_schema"),
    // KC-04 (0515): provenance FS-002 — source_refs = "Danh sách nguồn" pin
    // ID@revision hoặc hash (d.629 + EDGE-001, không nhận "latest");
    // storage_ref = nơi lưu nội dung (tiêu chí 2 KC-04). Nullable vì event
    // trước KC-04 không mang hai trường này.
    sourceRefs: jsonb("source_refs").$type<Array<Record<string, unknown>>>(),
    storageRef: text("storage_ref"),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

export const dopaiosSopDefinitions = pgTable("dopaios_sop_definitions", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  sopPin: jsonb("sop_pin").$type<Record<string, unknown>>().notNull(),
  contractSuiteEvidence: jsonb("contract_suite_evidence").$type<Record<string, unknown>>(),
});

export const dopaiosSopRuns = pgTable("dopaios_sop_runs", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  state: text("state").notNull(),
  definitionRef: jsonb("definition_ref").$type<Record<string, unknown>>().notNull(),
  decider: text("decider").notNull(),
  pod: text("pod").notNull(),
  completedAt: timestamp("completed_at"),
});

export const dopaiosWorkItems = pgTable("dopaios_work_items", {
  id: text("id").primaryKey(),
  // KC-13 (0510): run_id thả NOT NULL — work-item P0 thuộc Project (project_id)
  // chưa có SOP run; work-item run test KC-01 giữ run_id, không gắn Project.
  runId: text("run_id"),
  state: text("state").notNull(),
  executor: text("executor"),
  projectId: text("project_id"),
  // KC-13 (0511): vai AI của việc + đích định tuyến + căn cứ chọn (FR-42).
  role: text("role"),
  routedTo: text("routed_to"),
  routingBasis: jsonb("routing_basis").$type<Record<string, unknown>>(),
  // KC-14 (0512): biến thể rework của NONE → PROPOSED (FS-003 SFR-022) ghi
  // liên kết work-item và phiên bản đầu ra trước; item terminal không mở lại.
  reworkOfWorkItemId: text("rework_of_work_item_id"),
  reworkOfOutputRef: jsonb("rework_of_output_ref").$type<Record<string, unknown>>(),
});

export const dopaiosOutputVersions = pgTable(
  "dopaios_output_versions",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    workItemId: text("work_item_id").notNull(),
    state: text("state").notNull(),
    contentSha256: text("content_sha256").notNull(),
    // KC-14 (0512): pin Hợp đồng chất lượng lúc nộp (không-"latest"), bằng
    // chứng theo từng loại kiểm, quan hệ thay thế của bản sửa (SFR-030/045).
    qualityContractRef: jsonb("quality_contract_ref").$type<Record<string, unknown>>(),
    checkEvidence: jsonb("check_evidence").$type<Record<string, unknown>>(),
    replacesRevision: integer("replaces_revision"),
    // KC-15 (0514): danh sách pin nguồn ID@revision@sha256 theo FS-002
    // (EDGE-001) — nối phiên bản đầu ra với artifact nguồn trong sổ (QD-4).
    sourceRefs: jsonb("source_refs").$type<Array<Record<string, unknown>>>(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// KC-14 (0512): projection NỘI DUNG của Hợp đồng chất lượng theo (id, revision).
// Hiệu lực KHÔNG nằm ở bảng này — guard đọc sổ artifact FS-002 trong cùng
// transaction: đăng ký loại 'quality-contract', approved, impact ∈ {clear,
// reaffirmed} và đúng sha256 (QD-2 kế hoạch KC-14).
export const dopaiosQualityContracts = pgTable(
  "dopaios_quality_contracts",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    outputType: text("output_type").notNull(),
    requiredChecks: jsonb("required_checks").$type<string[]>().notNull(),
    sha256: text("sha256").notNull(),
    registeredBy: text("registered_by").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// KC-14 (0512): bước của run mở theo approval (SFR-029) và bị tái chặn đúng
// impact set khi approval hết hiệu lực (SFR-050); slice chỉ cần open | reblocked.
export const dopaiosRunSteps = pgTable(
  "dopaios_run_steps",
  {
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    state: text("state").notNull(),
    openedByRecordId: text("opened_by_record_id"),
  },
  (table) => ({ pk: primaryKey({ columns: [table.runId, table.stepId] }) }),
);

// KC-15 (0513): cạnh phụ thuộc work-item — projection từ event
// WorkItemDependencyDeclared (QD-1). work_item_id là bên PHỤ THUỘC (hạ
// nguồn), depends_on_work_item_id là bên được phụ thuộc (thượng nguồn); cạnh
// giới hạn trong một run test (QD-4). MỌI truy vấn traversal đi qua module
// graph-repo (một cửa duy nhất — ADR-019); bảng này không mang trạng thái —
// chặn/impact/hủy đọc từ trạng thái sẵn có của KC-03/KC-14 (QD-2).
export const dopaiosWorkItemDependencies = pgTable(
  "dopaios_work_item_dependencies",
  {
    workItemId: text("work_item_id").notNull(),
    dependsOnWorkItemId: text("depends_on_work_item_id").notNull(),
    runId: text("run_id").notNull(),
    declaredBy: text("declared_by").notNull(),
    basis: jsonb("basis").$type<Record<string, unknown>>(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.workItemId, table.dependsOnWorkItemId] }) }),
);

export const dopaiosActionRequests = pgTable("dopaios_action_requests", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  runId: text("run_id").notNull(),
  decidedBy: text("decided_by"),
  // KC-03: Yêu cầu quyết định/exception gắn vào Gói quyết định (SFR-034/047).
  packageId: text("package_id"),
  packageRevision: integer("package_revision"),
  // KC-14 (0512): kết thúc SUPERSEDED-TARGET-CHANGED (DEV-009) ghi lý do vô
  // hiệu và dấu vết sự kiện làm target đổi.
  invalidation: jsonb("invalidation").$type<Record<string, unknown>>(),
});

// KC-03: gói có revision + supersede (FS-003 SFR-047) — khóa (id, revision);
// target và bộ trường SFR-024 nullable vì event KC-01 cũ không mang chúng.
export const dopaiosDecisionPackages = pgTable(
  "dopaios_decision_packages",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    refs: jsonb("refs").$type<Record<string, unknown>>().notNull(),
    target: jsonb("target").$type<Record<string, unknown>>(),
    fields: jsonb("fields").$type<Record<string, unknown>>(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// KC-02: record Phiên chạy AI theo work-item (PRD Mục 3). Mỗi phiên một
// stream event riêng — lịch sử không bao giờ gộp; phiên mới liên kết
// predecessor qua (predecessorId, relation); phiên terminal không mở lại.
export const dopaiosAiSessions = pgTable("dopaios_ai_sessions", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  agentId: text("agent_id").notNull(),
  engine: text("engine").notNull(),
  state: text("state").notNull(),
  predecessorId: text("predecessor_id"),
  relation: text("relation"),
  lastSignalAt: timestamp("last_signal_at"),
  detectionLatencyMs: integer("detection_latency_ms"),
  outcome: text("outcome"),
  contextPackageId: text("context_package_id"),
  contextPackageRevision: integer("context_package_revision"),
  contextPackageSha256: text("context_package_sha256"),
  // KC-11: tổng usage/chi phí của phiên — projection cộng dồn từ event
  // AiSessionUsageRecorded; budget_state ghi warned/stopped của trần costUsd.
  usageInputTokens: integer("usage_input_tokens").notNull().default(0),
  usageCachedInputTokens: integer("usage_cached_input_tokens").notNull().default(0),
  usageCacheCreationInputTokens: integer("usage_cache_creation_input_tokens").notNull().default(0),
  usageOutputTokens: integer("usage_output_tokens").notNull().default(0),
  usageCostUsdReported: numeric("usage_cost_usd_reported", { precision: 14, scale: 8 }).notNull().default("0"),
  usageCostUsdComputed: numeric("usage_cost_usd_computed", { precision: 14, scale: 8 }).notNull().default("0"),
  budgetState: text("budget_state"),
}, (table) => ({
  contextPackageComplete: check(
    "dopaios_ai_sessions_context_package_complete",
    sql`num_nonnulls(${table.contextPackageId}, ${table.contextPackageRevision}, ${table.contextPackageSha256}) IN (0, 3)`,
  ),
  contextPackageFk: foreignKey({
    name: "dopaios_ai_sessions_context_package_fk",
    columns: [table.contextPackageId, table.contextPackageRevision, table.contextPackageSha256],
    foreignColumns: [dopaiosContextPackages.id, dopaiosContextPackages.revision, dopaiosContextPackages.sha256],
  }),
  contextPackageRefUq: unique("dopaios_ai_sessions_context_package_ref_uniq").on(
    table.id,
    table.contextPackageId,
    table.contextPackageRevision,
    table.contextPackageSha256,
  ),
}));

export const dopaiosSessionArtifacts = pgTable(
  "dopaios_session_artifacts",
  {
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    sha256: text("sha256").notNull(),
    confirmed: boolean("confirmed").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.sessionId, table.seq] }) }),
);

// KC-11: một dòng usage cho mỗi bước engine (một lần gọi CLI/model) của một
// Phiên chạy AI. cost_usd_reported là số CLI/adapter tự báo (null khi đường
// không báo — ví dụ Codex); cost_usd_computed là token × bảng giá LiteLLM đã
// pin (price_source ghi commit nguồn giá).
export const dopaiosSessionUsage = pgTable(
  "dopaios_session_usage",
  {
    sessionId: text("session_id").notNull(),
    seq: integer("seq").notNull(),
    step: text("step").notNull(),
    model: text("model").notNull(),
    billingType: text("billing_type").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsdReported: numeric("cost_usd_reported", { precision: 14, scale: 8 }),
    costUsdComputed: numeric("cost_usd_computed", { precision: 14, scale: 8 }).notNull(),
    priceSource: text("price_source").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.sessionId, table.seq] }) }),
);

// KC-02 B5: entry kích hoạt kiểu KC-13 (claim compare-and-set) và
// circuit-breaker chuỗi lỗi auth (hard-stop trước khi gọi engine).
export const dopaiosActivations = pgTable("dopaios_activations", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  agentId: text("agent_id").notNull(),
  engine: text("engine").notNull(),
  state: text("state").notNull(),
  claimedBy: text("claimed_by"),
  outcome: text("outcome"),
  // KC-13: lease TTL — claim bền vững giữa các lệnh nên claimer chết phải thu
  // hồi được; epoch tăng mỗi lần requeue để chặn claimer cũ ghi muộn.
  claimLeaseUntil: timestamp("claim_lease_until"),
  leaseEpoch: integer("lease_epoch").notNull().default(0),
  contractId: text("contract_id"),
  contractRevision: integer("contract_revision"),
  contextPackageId: text("context_package_id"),
  contextPackageRevision: integer("context_package_revision"),
  contextPackageSha256: text("context_package_sha256"),
}, (table) => ({
  contextPackageComplete: check(
    "dopaios_activations_context_package_complete",
    sql`num_nonnulls(${table.contextPackageId}, ${table.contextPackageRevision}, ${table.contextPackageSha256}) IN (0, 3)`,
  ),
  contextPackageFk: foreignKey({
    name: "dopaios_activations_context_package_fk",
    columns: [table.contextPackageId, table.contextPackageRevision, table.contextPackageSha256],
    foreignColumns: [dopaiosContextPackages.id, dopaiosContextPackages.revision, dopaiosContextPackages.sha256],
  }),
}));

export const dopaiosAuthBreakers = pgTable("dopaios_auth_breakers", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  consecutiveFailures: integer("consecutive_failures").notNull(),
});

export const dopaiosProductBaselines = pgTable(
  "dopaios_product_baselines",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    state: text("state").notNull(),
    items: jsonb("items").$type<Array<Record<string, unknown>>>().notNull(),
    pinnedBy: text("pinned_by").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// KC-03: đủ bộ trường hợp đồng record-approval (FS-002 bảng d.651-661 +
// FS-003 SFR-028) — actor của lệnh CHÍNH LÀ người duyệt, không có trường
// "người duyệt" tách rời (chống mạo danh). Các cột mới nullable vì event
// ApprovalRecorded của KC-01 không mang chúng.
// KC-14 (0512): approval trên trục đầu ra có thể HẾT HIỆU LỰC (SFR-031/034)
// mà không viết lại lifecycle của phiên bản — invalidated_at/invalidation_reason.
export const dopaiosApprovalRecords = pgTable("dopaios_approval_records", {
  id: text("id").primaryKey(),
  packageId: text("package_id").notNull(),
  packageRevision: integer("package_revision").notNull(),
  outcome: text("outcome").notNull(),
  pinnedRefs: jsonb("pinned_refs").$type<Record<string, unknown>>().notNull(),
  actor: text("actor").notNull(),
  targetId: text("target_id"),
  targetRevision: integer("target_revision"),
  targetSha256: text("target_sha256"),
  approvedScope: jsonb("approved_scope").$type<Record<string, unknown>>(),
  findings: jsonb("findings").$type<Array<Record<string, unknown>>>(),
  nonWaivableBlockers: jsonb("non_waivable_blockers").$type<Array<Record<string, unknown>>>(),
  impactSet: jsonb("impact_set").$type<Array<Record<string, unknown>>>(),
  downstreamChecked: jsonb("downstream_checked").$type<Array<Record<string, unknown>>>(),
  openedStep: text("opened_step"),
  reEntryPoint: text("re_entry_point"),
  expiry: jsonb("expiry").$type<Record<string, unknown>>(),
  requestedBy: text("requested_by"),
  invalidatedAt: timestamp("invalidated_at"),
  invalidationReason: text("invalidation_reason"),
});

// ===== KC-03: approval engine =====

// Separation policy (FS-002 SFR-013/014): policy lưu jsonb THÔ — guard kiểm
// đủ trường tại thời điểm phê duyệt, cho phép fixture pin policy thiếu trường
// để chứng minh fail-closed chặn mọi lệnh của loại đó.
export const dopaiosSeparationPolicies = pgTable("dopaios_separation_policies", {
  id: text("id").primaryKey(),
  artifactType: text("artifact_type").notNull(),
  revision: integer("revision").notNull(),
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
  pinnedBy: text("pinned_by").notNull(),
});

// Condition của approve-with-conditions (FS-002 SFR-015/033, FS-003 SFR-055):
// đủ trường bắt buộc của SFR-033; state: open | closed | overdue.
export const dopaiosConditions = pgTable("dopaios_conditions", {
  id: text("id").primaryKey(),
  recordId: text("record_id").notNull(),
  scope: jsonb("scope").$type<Record<string, unknown>>().notNull(),
  risk: text("risk").notNull(),
  owner: text("owner").notNull(),
  deadline: timestamp("deadline").notNull(),
  closureCriteria: text("closure_criteria").notNull(),
  compensatingObligation: text("compensating_obligation"),
  blocksNextStep: boolean("blocks_next_step").notNull(),
  state: text("state").notNull(),
  closedBy: text("closed_by"),
  closedAt: timestamp("closed_at"),
  closureEvidence: text("closure_evidence"),
});

// Impact record (FS-002 SFR-029): mỗi sự kiện impact một record mở riêng;
// artifact chỉ rời impact-pending khi MỌI record mở đã có disposition.
export const dopaiosImpactRecords = pgTable("dopaios_impact_records", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  artifactRevision: integer("artifact_revision").notNull(),
  source: text("source").notNull(),
  sourceRef: text("source_ref"),
  state: text("state").notNull(),
  conclusion: text("conclusion"),
  dispositionedBy: text("dispositioned_by"),
  basis: text("basis"),
});

// Gate Record (FS-003 SFR-035): CHỈ tồn tại cho Cổng A/B/C — guard nằm ở
// tầng lệnh, bảng chỉ là projection.
export const dopaiosGateRecords = pgTable("dopaios_gate_records", {
  id: text("id").primaryKey(),
  gateName: text("gate_name").notNull(),
  pointId: text("point_id").notNull(),
  runId: text("run_id"),
  approvalRecordId: text("approval_record_id").notNull(),
});

// ===== KC-13: định tuyến + kích hoạt =====

// Staff AI (PRD FR-69/FR-42): FS-001 chỉ định nghĩa Staff người, Staff AI
// thuộc FS-004 chưa viết — spike dựng theo PRD. model_version giữ cửa cho
// trust theo vai × model-version (FR-42).
export const dopaiosStaffAi = pgTable("dopaios_staff_ai", {
  id: text("id").primaryKey(),
  workStatus: text("work_status").notNull(),
  capabilities: jsonb("capabilities").$type<string[]>().notNull(),
  skills: jsonb("skills").$type<string[]>().notNull(),
  permissions: jsonb("permissions").$type<string[]>().notNull(),
  resources: jsonb("resources").$type<string[]>().notNull(),
  autonomyLimits: jsonb("autonomy_limits").$type<Record<string, unknown>>(),
  modelVersion: text("model_version"),
  capacityLimit: integer("capacity_limit").notNull(),
  profileRevision: integer("profile_revision").notNull(),
});

// Pool khởi động có phiên bản (PRD FR-69/AC-FR-69.1): đủ năm vai AI chính/dự
// phòng. Pool TỰ NÓ không có quyền chạy Project — quyền chỉ sinh khi được pin
// vào Team Manifest và Manifest được Orchestrator duyệt.
export const dopaiosStartupPools = pgTable(
  "dopaios_startup_pools",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    roles: jsonb("roles").$type<Record<string, { primary: string; fallback: string }>>().notNull(),
    readiness: text("readiness").notNull(),
    state: text("state").notNull(),
    pinnedBy: text("pinned_by").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// Team Manifest (PRD FR-8): revision + manifest_stage bootstrap|delivery, đủ
// bộ trường hợp đồng — ánh xạ vai → Staff chính/dự phòng, luật định tuyến/
// kích hoạt, giới hạn, đường dự phòng, hiệu lực. Thay đổi đội = revision mới
// cần Orchestrator duyệt, không mutate tại chỗ.
export const dopaiosTeamManifests = pgTable(
  "dopaios_team_manifests",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    stage: text("stage").notNull(),
    projectId: text("project_id").notNull(),
    state: text("state").notNull(),
    poolRef: jsonb("pool_ref").$type<Record<string, unknown>>().notNull(),
    roleAssignments: jsonb("role_assignments")
      .$type<Record<string, { primary: string; fallback: string }>>()
      .notNull(),
    orchestrator: text("orchestrator").notNull(),
    pod: text("pod").notNull(),
    capacity: jsonb("capacity").$type<Record<string, number>>().notNull(),
    permissions: jsonb("permissions").$type<string[]>().notNull(),
    resources: jsonb("resources").$type<string[]>().notNull(),
    routingRules: jsonb("routing_rules").$type<Record<string, unknown>>().notNull(),
    timeouts: jsonb("timeouts").$type<Record<string, unknown>>(),
    escalation: jsonb("escalation").$type<Record<string, unknown>>(),
    fallbackPaths: jsonb("fallback_paths").$type<Record<string, unknown>>(),
    costLimits: jsonb("cost_limits").$type<Record<string, unknown>>(),
    autonomy: text("autonomy"),
    effectiveAt: timestamp("effective_at"),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at"),
    sha256: text("sha256").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// Hợp đồng thực hiện AI (PRD FR-63): biên dịch từ 4 nguồn CÓ PHIÊN BẢN (SOP,
// Team Manifest đúng giai đoạn, Project, work-item); "không đổi âm thầm phiên
// đang chạy" cưỡng chế bằng pin ID@revision@hash — sửa hợp đồng tạo revision
// mới, phiên đang hoạt động giữ pin cũ.
export const dopaiosExecutionContracts = pgTable(
  "dopaios_execution_contracts",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    workItemId: text("work_item_id").notNull(),
    sources: jsonb("sources").$type<Record<string, unknown>>().notNull(),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull(),
    sha256: text("sha256").notNull(),
    compiledBy: text("compiled_by").notNull(),
    contextPackageId: text("context_package_id"),
    contextPackageRevision: integer("context_package_revision"),
    contextPackageSha256: text("context_package_sha256"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.revision] }),
    contextPackageComplete: check(
      "dopaios_execution_contracts_context_package_complete",
      sql`num_nonnulls(${table.contextPackageId}, ${table.contextPackageRevision}, ${table.contextPackageSha256}) IN (0, 3)`,
    ),
    contextPackageFk: foreignKey({
      name: "dopaios_execution_contracts_context_package_fk",
      columns: [table.contextPackageId, table.contextPackageRevision, table.contextPackageSha256],
      foreignColumns: [dopaiosContextPackages.id, dopaiosContextPackages.revision, dopaiosContextPackages.sha256],
    }),
  }),
);

// ===== KC-08: connector, context package and bounded hybrid retrieval =====

export const dopaiosContextPackages = pgTable(
  "dopaios_context_packages",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    projectId: text("project_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    state: text("state").notNull(),
    sha256: text("sha256").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    maxBytes: integer("max_bytes").notNull(),
    maxTokens: integer("max_tokens").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvalRef: jsonb("approval_ref").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.revision] }),
    exactRefUq: unique("dopaios_context_packages_exact_ref_uniq").on(
      table.id,
      table.revision,
      table.sha256,
    ),
    projectRefUq: unique("dopaios_context_packages_project_ref_uniq").on(
      table.projectId,
      table.id,
      table.revision,
    ),
    projectExactRefUq: unique("dopaios_context_packages_project_exact_ref_uniq").on(
      table.projectId,
      table.id,
      table.revision,
      table.sha256,
    ),
    capsCheck: check(
      "dopaios_context_packages_caps_check",
      sql`${table.maxBytes} >= 0 AND ${table.maxTokens} >= 0
          AND ${table.totalBytes} >= 0 AND ${table.totalTokens} >= 0
          AND ${table.totalBytes} <= ${table.maxBytes}
          AND ${table.totalTokens} <= ${table.maxTokens}`,
    ),
  }),
);

export const dopaiosContextPackageSources = pgTable(
  "dopaios_context_package_sources",
  {
    contextPackageId: text("context_package_id").notNull(),
    contextPackageRevision: integer("context_package_revision").notNull(),
    projectId: text("project_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceType: text("source_type").notNull(),
    required: boolean("required").notNull(),
    priority: integer("priority").notNull(),
    mountState: text("mount_state").notNull(),
    omissionReason: text("omission_reason"),
    contentBytes: integer("content_bytes").notNull(),
    tokenCount: integer("token_count").notNull(),
    content: text("content"),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.contextPackageId, table.contextPackageRevision, table.sourceId, table.sourceRevision],
    }),
    scopeUq: unique("dopaios_context_package_sources_scope_uniq").on(
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
      table.sourceId,
      table.sourceRevision,
    ),
    exactRefUq: unique("dopaios_context_package_sources_exact_ref_uniq").on(
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
      table.sourceId,
      table.sourceRevision,
      table.sourceSha256,
    ),
    packageFk: foreignKey({
      name: "dopaios_context_package_sources_package_fk",
      columns: [table.projectId, table.contextPackageId, table.contextPackageRevision],
      foreignColumns: [
        dopaiosContextPackages.projectId,
        dopaiosContextPackages.id,
        dopaiosContextPackages.revision,
      ],
    }),
    countsCheck: check(
      "dopaios_context_package_sources_counts_check",
      sql`${table.priority} >= 0 AND ${table.contentBytes} >= 0 AND ${table.tokenCount} >= 0`,
    ),
    mountCheck: check(
      "dopaios_context_package_sources_mount_check",
      sql`(
            ${table.mountState} = 'mounted'
            AND ${table.omissionReason} IS NULL
            AND ${table.content} IS NOT NULL
          ) OR (
            ${table.mountState} = 'omitted'
            AND ${table.omissionReason} IS NOT NULL
            AND ${table.content} IS NULL
          )`,
    ),
    requiredCheck: check(
      "dopaios_context_package_sources_required_check",
      sql`NOT ${table.required} OR ${table.mountState} = 'mounted'`,
    ),
    contentBytesCheck: check(
      "dopaios_context_package_sources_content_bytes_check",
      sql`${table.mountState} <> 'mounted' OR ${table.contentBytes} = octet_length(${table.content})`,
    ),
    projectIdx: index("dopaios_context_sources_project_idx").on(
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
    ),
  }),
);

export const dopaiosArtifactProjectScopes = pgTable(
  "dopaios_artifact_project_scopes",
  {
    artifactId: text("artifact_id").notNull(),
    artifactRevision: integer("artifact_revision").notNull(),
    projectId: text("project_id").notNull(),
    scopeState: text("scope_state").notNull(),
    boundBy: text("bound_by").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.artifactId, table.artifactRevision, table.projectId] }),
  }),
);

export const dopaiosConnectorPolicies = pgTable(
  "dopaios_connector_policies",
  {
    policyId: text("policy_id").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().notNull(),
    scopeLevel: text("scope_level").notNull(),
    precedence: jsonb("precedence").$type<string[]>().notNull(),
    approverCapability: text("approver_capability").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    invalidation: jsonb("invalidation").$type<Record<string, unknown>>().notNull(),
    connectorId: text("connector_id").notNull(),
    connectorVersion: text("connector_version").notNull(),
    projectId: text("project_id").notNull(),
    purpose: text("purpose").notNull(),
    action: text("action").notNull(),
    direction: text("direction").notNull(),
    authType: text("auth_type").notNull(),
    credentialRef: jsonb("credential_ref").$type<Record<string, unknown>>().notNull(),
    runtime: text("runtime").notNull(),
    environment: text("environment").notNull(),
    dataClasses: jsonb("data_classes")
      .$type<Array<{ name: string; policyRef: Record<string, unknown> }>>()
      .notNull(),
    lifecyclePolicyRef: jsonb("lifecycle_policy_ref").$type<Record<string, unknown>>().notNull(),
    retentionPolicyRef: jsonb("retention_policy_ref").$type<Record<string, unknown>>().notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    rateLimit: jsonb("rate_limit").$type<Record<string, unknown>>().notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    interruption: jsonb("interruption").$type<Record<string, unknown>>().notNull(),
    retry: jsonb("retry").$type<Record<string, unknown>>().notNull(),
    backoff: jsonb("backoff").$type<Record<string, unknown>>().notNull(),
    circuitBreaker: jsonb("circuit_breaker").$type<Record<string, unknown>>().notNull(),
    idempotency: jsonb("idempotency").$type<Record<string, unknown>>().notNull(),
    reconciliation: jsonb("reconciliation").$type<Record<string, unknown>>().notNull(),
    fallback: jsonb("fallback").$type<Record<string, unknown>>().notNull(),
    audit: jsonb("audit").$type<Record<string, unknown>>().notNull(),
    redaction: jsonb("redaction").$type<Record<string, unknown>>().notNull(),
    approvalRef: jsonb("approval_ref").$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.policyId, table.policyRevision] }),
    exactRefUq: unique("dopaios_connector_policies_exact_ref_uniq").on(
      table.policyId,
      table.policyRevision,
      table.sha256,
    ),
    auditScopeUq: unique("dopaios_connector_policies_audit_scope_uniq").on(
      table.policyId,
      table.policyRevision,
      table.sha256,
      table.projectId,
      table.connectorId,
      table.connectorVersion,
      table.purpose,
      table.action,
      table.direction,
    ),
    scopeUq: uniqueIndex("dopaios_connector_policy_scope_uniq").on(
      table.connectorId,
      table.connectorVersion,
      table.projectId,
      table.purpose,
      table.action,
      table.direction,
      table.policyRevision,
    ),
  }),
);

export const dopaiosConnectorCredentials = pgTable(
  "dopaios_connector_credentials",
  {
    secretRef: text("secret_ref").notNull(),
    rotationEpoch: integer("rotation_epoch").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastActorId: text("last_actor_id"),
  },
  (table) => ({ pk: primaryKey({ columns: [table.secretRef, table.rotationEpoch] }) }),
);

export const dopaiosConnectorAuditEvents = pgTable(
  "dopaios_connector_audit_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    actorId: text("actor_id").notNull(),
    sessionId: text("session_id").notNull(),
    connectorId: text("connector_id").notNull(),
    connectorVersion: text("connector_version").notNull(),
    purpose: text("purpose").notNull(),
    action: text("action").notNull(),
    direction: text("direction").notNull(),
    policyId: text("policy_id"),
    policyRevision: integer("policy_revision"),
    policySha256: text("policy_sha256"),
    runtime: text("runtime"),
    environment: text("environment"),
    approvalRef: jsonb("approval_ref").$type<Record<string, unknown>>(),
    fallbackContextRef: jsonb("fallback_context_ref").$type<Record<string, unknown>>(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    requestId: text("request_id").notNull(),
    requestSummary: jsonb("request_summary").$type<Record<string, unknown>>().notNull(),
    responseSummary: jsonb("response_summary").$type<Record<string, unknown>>(),
    retryClass: text("retry_class").notNull(),
    attempt: integer("attempt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    projectIdx: index("dopaios_connector_audit_project_idx").on(table.projectId, table.createdAt),
    policyComplete: check(
      "dopaios_connector_audit_policy_complete",
      sql`num_nonnulls(${table.policyId}, ${table.policyRevision}, ${table.policySha256}) IN (0, 3)`,
    ),
    policyFk: foreignKey({
      name: "dopaios_connector_audit_policy_fk",
      columns: [table.policyId, table.policyRevision, table.policySha256],
      foreignColumns: [
        dopaiosConnectorPolicies.policyId,
        dopaiosConnectorPolicies.policyRevision,
        dopaiosConnectorPolicies.sha256,
      ],
    }),
    policyScopeFk: foreignKey({
      name: "dopaios_connector_audit_policy_scope_fk",
      columns: [
        table.policyId,
        table.policyRevision,
        table.policySha256,
        table.projectId,
        table.connectorId,
        table.connectorVersion,
        table.purpose,
        table.action,
        table.direction,
      ],
      foreignColumns: [
        dopaiosConnectorPolicies.policyId,
        dopaiosConnectorPolicies.policyRevision,
        dopaiosConnectorPolicies.sha256,
        dopaiosConnectorPolicies.projectId,
        dopaiosConnectorPolicies.connectorId,
        dopaiosConnectorPolicies.connectorVersion,
        dopaiosConnectorPolicies.purpose,
        dopaiosConnectorPolicies.action,
        dopaiosConnectorPolicies.direction,
      ],
    }),
  }),
);

export const dopaiosAuthorizationAuditEvents = pgTable(
  "dopaios_authorization_audit_events",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    companyId: text("company_id").notNull(),
    projectId: text("project_id"),
    action: text("action").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ scopeIdx: index("dopaios_authorization_audit_scope_idx").on(table.companyId, table.projectId, table.createdAt) }),
);

export const dopaiosDkpChunks = pgTable(
  "dopaios_dkp_chunks",
  {
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    chunkId: text("chunk_id").notNull(),
    projectId: text("project_id").notNull(),
    contextPackageId: text("context_package_id").notNull(),
    contextPackageRevision: integer("context_package_revision").notNull(),
    ordinal: integer("ordinal").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    rangeUnit: text("range_unit").notNull(),
    content: text("content").notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(sql`to_tsvector('simple', "content")`),
    embedding: vector4("embedding").notNull(),
    embeddingModelRef: jsonb("embedding_model_ref").$type<Record<string, unknown>>().notNull(),
    indexVersion: text("index_version").notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.sourceId,
        table.sourceRevision,
        table.chunkId,
        table.indexVersion,
      ],
    }),
    searchIdx: index("dopaios_dkp_chunks_search_idx").using("gin", table.searchVector),
    ordinalUq: unique("dopaios_dkp_chunks_ordinal_uniq").on(
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
      table.sourceId,
      table.sourceRevision,
      table.indexVersion,
      table.ordinal,
    ),
    rangeCheck: check(
      "dopaios_dkp_chunks_range_check",
      sql`${table.ordinal} >= 0 AND ${table.charStart} >= 0
          AND ${table.charEnd} > ${table.charStart}
          AND ${table.rangeUnit} = 'utf16-code-unit'`,
    ),
    scopeIdx: index("dopaios_dkp_chunks_scope_idx").on(
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
    ),
    sourceFk: foreignKey({
      name: "dopaios_dkp_chunks_source_fk",
      columns: [
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.sourceId,
        table.sourceRevision,
      ],
      foreignColumns: [
        dopaiosContextPackageSources.projectId,
        dopaiosContextPackageSources.contextPackageId,
        dopaiosContextPackageSources.contextPackageRevision,
        dopaiosContextPackageSources.sourceId,
        dopaiosContextPackageSources.sourceRevision,
      ],
    }),
  }),
);

export const dopaiosRetrievalQueries = pgTable(
  "dopaios_retrieval_queries",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    projectId: text("project_id").notNull(),
    contextPackageId: text("context_package_id").notNull(),
    contextPackageRevision: integer("context_package_revision").notNull(),
    contextPackageSha256: text("context_package_sha256").notNull(),
    querySha256: text("query_sha256").notNull(),
    queryRedacted: text("query_redacted").notNull(),
    method: text("method").notNull(),
    indexVersion: text("index_version").notNull(),
    embeddingModelRef: jsonb("embedding_model_ref").$type<Record<string, unknown>>().notNull(),
    policyDecision: text("policy_decision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    provenanceUq: unique("dopaios_retrieval_queries_provenance_uniq").on(
      table.id,
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
      table.contextPackageSha256,
    ),
    packageFk: foreignKey({
      name: "dopaios_retrieval_queries_package_fk",
      columns: [
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.contextPackageSha256,
      ],
      foreignColumns: [
        dopaiosContextPackages.projectId,
        dopaiosContextPackages.id,
        dopaiosContextPackages.revision,
        dopaiosContextPackages.sha256,
      ],
    }),
    sessionPackageFk: foreignKey({
      name: "dopaios_retrieval_queries_session_package_fk",
      columns: [
        table.sessionId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.contextPackageSha256,
      ],
      foreignColumns: [
        dopaiosAiSessions.id,
        dopaiosAiSessions.contextPackageId,
        dopaiosAiSessions.contextPackageRevision,
        dopaiosAiSessions.contextPackageSha256,
      ],
    }),
  }),
);

export const dopaiosRetrievalHits = pgTable(
  "dopaios_retrieval_hits",
  {
    queryId: text("query_id").notNull(),
    rank: integer("rank").notNull(),
    projectId: text("project_id").notNull(),
    contextPackageId: text("context_package_id").notNull(),
    contextPackageRevision: integer("context_package_revision").notNull(),
    contextPackageSha256: text("context_package_sha256").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    chunkId: text("chunk_id").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    rangeUnit: text("range_unit").notNull(),
    excerpt: text("excerpt").notNull(),
    method: text("method").notNull(),
    indexVersion: text("index_version").notNull(),
    embeddingModelRef: jsonb("embedding_model_ref").$type<Record<string, unknown>>().notNull(),
    score: doublePrecision("score").notNull(),
    policyDecision: text("policy_decision").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.queryId, table.rank] }),
    queryChunkUq: unique("dopaios_retrieval_hits_query_chunk_uniq").on(
      table.queryId,
      table.projectId,
      table.contextPackageId,
      table.contextPackageRevision,
      table.sourceId,
      table.sourceRevision,
      table.chunkId,
      table.indexVersion,
    ),
    queryFk: foreignKey({
      name: "dopaios_retrieval_hits_query_fk",
      columns: [
        table.queryId,
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.contextPackageSha256,
      ],
      foreignColumns: [
        dopaiosRetrievalQueries.id,
        dopaiosRetrievalQueries.projectId,
        dopaiosRetrievalQueries.contextPackageId,
        dopaiosRetrievalQueries.contextPackageRevision,
        dopaiosRetrievalQueries.contextPackageSha256,
      ],
    }),
    packageFk: foreignKey({
      name: "dopaios_retrieval_hits_package_fk",
      columns: [
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.contextPackageSha256,
      ],
      foreignColumns: [
        dopaiosContextPackages.projectId,
        dopaiosContextPackages.id,
        dopaiosContextPackages.revision,
        dopaiosContextPackages.sha256,
      ],
    }),
    sourceFk: foreignKey({
      name: "dopaios_retrieval_hits_source_fk",
      columns: [
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.sourceId,
        table.sourceRevision,
        table.sourceSha256,
      ],
      foreignColumns: [
        dopaiosContextPackageSources.projectId,
        dopaiosContextPackageSources.contextPackageId,
        dopaiosContextPackageSources.contextPackageRevision,
        dopaiosContextPackageSources.sourceId,
        dopaiosContextPackageSources.sourceRevision,
        dopaiosContextPackageSources.sourceSha256,
      ],
    }),
    chunkFk: foreignKey({
      name: "dopaios_retrieval_hits_chunk_fk",
      columns: [
        table.projectId,
        table.contextPackageId,
        table.contextPackageRevision,
        table.sourceId,
        table.sourceRevision,
        table.chunkId,
        table.indexVersion,
      ],
      foreignColumns: [
        dopaiosDkpChunks.projectId,
        dopaiosDkpChunks.contextPackageId,
        dopaiosDkpChunks.contextPackageRevision,
        dopaiosDkpChunks.sourceId,
        dopaiosDkpChunks.sourceRevision,
        dopaiosDkpChunks.chunkId,
        dopaiosDkpChunks.indexVersion,
      ],
    }),
  }),
);

// ===== KC-05: workspace song song theo Release =====

// Workspace (0517): projection từ event trên stream dopaiosWorkspace-<id>.
// Cấp phát (port/path/credential) nguyên tử trong transaction SERIALIZABLE
// của lệnh provision; đĩa vật chất hóa SAU commit và ghi nhận lại qua lệnh
// activate. Vòng đời PROVISIONED → ACTIVE → CLOSING → PURGED; nhánh lỗi
// CLOSING → PURGE_BLOCKED giữ nguyên tài nguyên (FR-17 — đóng phạm vi chưa
// hoàn tất khi purge chưa thành công; ADR-012 — lỗi purge ở trạng thái chặn).
export const dopaiosWorkspaces = pgTable("dopaios_workspaces", {
  id: text("id").primaryKey(),
  releaseId: text("release_id").notNull(),
  projectId: text("project_id"),
  state: text("state").notNull(),
  relPath: text("rel_path").notNull(),
  cacheRelPath: text("cache_rel_path").notNull(),
  port: integer("port").notNull(),
  credentialRef: jsonb("credential_ref").$type<Record<string, unknown>>().notNull(),
  baseRef: text("base_ref").notNull(),
  materialized: jsonb("materialized").$type<Record<string, unknown>>(),
  closeReason: text("close_reason"),
  purgeReport: jsonb("purge_report").$type<Record<string, unknown>>(),
  purgeFailure: jsonb("purge_failure").$type<Record<string, unknown>>(),
  retentionControl: jsonb("retention_control").$type<Record<string, unknown>>(),
});

// Sổ cấp phát tài nguyên (0517): khóa (resource_type, value) — một giá trị
// một hàng, tái cấp sau release là UPDATE; lịch sử đầy đủ nằm ở event log.
export const dopaiosWorkspaceResources = pgTable(
  "dopaios_workspace_resources",
  {
    resourceType: text("resource_type").notNull(),
    value: text("value").notNull(),
    workspaceId: text("workspace_id").notNull(),
    releaseId: text("release_id").notNull(),
    state: text("state").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.resourceType, table.value] }) }),
);

// KC-17 (0518): cutover bootstrap→runtime theo PRD Mục 6.1 — bốn hồ sơ là
// projection từ event; Cutover Plan nằm trong sổ cái artifact (dopaios_artifacts),
// không có bảng riêng. Bootstrap workflow là biểu diễn giả lập của fixture
// FX-05 (QD-3): ACTIVE | DISABLED; chỉ Cutover Record `effective` hợp lệ mới
// được phép chuyển nó sang DISABLED.
export const dopaiosBootstrapWorkflows = pgTable("dopaios_bootstrap_workflows", {
  id: text("id").primaryKey(),
  featureId: text("feature_id").notNull(),
  state: text("state").notNull(),
  disabledByRef: jsonb("disabled_by_ref").$type<Record<string, unknown>>(),
});

export const dopaiosRuntimeActivationSnapshots = pgTable(
  "dopaios_runtime_activation_snapshots",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    sha256: text("sha256").notNull(),
    featureId: text("feature_id").notNull(),
    planRef: jsonb("plan_ref").$type<Record<string, unknown>>().notNull(),
    approvalRef: jsonb("approval_ref").$type<Record<string, unknown>>().notNull(),
    authorityActor: text("authority_actor").notNull(),
    systemActor: text("system_actor").notNull(),
    activationKey: text("activation_key").notNull(),
    bootstrapWorkflowRef: text("bootstrap_workflow_ref").notNull(),
    bootstrapDisabled: boolean("bootstrap_disabled").notNull(),
    sourceStateResults: jsonb("source_state_results").$type<Record<string, unknown>[]>().notNull(),
    runtimeWorkflowRef: text("runtime_workflow_ref").notNull(),
    firstWorkItemRef: text("first_work_item_ref").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

export const dopaiosCutoverRecords = pgTable(
  "dopaios_cutover_records",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    sha256: text("sha256").notNull(),
    featureId: text("feature_id").notNull(),
    state: text("state").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    authorityActor: text("authority_actor").notNull(),
    executionActor: text("execution_actor").notNull(),
    approvalRecordRef: jsonb("approval_record_ref").$type<Record<string, unknown>>().notNull(),
    firstRuntimeWorkItemRef: text("first_runtime_work_item_ref").notNull(),
    runtimeActivationSnapshotRef: jsonb("runtime_activation_snapshot_ref")
      .$type<Record<string, unknown>>()
      .notNull(),
    reconciliationRef: jsonb("reconciliation_ref").$type<Record<string, unknown>>(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);

// KC-17 (0519): cờ readiness tiền điều kiện DS-1 giả lập (QD-1) — bốn cờ
// theo PRD revision 3 d.402; thiếu hàng là chưa đạt (fail-closed).
export const dopaiosCutoverReadiness = pgTable(
  "dopaios_cutover_readiness",
  {
    featureId: text("feature_id").notNull(),
    flag: text("flag").notNull(),
    ready: boolean("ready").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.featureId, table.flag] }) }),
);

export const dopaiosCutoverReconciliations = pgTable(
  "dopaios_cutover_reconciliations",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    sha256: text("sha256").notNull(),
    featureId: text("feature_id").notNull(),
    rolledBackRecordRef: jsonb("rolled_back_record_ref").$type<Record<string, unknown>>().notNull(),
    mappingArtifactRef: jsonb("mapping_artifact_ref").$type<Record<string, unknown>>().notNull(),
    mappings: jsonb("mappings").$type<Record<string, unknown>[]>().notNull(),
    residuals: jsonb("residuals").$type<Record<string, unknown>[]>().notNull(),
    // 0520 (B6): executor ghi vào nguồn để guard reviewer≠executor đối chiếu;
    // nullable vì event trước B6 không mang trường này.
    executionActor: text("execution_actor"),
    reviewEvidenceRef: jsonb("review_evidence_ref").$type<Record<string, unknown>>(),
    closure: jsonb("closure").$type<Record<string, unknown>>(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);
