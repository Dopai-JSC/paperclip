-- 0514: KC-15 B3 — pin danh sách nguồn trên phiên bản đầu ra.
-- source_refs là danh sách pin ID@revision@sha256 theo đúng ngữ nghĩa "Danh
-- sách nguồn" của FS-002 (EDGE-001 — không nhận "latest"): phiên bản đầu ra
-- khai nó được dựng từ artifact nguồn nào trong sổ. Đây là dữ liệu pin sẵn có
-- của FS-002 nối work-item ↔ artifact (QD-4), KHÔNG phải trạng thái mới —
-- impact khi nguồn đổi nghĩa vẫn đi qua ApprovalInvalidated/RunStepReblocked
-- của KC-14 (SFR-031/050). Nullable vì event cũ không mang trường này.
ALTER TABLE "dopaios_output_versions" ADD COLUMN IF NOT EXISTS "source_refs" jsonb;
