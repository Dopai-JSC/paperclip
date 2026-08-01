-- 0512: KC-14 — hai vòng đời thực hiện và chất lượng.
-- Hợp đồng chất lượng là projection NỘI DUNG theo (id, revision); hiệu lực do
-- guard đọc từ sổ artifact FS-002 trong cùng transaction (đăng ký loại
-- 'quality-contract', approved, impact ∈ {clear, reaffirmed}, đúng sha256) —
-- quyết định phạm vi QD-2 của kế hoạch KC-14 đã được CTO duyệt 01/08/2026.
CREATE TABLE IF NOT EXISTS "dopaios_quality_contracts" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"output_type" text NOT NULL,
	"required_checks" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"registered_by" text NOT NULL,
	CONSTRAINT "dopaios_quality_contracts_id_revision_pk" PRIMARY KEY("id","revision")
);
--> statement-breakpoint
-- Trục phiên bản đầu ra: pin hợp đồng chất lượng lúc nộp (không-"latest"),
-- bằng chứng theo từng loại kiểm, quan hệ thay thế của bản sửa (FS-003
-- SFR-030/045 — bản mới không kế thừa, chỉ ghi quan hệ). Nullable vì event
-- KC-01 cũ không mang các trường này.
ALTER TABLE "dopaios_output_versions" ADD COLUMN IF NOT EXISTS "quality_contract_ref" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_output_versions" ADD COLUMN IF NOT EXISTS "check_evidence" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_output_versions" ADD COLUMN IF NOT EXISTS "replaces_revision" integer;
--> statement-breakpoint
-- Work-item rework (FS-003 SFR-022): hàng NONE → PROPOSED biến thể rework ghi
-- liên kết work-item và phiên bản đầu ra trước; không mở lại item terminal.
ALTER TABLE "dopaios_work_items" ADD COLUMN IF NOT EXISTS "rework_of_work_item_id" text;
--> statement-breakpoint
ALTER TABLE "dopaios_work_items" ADD COLUMN IF NOT EXISTS "rework_of_output_ref" jsonb;
--> statement-breakpoint
-- Approval trên trục đầu ra có thể HẾT HIỆU LỰC (FS-003 SFR-031/034) mà không
-- viết lại lifecycle của phiên bản — hai trường đúng lời hàng ACCEPTED.
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "invalidated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "dopaios_approval_records" ADD COLUMN IF NOT EXISTS "invalidation_reason" text;
--> statement-breakpoint
-- Yêu cầu liên kết gói vô hiệu do target đổi kết thúc tại
-- SUPERSEDED-TARGET-CHANGED (DEV-009) kèm lý do và dấu vết sự kiện.
ALTER TABLE "dopaios_action_requests" ADD COLUMN IF NOT EXISTS "invalidation" jsonb;
--> statement-breakpoint
-- Bước của run mở theo approval (FS-003 SFR-029) và bị TÁI CHẶN đúng impact
-- set khi approval hết hiệu lực (SFR-050) — tối thiểu cho slice: open | reblocked.
CREATE TABLE IF NOT EXISTS "dopaios_run_steps" (
	"run_id" text NOT NULL,
	"step_id" text NOT NULL,
	"state" text NOT NULL,
	"opened_by_record_id" text,
	CONSTRAINT "dopaios_run_steps_run_id_step_id_pk" PRIMARY KEY("run_id","step_id")
);
