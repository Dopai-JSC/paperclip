-- 0518: KC-17 — cutover bootstrap→runtime (PRD Mục 6.1, AC-V1-10).
-- Bốn hồ sơ cutover là projection từ event trên event store KC-01 (QD-2 kế
-- hoạch KC-17 — CTO duyệt 02/08/2026): Cutover Plan là artifact đã đăng ký
-- ledger (dopaios_artifacts, pin sha256 fixture), không có bảng riêng; ba
-- bảng dưới giữ Runtime Activation Snapshot, Cutover Record (mỗi revision
-- một hàng, lịch sử không xóa) và Cutover Reconciliation Record; bảng thứ tư
-- biểu diễn bootstrap workflow giả lập của fixture (QD-3) để kiểm "chỉ record
-- effective hợp lệ mới kết thúc bootstrap" và "không còn đường ghi song song
-- cho phạm vi đã chuyển" (PRD d.318).
CREATE TABLE IF NOT EXISTS "dopaios_bootstrap_workflows" (
	"id" text PRIMARY KEY,
	"feature_id" text NOT NULL,
	"state" text NOT NULL,
	"disabled_by_ref" jsonb
);
--> statement-breakpoint
-- Một feature một bootstrap workflow trên fixture: guard chính đọc projection
-- trong cùng transaction SERIALIZABLE; index bắt lệch nếu event log bị bơm
-- ngoài đường lệnh (nếp phòng thủ chiều sâu 0517).
CREATE UNIQUE INDEX IF NOT EXISTS "dopaios_bootstrap_workflows_feature_idx"
	ON "dopaios_bootstrap_workflows" ("feature_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_runtime_activation_snapshots" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"feature_id" text NOT NULL,
	"plan_ref" jsonb NOT NULL,
	"approval_ref" jsonb NOT NULL,
	"authority_actor" text NOT NULL,
	"system_actor" text NOT NULL,
	"activation_key" text NOT NULL,
	"bootstrap_workflow_ref" text NOT NULL,
	"bootstrap_disabled" boolean NOT NULL,
	"source_state_results" jsonb NOT NULL,
	"runtime_workflow_ref" text NOT NULL,
	"first_work_item_ref" text NOT NULL,
	CONSTRAINT "dopaios_runtime_activation_snapshots_pk" PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
-- Đúng-một-lần theo activation event/idempotency key (AC-V1-10): guard chính
-- là idempotency của executeCommand KC-01 + đọc projection cùng snapshot;
-- index này bắt lần kích hoạt thứ hai lọt qua đường ngoài lệnh.
CREATE UNIQUE INDEX IF NOT EXISTS "dopaios_ras_activation_key_idx"
	ON "dopaios_runtime_activation_snapshots" ("activation_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_cutover_records" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"feature_id" text NOT NULL,
	"state" text NOT NULL,
	"effective_at" timestamp with time zone,
	"authority_actor" text NOT NULL,
	"execution_actor" text NOT NULL,
	"approval_record_ref" jsonb NOT NULL,
	"first_runtime_work_item_ref" text NOT NULL,
	"runtime_activation_snapshot_ref" jsonb NOT NULL,
	"reconciliation_ref" jsonb,
	CONSTRAINT "dopaios_cutover_records_pk" PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_cutover_reconciliations" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"feature_id" text NOT NULL,
	"rolled_back_record_ref" jsonb NOT NULL,
	"mapping_artifact_ref" jsonb NOT NULL,
	"mappings" jsonb NOT NULL,
	"residuals" jsonb NOT NULL,
	"review_evidence_ref" jsonb,
	"closure" jsonb,
	CONSTRAINT "dopaios_cutover_reconciliations_pk" PRIMARY KEY ("id", "revision")
);
