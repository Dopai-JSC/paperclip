import { pgTable, text, integer, boolean, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";

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
  runId: text("run_id").notNull(),
  state: text("state").notNull(),
  executor: text("executor"),
});

export const dopaiosOutputVersions = pgTable(
  "dopaios_output_versions",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    workItemId: text("work_item_id").notNull(),
    state: text("state").notNull(),
    contentSha256: text("content_sha256").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
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
});

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
});

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
  },
  (table) => ({ pk: primaryKey({ columns: [table.id, table.revision] }) }),
);
