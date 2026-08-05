-- KC-10: projection tìm kiếm/vận hành tách khỏi event store nguồn.
-- Mọi truy vấn người dùng phải JOIN ACL explicit-allow; không có hàng allow là deny.

CREATE TABLE IF NOT EXISTS "dopaios_kc10_dataset_runs" (
  "dataset_id" text PRIMARY KEY,
  "company_id" text NOT NULL,
  "manifest_sha256" text NOT NULL CHECK ("manifest_sha256" ~ '^[0-9a-f]{64}$'),
  "projection_state" text NOT NULL CHECK ("projection_state" IN ('complete', 'partial', 'error')),
  "generated_at" timestamptz NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "dopaios_kc10_dataset_runs_company_generated_idx"
  ON "dopaios_kc10_dataset_runs" ("company_id", "generated_at" DESC);

CREATE TABLE IF NOT EXISTS "dopaios_kc10_project_acl" (
  "company_id" text NOT NULL,
  "user_id" text NOT NULL,
  "project_id" text NOT NULL,
  "decision" text NOT NULL CHECK ("decision" IN ('allow', 'deny')),
  PRIMARY KEY ("company_id", "user_id", "project_id")
);

CREATE INDEX IF NOT EXISTS "dopaios_kc10_project_acl_lookup_idx"
  ON "dopaios_kc10_project_acl" ("company_id", "user_id", "decision", "project_id");

CREATE TABLE IF NOT EXISTS "dopaios_kc10_objects" (
  "company_id" text NOT NULL,
  "object_id" text NOT NULL,
  "stable_id" text NOT NULL,
  "kind" text NOT NULL,
  "project_id" text NOT NULL,
  "title" text NOT NULL,
  "state" text NOT NULL,
  "owner_id" text,
  "occurred_at" timestamptz NOT NULL,
  "source_href" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "search_vector" tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce("stable_id", '') || ' ' || coalesce("title", '') || ' ' ||
      coalesce("state", '') || ' ' || coalesce("owner_id", ''))
  ) STORED,
  PRIMARY KEY ("company_id", "object_id"),
  UNIQUE ("company_id", "kind", "stable_id")
);

CREATE INDEX IF NOT EXISTS "dopaios_kc10_objects_scope_idx"
  ON "dopaios_kc10_objects" ("company_id", "project_id", "kind", "state", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "dopaios_kc10_objects_owner_idx"
  ON "dopaios_kc10_objects" ("company_id", "owner_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "dopaios_kc10_objects_search_idx"
  ON "dopaios_kc10_objects" USING gin ("search_vector");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_kc10_session_signals" (
  "dataset_id" text NOT NULL,
  "id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "dopaios_kc10_session_signals_pk" PRIMARY KEY ("dataset_id", "id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_kc10_session_signals_session_idx"
  ON "dopaios_kc10_session_signals" ("dataset_id", "session_id", "occurred_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_kc10_checkpoints" (
  "dataset_id" text NOT NULL,
  "id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "dopaios_kc10_checkpoints_pk" PRIMARY KEY ("dataset_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dopaios_kc10_checkpoints_session_sequence_idx"
  ON "dopaios_kc10_checkpoints" ("dataset_id", "session_id", "sequence");
