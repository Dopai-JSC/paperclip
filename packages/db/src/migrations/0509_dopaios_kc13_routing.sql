-- 0509: định tuyến + kích hoạt KC-13 (spike). Bốn bảng mới + mở rộng activation:
-- staff AI (PRD FR-69/FR-42 — FS-001 chỉ định nghĩa Staff người, Staff AI thuộc
-- FS-004 chưa viết nên spike dựng theo PRD và ghi nguồn tại hồ sơ);
-- startup pool có phiên bản (FR-69/AC-FR-69.1 — pool tự nó KHÔNG có quyền chạy);
-- Team Manifest (FR-8 — revision + manifest_stage, đủ bộ trường ánh xạ vai,
-- luật định tuyến/kích hoạt, giới hạn; nguồn PRD vì FS-001/FS-003 không định nghĩa);
-- Hợp đồng thực hiện AI (FR-63 — biên dịch 4 nguồn có phiên bản, pin bằng hash).
-- Activation thêm lease TTL (DEV-010 để null trong slice test — KC-13 khôi phục
-- lease thật vì CLAIMED/IN_PROGRESS trở thành bền vững giữa các lệnh).
CREATE TABLE IF NOT EXISTS "dopaios_staff_ai" (
	"id" text PRIMARY KEY NOT NULL,
	"work_status" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"skills" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"autonomy_limits" jsonb,
	"model_version" text,
	"capacity_limit" integer NOT NULL,
	"profile_revision" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_startup_pools" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"roles" jsonb NOT NULL,
	"readiness" text NOT NULL,
	"state" text NOT NULL,
	"pinned_by" text NOT NULL,
	PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_team_manifests" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"stage" text NOT NULL,
	"project_id" text NOT NULL,
	"state" text NOT NULL,
	"pool_ref" jsonb NOT NULL,
	"role_assignments" jsonb NOT NULL,
	"orchestrator" text NOT NULL,
	"pod" text NOT NULL,
	"capacity" jsonb NOT NULL,
	"permissions" jsonb NOT NULL,
	"resources" jsonb NOT NULL,
	"routing_rules" jsonb NOT NULL,
	"timeouts" jsonb,
	"escalation" jsonb,
	"fallback_paths" jsonb,
	"cost_limits" jsonb,
	"autonomy" text,
	"effective_at" timestamp,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp,
	"sha256" text NOT NULL,
	PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_execution_contracts" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"work_item_id" text NOT NULL,
	"sources" jsonb NOT NULL,
	"fields" jsonb NOT NULL,
	"state" text NOT NULL,
	"sha256" text NOT NULL,
	"compiled_by" text NOT NULL,
	PRIMARY KEY ("id", "revision")
);
--> statement-breakpoint
ALTER TABLE "dopaios_activations" ADD COLUMN IF NOT EXISTS "claim_lease_until" timestamp;
--> statement-breakpoint
ALTER TABLE "dopaios_activations" ADD COLUMN IF NOT EXISTS "lease_epoch" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "dopaios_activations" ADD COLUMN IF NOT EXISTS "contract_id" text;
--> statement-breakpoint
ALTER TABLE "dopaios_activations" ADD COLUMN IF NOT EXISTS "contract_revision" integer;
