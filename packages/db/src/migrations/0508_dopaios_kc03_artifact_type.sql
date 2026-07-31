-- 0508: artifact mang loại và cờ schema region (spike KC-03 B2). Separation
-- policy tra theo LOẠI artifact (FS-002 SFR-014); approve-with-conditions
-- theo vùng chỉ hợp lệ trên loại có schema region (SFR-024/025) — guard đọc
-- từ dòng artifact, không tin loại do người gọi khai trong lệnh phê duyệt.
ALTER TABLE "dopaios_artifacts" ADD COLUMN IF NOT EXISTS "artifact_type" text;
--> statement-breakpoint
ALTER TABLE "dopaios_artifacts" ADD COLUMN IF NOT EXISTS "has_region_schema" boolean;
