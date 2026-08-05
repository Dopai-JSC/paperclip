-- KC-11: usage và chi phí theo Phiên chạy AI (vùng migration Dopai 0500+).
-- Mỗi bước engine (một lần gọi CLI) ghi một dòng usage; tổng phiên được
-- projector cộng dồn từ event AiSessionUsageRecorded — nguồn sự thật là
-- event log, bảng dưới đây chỉ là projection đọc.

CREATE TABLE "dopaios_session_usage" (
  "session_id" text NOT NULL,
  "seq" integer NOT NULL,
  "step" text NOT NULL,
  "model" text NOT NULL,
  "billing_type" text NOT NULL,
  "input_tokens" integer NOT NULL,
  "cached_input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "cost_usd_reported" numeric(14, 8),
  "cost_usd_computed" numeric(14, 8) NOT NULL,
  "price_source" text NOT NULL,
  CONSTRAINT "dopaios_session_usage_pk" PRIMARY KEY ("session_id", "seq"),
  CONSTRAINT "dopaios_session_usage_tokens_nonneg" CHECK (
    "input_tokens" >= 0 AND "cached_input_tokens" >= 0 AND "output_tokens" >= 0
  )
);

ALTER TABLE "dopaios_ai_sessions"
  ADD COLUMN "usage_input_tokens" integer NOT NULL DEFAULT 0,
  ADD COLUMN "usage_cached_input_tokens" integer NOT NULL DEFAULT 0,
  ADD COLUMN "usage_output_tokens" integer NOT NULL DEFAULT 0,
  ADD COLUMN "usage_cost_usd_reported" numeric(14, 8) NOT NULL DEFAULT 0,
  ADD COLUMN "usage_cost_usd_computed" numeric(14, 8) NOT NULL DEFAULT 0,
  ADD COLUMN "budget_state" text;

CREATE INDEX "dopaios_ai_sessions_work_item_idx"
  ON "dopaios_ai_sessions" ("work_item_id");
