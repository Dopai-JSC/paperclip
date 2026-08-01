-- 0516: KC-04 B6 — index cho các cách đọc truy vết (minor m-1 vòng review
-- đối kháng): seq-scan dưới SERIALIZABLE lấy SIRead predicate lock mức quan
-- hệ, mọi INSERT song song vào bảng bị quét tạo cạnh rw với lệnh đang trace
-- → tăng 40001 dưới tải. Index thu hẹp predicate lock và chi phí truy vấn
-- theo sha256/target. Số đo tải thật thuộc KC-10.
CREATE INDEX IF NOT EXISTS "dopaios_artifacts_sha256_idx" ON "dopaios_artifacts" ("sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_session_artifacts_sha256_idx" ON "dopaios_session_artifacts" ("sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_approval_records_target_idx" ON "dopaios_approval_records" ("target_id","target_revision");
