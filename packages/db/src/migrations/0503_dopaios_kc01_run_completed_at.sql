-- 0503: diễn tập tiến hóa schema KC-01 — nâng v0.1 lên bản kế tiếp.
-- Thêm cột completed_at cho dopaios_sop_runs; giá trị suy từ thời điểm event
-- SopRunStateChanged(COMPLETED) bất biến trong message_store.messages, nên
-- các dòng đã projection trước khi cột tồn tại được backfill bằng replay
-- (không sửa event, không mất dữ liệu — NFR-1/NFR-8).
ALTER TABLE "dopaios_sop_runs" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
