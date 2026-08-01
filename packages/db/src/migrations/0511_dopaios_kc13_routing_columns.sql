-- 0511: cột định tuyến KC-13. Work-item mang vai AI (FR-15 — năng lực phù hợp
-- vai/loại việc), đích định tuyến và CĂN CỨ chọn (FR-42 — "giải thích căn cứ").
-- Nullable vì work-item run test KC-01 không qua router.
ALTER TABLE "dopaios_work_items" ADD COLUMN IF NOT EXISTS "role" text;
--> statement-breakpoint
ALTER TABLE "dopaios_work_items" ADD COLUMN IF NOT EXISTS "routed_to" text;
--> statement-breakpoint
ALTER TABLE "dopaios_work_items" ADD COLUMN IF NOT EXISTS "routing_basis" jsonb;
