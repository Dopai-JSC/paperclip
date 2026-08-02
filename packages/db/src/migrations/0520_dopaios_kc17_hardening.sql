-- 0520: KC-17 B6 — gia cố theo finding vòng review đối kháng 2 lens.
-- (1) Reconciliation ghi execution actor để guard "reviewer khác executor"
--     đối chiếu với NGUỒN GHI thay vì chuỗi caller tự khai (bài học KC-14 B7;
--     finding MAJOR lens 2). Cột nullable: event trước B6 không mang trường
--     này, projection giữ null — không suy diễn.
-- (2) Unique index phòng thủ chiều sâu "một revision rolled-back chỉ một
--     Reconciliation" (finding MINOR lens 2): guard chính đọc projection
--     trong cùng transaction; index bắt event bơm ngoài đường lệnh, cùng nếp
--     activation_key của 0518.
ALTER TABLE "dopaios_cutover_reconciliations"
	ADD COLUMN IF NOT EXISTS "execution_actor" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dopaios_cutover_recon_rolled_back_idx"
	ON "dopaios_cutover_reconciliations" (
		("rolled_back_record_ref"->>'recordId'),
		((("rolled_back_record_ref"->>'revision'))::int)
	);
