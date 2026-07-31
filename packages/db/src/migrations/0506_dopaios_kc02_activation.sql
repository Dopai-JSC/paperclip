-- 0506: projection kích hoạt kiểu KC-13 và circuit-breaker auth (spike KC-02).
-- Kích hoạt idempotent (FS-003 SFR-011) với claim compare-and-set; breaker
-- hard-stop chuỗi lỗi xác thực lặp trước khi gọi engine (bài học upstream
-- issue #9539 — điều kiện gác bắt buộc trước khi bind credential thật V-01).
CREATE TABLE IF NOT EXISTS "dopaios_activations" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"engine" text NOT NULL,
	"state" text NOT NULL,
	"claimed_by" text,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_auth_breakers" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"consecutive_failures" integer NOT NULL
);
