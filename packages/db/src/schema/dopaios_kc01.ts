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
});

export const dopaiosDecisionPackages = pgTable("dopaios_decision_packages", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  refs: jsonb("refs").$type<Record<string, unknown>>().notNull(),
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

export const dopaiosApprovalRecords = pgTable("dopaios_approval_records", {
  id: text("id").primaryKey(),
  packageId: text("package_id").notNull(),
  packageRevision: integer("package_revision").notNull(),
  outcome: text("outcome").notNull(),
  pinnedRefs: jsonb("pinned_refs").$type<Record<string, unknown>>().notNull(),
  actor: text("actor").notNull(),
});
