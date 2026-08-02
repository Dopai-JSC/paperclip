-- 0517: KC-05 — workspace song song theo Release.
-- Sổ workspace là projection từ event trên event store KC-01 (QD-1 kế hoạch
-- KC-05 — CTO duyệt 02/08/2026): cấp phát tài nguyên (port/path/credential)
-- nguyên tử trong transaction SERIALIZABLE của executeCommand; đĩa (worktree,
-- cache, credential fixture) vật chất hóa SAU khi cấp phát commit và được ghi
-- nhận lại bằng lệnh activate. Vòng đời: PROVISIONED → ACTIVE → CLOSING →
-- PURGED, nhánh lỗi CLOSING → PURGE_BLOCKED (FR-17: đóng phạm vi chưa hoàn
-- tất khi purge chưa thành công; ADR-012: lỗi purge giữ trạng thái chặn).
CREATE TABLE IF NOT EXISTS "dopaios_workspaces" (
	"id" text PRIMARY KEY,
	"release_id" text NOT NULL,
	"project_id" text,
	"state" text NOT NULL,
	"rel_path" text NOT NULL,
	"cache_rel_path" text NOT NULL,
	"port" integer NOT NULL,
	"credential_ref" jsonb NOT NULL,
	"base_ref" text NOT NULL,
	"materialized" jsonb,
	"close_reason" text,
	"purge_report" jsonb,
	"purge_failure" jsonb
);
--> statement-breakpoint
-- Phòng thủ chiều sâu cho guard "một workspace sống trên một Release":
-- guard chính đọc projection trong cùng transaction; index bắt lệch nếu
-- event log bị bơm ngoài đường lệnh.
CREATE UNIQUE INDEX IF NOT EXISTS "dopaios_workspaces_live_release_idx"
	ON "dopaios_workspaces" ("release_id") WHERE "state" <> 'PURGED';
--> statement-breakpoint
-- Sổ cấp phát tài nguyên theo (loại, giá trị): port từ pool, path theo scope
-- Release, credential fixture. Khóa chính (resource_type, value) — một giá
-- trị chỉ có một hàng; tái cấp sau khi release là UPDATE, lịch sử đầy đủ nằm
-- trong event log. Purge fail KHÔNG release tài nguyên (FR-17: truy cập còn
-- sót bị hạn chế, không tái gán khi chưa sạch — ADR-012).
CREATE TABLE IF NOT EXISTS "dopaios_workspace_resources" (
	"resource_type" text NOT NULL,
	"value" text NOT NULL,
	"workspace_id" text NOT NULL,
	"release_id" text NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "dopaios_workspace_resources_type_value_pk" PRIMARY KEY("resource_type","value")
);
