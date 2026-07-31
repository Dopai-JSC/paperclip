-- 0502: bảng lệnh idempotency + projection đọc cho spike KC-01.
-- Event là nguồn sự thật (message_store.messages, migration 0501); các bảng
-- dưới đây là projection đọc dựng lại được, phủ bảy loại trạng thái mà FS-003
-- SQR-003 yêu cầu tái dựng 100% khi replay. Cột là mức tối thiểu cho contract
-- test KC-01, không phải schema sản phẩm.
CREATE TABLE IF NOT EXISTS "dopaios_commands" (
	"command_id" text PRIMARY KEY NOT NULL,
	"payload_sha256" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_actors" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"active" boolean NOT NULL,
	"capabilities" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"template_ref" jsonb NOT NULL,
	"orchestrator" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_artifacts" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"artifact_state" text NOT NULL,
	"impact_status" text NOT NULL,
	CONSTRAINT "dopaios_artifacts_id_revision_pk" PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_sop_definitions" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"sop_pin" jsonb NOT NULL,
	"contract_suite_evidence" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_sop_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"state" text NOT NULL,
	"definition_ref" jsonb NOT NULL,
	"decider" text NOT NULL,
	"pod" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"state" text NOT NULL,
	"executor" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_output_versions" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"work_item_id" text NOT NULL,
	"state" text NOT NULL,
	"content_sha256" text NOT NULL,
	CONSTRAINT "dopaios_output_versions_id_revision_pk" PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_action_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"run_id" text NOT NULL,
	"decided_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_decision_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"state" text NOT NULL,
	"refs" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_approval_records" (
	"id" text PRIMARY KEY NOT NULL,
	"package_id" text NOT NULL,
	"package_revision" integer NOT NULL,
	"outcome" text NOT NULL,
	"pinned_refs" jsonb NOT NULL,
	"actor" text NOT NULL
);
