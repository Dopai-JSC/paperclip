-- 0505: projection Phiên chạy AI theo work-item (spike KC-02, PRD Mục 3).
-- Nguồn sự thật là event trong message_store.messages (stream riêng mỗi
-- phiên); hai bảng dưới là projection đọc dựng lại được. Bất biến do tầng
-- lệnh giữ: phiên terminal không mở lại; phiên mới liên kết predecessor
-- (relation: retry | reassign | continue); artifact đã xác nhận là immutable.
CREATE TABLE IF NOT EXISTS "dopaios_ai_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"engine" text NOT NULL,
	"state" text NOT NULL,
	"predecessor_id" text,
	"relation" text,
	"last_signal_at" timestamp,
	"detection_latency_ms" integer,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_session_artifacts" (
	"session_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"sha256" text NOT NULL,
	"confirmed" boolean NOT NULL,
	CONSTRAINT "dopaios_session_artifacts_session_id_seq_pk" PRIMARY KEY ("session_id", "seq")
);
