-- 0513: KC-15 — đồ thị phụ thuộc dùng chung ở mức work-item.
-- Bảng cạnh là PROJECTION từ event WorkItemDependencyDeclared (QD-1 kế hoạch
-- KC-15 — CTO duyệt 01/08/2026): nguồn sự thật là event log, bảng tái dựng
-- 100% khi replay. Một quan hệ duy nhất phục vụ chặn một phần, impact set và
-- cascade hủy bằng ba cách ĐỌC qua module graph-repo (recursive CTE —
-- ADR-019 phương án C); KHÔNG bảng trạng thái impact mới ở mức work-item
-- (QD-2) — trạng thái vẫn nằm ở impact record artifact, invalidated_at trên
-- approval và dopaios_run_steps của KC-03/KC-14.
CREATE TABLE IF NOT EXISTS "dopaios_work_item_dependencies" (
	"work_item_id" text NOT NULL,
	"depends_on_work_item_id" text NOT NULL,
	"run_id" text NOT NULL,
	"declared_by" text NOT NULL,
	"basis" jsonb,
	CONSTRAINT "dopaios_work_item_dependencies_pk" PRIMARY KEY("work_item_id","depends_on_work_item_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_wid_depends_on_idx" ON "dopaios_work_item_dependencies" ("depends_on_work_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_wid_run_idx" ON "dopaios_work_item_dependencies" ("run_id");
