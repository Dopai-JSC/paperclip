-- 0519: KC-17 — cờ readiness tiền điều kiện DS-1 trên fixture (QD-1).
-- Bốn cờ theo PRD revision 3 d.402: fs005_ready, fs006_ready,
-- product_baseline_p1, adp3 — biểu diễn giả lập, KHÔNG suy diễn nội dung
-- FS-005/FS-006/Baseline/ADP-3 thật (ranh kế hoạch KC-17 Mục 5.3). Một cờ
-- một hàng; guard kích hoạt đọc projection này trong cùng transaction
-- SERIALIZABLE — thiếu hàng là CHƯA ĐẠT (fail-closed), không default ngầm.
CREATE TABLE IF NOT EXISTS "dopaios_cutover_readiness" (
	"feature_id" text NOT NULL,
	"flag" text NOT NULL,
	"ready" boolean NOT NULL,
	CONSTRAINT "dopaios_cutover_readiness_pk" PRIMARY KEY ("feature_id", "flag")
);
