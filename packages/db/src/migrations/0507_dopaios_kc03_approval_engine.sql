-- 0507: approval engine KC-03 (spike). Bốn bảng mới + mở rộng ba bảng có sẵn:
-- separation policy (FS-002 SFR-013/014 fail-closed — policy lưu jsonb thô,
-- guard kiểm đủ trường tại thời điểm phê duyệt); condition (SFR-015/033/055);
-- impact record (SFR-016/029 — mỗi sự kiện impact một record mở riêng);
-- gate record (FS-003 SFR-035 — chỉ Cổng A/B/C). Approval record nhận đủ bộ
-- trường hợp đồng record-approval (FS-002 bảng d.651-661); decision package
-- chuyển khóa (id, revision) để supersede theo SFR-047; artifact thêm
-- created_by cho separation rule theo định danh Staff tạo revision.
CREATE TABLE IF NOT EXISTS "dopaios_separation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_type" text NOT NULL,
	"revision" integer NOT NULL,
	"policy" jsonb NOT NULL,
	"pinned_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_conditions" (
	"id" text PRIMARY KEY NOT NULL,
	"record_id" text NOT NULL,
	"scope" jsonb NOT NULL,
	"risk" text NOT NULL,
	"owner" text NOT NULL,
	"deadline" timestamp NOT NULL,
	"closure_criteria" text NOT NULL,
	"compensating_obligation" text,
	"blocks_next_step" boolean NOT NULL,
	"state" text NOT NULL,
	"closed_by" text,
	"closed_at" timestamp,
	"closure_evidence" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_impact_records" (
	"id" text PRIMARY KEY NOT NULL,
	"artifact_id" text NOT NULL,
	"artifact_revision" integer NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"state" text NOT NULL,
	"conclusion" text,
	"dispositioned_by" text,
	"basis" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_gate_records" (
	"id" text PRIMARY KEY NOT NULL,
	"gate_name" text NOT NULL,
	"point_id" text NOT NULL,
	"run_id" text,
	"approval_record_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dopaios_artifacts" ADD COLUMN IF NOT EXISTS "created_by" text;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "target_id" text;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "target_revision" integer;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "target_sha256" text;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "approved_scope" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "findings" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "non_waivable_blockers" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "impact_set" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "downstream_checked" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "opened_step" text;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "re_entry_point" text;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "expiry" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "requested_by" text;
--> statement-breakpoint
ALTER TABLE "dopaios_decision_packages" ADD COLUMN IF NOT EXISTS "target" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_decision_packages" ADD COLUMN IF NOT EXISTS "fields" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_decision_packages" DROP CONSTRAINT IF EXISTS "dopaios_decision_packages_pkey";
--> statement-breakpoint
ALTER TABLE "dopaios_decision_packages" ADD PRIMARY KEY ("id", "revision");
--> statement-breakpoint
ALTER TABLE "dopaios_action_requests" ADD COLUMN IF NOT EXISTS "package_id" text;
--> statement-breakpoint
ALTER TABLE "dopaios_action_requests" ADD COLUMN IF NOT EXISTS "package_revision" integer;
