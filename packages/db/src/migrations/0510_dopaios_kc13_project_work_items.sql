-- 0510: work-item gắn Project cho KC-13. FS-001 SFR-003 chặn work-item AI trên
-- Project PREPARING — muốn chứng minh guard phải có khái niệm "work-item thuộc
-- Project" (UJ-10: sau P0-01 Dopaios mới tạo work-item P0). project_id nullable
-- và run_id thả NOT NULL vì work-item KC-01 thuộc run test không gắn Project,
-- còn work-item P0 thuộc Project chưa có SOP run.
ALTER TABLE "dopaios_work_items" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
ALTER TABLE "dopaios_work_items" ALTER COLUMN "run_id" DROP NOT NULL;
