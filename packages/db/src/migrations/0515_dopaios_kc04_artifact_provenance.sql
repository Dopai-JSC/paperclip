-- 0515: KC-04 B1 — provenance trên sổ cái artifact FS-002.
-- source_refs là "Danh sách nguồn" của lệnh đăng ký (FS-002 d.629 + EDGE-001:
-- mỗi nguồn pin ID@revision hoặc hash, không nhận "latest"; thiếu → danh sách
-- rỗng); storage_ref là nơi lưu nội dung theo tiêu chí 2 của KC-04 ("mỗi
-- artifact chỉ ra Project, work-item, Phiên chạy AI, phiên bản, hash và nơi
-- lưu"). Hai cột là PROJECTION từ event ArtifactRegistered — nguồn sự thật
-- vẫn là event log. KHÔNG bảng trace_links mới (QD-1/QD-2 KC-04):
-- Project/work-item/Phiên chạy AI của artifact đọc qua liên kết sẵn có
-- (dopaios_output_versions, dopaios_session_artifacts, dopaios_work_items)
-- bằng graph-repo. Nullable vì event trước KC-04 không mang hai trường này.
ALTER TABLE "dopaios_artifacts" ADD COLUMN IF NOT EXISTS "source_refs" jsonb;
--> statement-breakpoint
ALTER TABLE "dopaios_artifacts" ADD COLUMN IF NOT EXISTS "storage_ref" text;
