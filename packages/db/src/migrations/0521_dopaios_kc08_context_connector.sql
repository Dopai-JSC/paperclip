-- 0521: KC-08 — bounded context package, project connector policy and DKP retrieval spike.
-- pgvector is mandatory for the positive retrieval path. Embedded PostgreSQL used by the
-- older KC regression suite does not ship extension control files, so the migration records
-- that capability as unavailable and leaves a real[] placeholder; the KC-08 runtime refuses
-- retrieval in that state. On a pgvector host the column is converted to vector(4) below.
CREATE TABLE IF NOT EXISTS "dopaios_kc08_capabilities" (
	"name" text PRIMARY KEY,
	"available" boolean NOT NULL,
	"version" text,
	"detail" text NOT NULL
);
--> statement-breakpoint
DO $$
DECLARE
	vector_version text;
BEGIN
	IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
		EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public';
		SELECT extversion INTO vector_version FROM pg_extension WHERE extname = 'vector';
		IF vector_version IS NULL OR vector_version <> '0.8.6' THEN
			RAISE EXCEPTION 'KC-08 requires pgvector 0.8.6, found %', coalesce(vector_version, 'missing');
		END IF;
		INSERT INTO "dopaios_kc08_capabilities" ("name", "available", "version", "detail")
		VALUES ('pgvector', true, vector_version, 'exact-scan vector(4) enabled')
		ON CONFLICT ("name") DO UPDATE SET
			"available" = EXCLUDED."available",
			"version" = EXCLUDED."version",
			"detail" = EXCLUDED."detail";
	ELSE
		INSERT INTO "dopaios_kc08_capabilities" ("name", "available", "version", "detail")
		VALUES ('pgvector', false, NULL, 'extension control file unavailable; retrieval fails closed')
		ON CONFLICT ("name") DO UPDATE SET
			"available" = EXCLUDED."available",
			"version" = EXCLUDED."version",
			"detail" = EXCLUDED."detail";
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "dopaios_execution_contracts"
	ADD COLUMN IF NOT EXISTS "context_package_id" text,
	ADD COLUMN IF NOT EXISTS "context_package_revision" integer,
	ADD COLUMN IF NOT EXISTS "context_package_sha256" text;
--> statement-breakpoint
ALTER TABLE "dopaios_execution_contracts"
	ADD CONSTRAINT "dopaios_execution_contracts_context_package_complete"
	CHECK (num_nonnulls("context_package_id", "context_package_revision", "context_package_sha256") IN (0, 3));
--> statement-breakpoint
ALTER TABLE "dopaios_activations"
	ADD COLUMN IF NOT EXISTS "context_package_id" text,
	ADD COLUMN IF NOT EXISTS "context_package_revision" integer,
	ADD COLUMN IF NOT EXISTS "context_package_sha256" text;
--> statement-breakpoint
ALTER TABLE "dopaios_activations"
	ADD CONSTRAINT "dopaios_activations_context_package_complete"
	CHECK (num_nonnulls("context_package_id", "context_package_revision", "context_package_sha256") IN (0, 3));
--> statement-breakpoint
ALTER TABLE "dopaios_ai_sessions"
	ADD COLUMN IF NOT EXISTS "context_package_id" text,
	ADD COLUMN IF NOT EXISTS "context_package_revision" integer,
	ADD COLUMN IF NOT EXISTS "context_package_sha256" text;
--> statement-breakpoint
ALTER TABLE "dopaios_ai_sessions"
	ADD CONSTRAINT "dopaios_ai_sessions_context_package_complete"
	CHECK (num_nonnulls("context_package_id", "context_package_revision", "context_package_sha256") IN (0, 3));
--> statement-breakpoint
ALTER TABLE "dopaios_ai_sessions"
	ADD CONSTRAINT "dopaios_ai_sessions_context_package_ref_uniq"
	UNIQUE("id", "context_package_id", "context_package_revision", "context_package_sha256");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_context_packages" (
	"id" text NOT NULL,
	"revision" integer NOT NULL,
	"project_id" text NOT NULL,
	"work_item_id" text NOT NULL,
	"state" text NOT NULL,
	"sha256" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"max_bytes" integer NOT NULL,
	"max_tokens" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"approved_by" text NOT NULL,
	"approval_ref" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "dopaios_context_packages_pk" PRIMARY KEY("id", "revision"),
	CONSTRAINT "dopaios_context_packages_exact_ref_uniq" UNIQUE("id", "revision", "sha256"),
	CONSTRAINT "dopaios_context_packages_project_ref_uniq" UNIQUE("project_id", "id", "revision"),
	CONSTRAINT "dopaios_context_packages_project_exact_ref_uniq" UNIQUE("project_id", "id", "revision", "sha256"),
	CONSTRAINT "dopaios_context_packages_caps_check" CHECK(
		"max_bytes" >= 0 AND "max_tokens" >= 0
		AND "total_bytes" >= 0 AND "total_tokens" >= 0
		AND "total_bytes" <= "max_bytes" AND "total_tokens" <= "max_tokens"
	)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_context_package_sources" (
	"context_package_id" text NOT NULL,
	"context_package_revision" integer NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"source_sha256" text NOT NULL,
	"source_type" text NOT NULL,
	"required" boolean NOT NULL,
	"priority" integer NOT NULL,
	"mount_state" text NOT NULL,
	"omission_reason" text,
	"content_bytes" integer NOT NULL,
	"token_count" integer NOT NULL,
	"content" text,
	CONSTRAINT "dopaios_context_package_sources_pk" PRIMARY KEY(
		"context_package_id", "context_package_revision", "source_id", "source_revision"
	),
	CONSTRAINT "dopaios_context_package_sources_scope_uniq" UNIQUE(
		"project_id", "context_package_id", "context_package_revision", "source_id", "source_revision"
	),
	CONSTRAINT "dopaios_context_package_sources_exact_ref_uniq" UNIQUE(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "source_sha256"
	),
	CONSTRAINT "dopaios_context_package_sources_package_fk" FOREIGN KEY(
		"project_id", "context_package_id", "context_package_revision"
	) REFERENCES "dopaios_context_packages"("project_id", "id", "revision"),
	CONSTRAINT "dopaios_context_package_sources_counts_check" CHECK(
		"priority" >= 0 AND "content_bytes" >= 0 AND "token_count" >= 0
	),
	CONSTRAINT "dopaios_context_package_sources_mount_check" CHECK(
		(
			"mount_state" = 'mounted'
			AND "omission_reason" IS NULL
			AND "content" IS NOT NULL
		) OR (
			"mount_state" = 'omitted'
			AND "omission_reason" IS NOT NULL
			AND "content" IS NULL
		)
	),
	CONSTRAINT "dopaios_context_package_sources_required_check" CHECK(
		NOT "required" OR "mount_state" = 'mounted'
	),
	CONSTRAINT "dopaios_context_package_sources_content_bytes_check" CHECK(
		"mount_state" <> 'mounted' OR "content_bytes" = octet_length("content")
	)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dopaios_require_context_package_totals"(
	target_package_id text,
	target_package_revision integer
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
	declared_bytes integer;
	declared_tokens integer;
	mounted_bytes bigint;
	mounted_tokens bigint;
BEGIN
	SELECT p.total_bytes, p.total_tokens,
		coalesce(sum(CASE WHEN s.mount_state = 'mounted' THEN s.content_bytes ELSE 0 END), 0),
		coalesce(sum(CASE WHEN s.mount_state = 'mounted' THEN s.token_count ELSE 0 END), 0)
	INTO declared_bytes, declared_tokens, mounted_bytes, mounted_tokens
	FROM dopaios_context_packages p
	LEFT JOIN dopaios_context_package_sources s
		ON s.context_package_id = p.id AND s.context_package_revision = p.revision
	WHERE p.id = target_package_id AND p.revision = target_package_revision
	GROUP BY p.total_bytes, p.total_tokens;

	IF NOT FOUND THEN
		RETURN;
	END IF;
	IF declared_bytes <> mounted_bytes OR declared_tokens <> mounted_tokens THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = format(
				'Context Package %s@%s totals do not equal mounted source totals',
				target_package_id,
				target_package_revision
			);
	END IF;
	RETURN;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "dopaios_check_context_package_totals"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_TABLE_NAME = 'dopaios_context_packages' THEN
		PERFORM "dopaios_require_context_package_totals"(NEW.id, NEW.revision);
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM "dopaios_require_context_package_totals"(
			OLD.context_package_id,
			OLD.context_package_revision
		);
	ELSE
		PERFORM "dopaios_require_context_package_totals"(
			NEW.context_package_id,
			NEW.context_package_revision
		);
		IF TG_OP = 'UPDATE' AND (
			OLD.context_package_id IS DISTINCT FROM NEW.context_package_id
			OR OLD.context_package_revision IS DISTINCT FROM NEW.context_package_revision
		) THEN
			PERFORM "dopaios_require_context_package_totals"(
				OLD.context_package_id,
				OLD.context_package_revision
			);
		END IF;
	END IF;
	RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "dopaios_context_packages_totals_trigger"
	AFTER INSERT OR UPDATE ON "dopaios_context_packages"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "dopaios_check_context_package_totals"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "dopaios_context_package_sources_totals_trigger"
	AFTER INSERT OR UPDATE OR DELETE ON "dopaios_context_package_sources"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION "dopaios_check_context_package_totals"();
--> statement-breakpoint
ALTER TABLE "dopaios_execution_contracts"
	ADD CONSTRAINT "dopaios_execution_contracts_context_package_fk"
	FOREIGN KEY("context_package_id", "context_package_revision", "context_package_sha256")
	REFERENCES "dopaios_context_packages"("id", "revision", "sha256");
--> statement-breakpoint
ALTER TABLE "dopaios_activations"
	ADD CONSTRAINT "dopaios_activations_context_package_fk"
	FOREIGN KEY("context_package_id", "context_package_revision", "context_package_sha256")
	REFERENCES "dopaios_context_packages"("id", "revision", "sha256");
--> statement-breakpoint
ALTER TABLE "dopaios_ai_sessions"
	ADD CONSTRAINT "dopaios_ai_sessions_context_package_fk"
	FOREIGN KEY("context_package_id", "context_package_revision", "context_package_sha256")
	REFERENCES "dopaios_context_packages"("id", "revision", "sha256");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_artifact_project_scopes" (
	"artifact_id" text NOT NULL,
	"artifact_revision" integer NOT NULL,
	"project_id" text NOT NULL,
	"scope_state" text NOT NULL,
	"bound_by" text NOT NULL,
	CONSTRAINT "dopaios_artifact_project_scopes_pk" PRIMARY KEY(
		"artifact_id", "artifact_revision", "project_id"
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_context_sources_project_idx"
	ON "dopaios_context_package_sources" ("project_id", "context_package_id", "context_package_revision");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_connector_policies" (
	"policy_id" text NOT NULL,
	"policy_revision" integer NOT NULL,
	"configuration" jsonb NOT NULL,
	"scope_level" text NOT NULL,
	"precedence" jsonb NOT NULL,
	"approver_capability" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"invalidation" jsonb NOT NULL,
	"connector_id" text NOT NULL,
	"connector_version" text NOT NULL,
	"project_id" text NOT NULL,
	"purpose" text NOT NULL,
	"action" text NOT NULL,
	"direction" text NOT NULL,
	"auth_type" text NOT NULL,
	"credential_ref" jsonb NOT NULL,
	"runtime" text NOT NULL,
	"environment" text NOT NULL,
	"data_classes" jsonb NOT NULL,
	"lifecycle_policy_ref" jsonb NOT NULL,
	"retention_policy_ref" jsonb NOT NULL,
	"scopes" jsonb NOT NULL,
	"rate_limit" jsonb NOT NULL,
	"timeout_ms" integer NOT NULL,
	"interruption" jsonb NOT NULL,
	"retry" jsonb NOT NULL,
	"backoff" jsonb NOT NULL,
	"circuit_breaker" jsonb NOT NULL,
	"idempotency" jsonb NOT NULL,
	"reconciliation" jsonb NOT NULL,
	"fallback" jsonb NOT NULL,
	"audit" jsonb NOT NULL,
	"redaction" jsonb NOT NULL,
	"approval_ref" jsonb NOT NULL,
	"state" text NOT NULL,
	"sha256" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "dopaios_connector_policies_pk" PRIMARY KEY("policy_id", "policy_revision"),
	CONSTRAINT "dopaios_connector_policies_exact_ref_uniq" UNIQUE(
		"policy_id", "policy_revision", "sha256"
	),
	CONSTRAINT "dopaios_connector_policies_audit_scope_uniq" UNIQUE(
		"policy_id", "policy_revision", "sha256", "project_id",
		"connector_id", "connector_version", "purpose", "action", "direction"
	),
	CONSTRAINT "dopaios_connector_policy_scope_uniq" UNIQUE(
		"connector_id", "connector_version", "project_id", "purpose", "action", "direction", "policy_revision"
	)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_connector_audit_events" (
	"id" text PRIMARY KEY,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"connector_version" text NOT NULL,
	"purpose" text NOT NULL,
	"action" text NOT NULL,
	"direction" text NOT NULL,
	"policy_id" text,
	"policy_revision" integer,
	"policy_sha256" text,
	"runtime" text,
	"environment" text,
	"approval_ref" jsonb,
	"fallback_context_ref" jsonb,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"request_id" text NOT NULL,
	"request_summary" jsonb NOT NULL,
	"response_summary" jsonb,
	"retry_class" text NOT NULL,
	"attempt" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dopaios_connector_audit_policy_complete" CHECK(
		num_nonnulls("policy_id", "policy_revision", "policy_sha256") IN (0, 3)
	),
	CONSTRAINT "dopaios_connector_audit_policy_fk" FOREIGN KEY(
		"policy_id", "policy_revision", "policy_sha256"
	) REFERENCES "dopaios_connector_policies"("policy_id", "policy_revision", "sha256"),
	CONSTRAINT "dopaios_connector_audit_policy_scope_fk" FOREIGN KEY(
		"policy_id", "policy_revision", "policy_sha256", "project_id",
		"connector_id", "connector_version", "purpose", "action", "direction"
	) REFERENCES "dopaios_connector_policies"(
		"policy_id", "policy_revision", "sha256", "project_id",
		"connector_id", "connector_version", "purpose", "action", "direction"
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_connector_audit_project_idx"
	ON "dopaios_connector_audit_events" ("project_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_dkp_chunks" (
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"chunk_id" text NOT NULL,
	"project_id" text NOT NULL,
	"context_package_id" text NOT NULL,
	"context_package_revision" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"range_unit" text NOT NULL,
	"content" text NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED,
	"embedding" real[] NOT NULL,
	"embedding_model_ref" jsonb NOT NULL,
	"index_version" text NOT NULL,
	CONSTRAINT "dopaios_dkp_chunks_pk" PRIMARY KEY(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "chunk_id", "index_version"
	),
	CONSTRAINT "dopaios_dkp_chunks_ordinal_uniq" UNIQUE(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "index_version", "ordinal"
	),
	CONSTRAINT "dopaios_dkp_chunks_range_check" CHECK(
		"ordinal" >= 0 AND "char_start" >= 0 AND "char_end" > "char_start"
		AND "range_unit" = 'utf16-code-unit'
	),
	CONSTRAINT "dopaios_dkp_chunks_source_fk" FOREIGN KEY(
		"project_id", "context_package_id", "context_package_revision", "source_id", "source_revision"
	) REFERENCES "dopaios_context_package_sources"(
		"project_id", "context_package_id", "context_package_revision", "source_id", "source_revision"
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_dkp_chunks_search_idx"
	ON "dopaios_dkp_chunks" USING gin ("search_vector");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_dkp_chunks_scope_idx"
	ON "dopaios_dkp_chunks" ("project_id", "context_package_id", "context_package_revision");
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector' AND extversion = '0.8.6') THEN
		EXECUTE 'ALTER TABLE "dopaios_dkp_chunks" ALTER COLUMN "embedding" TYPE vector(4) USING "embedding"::vector(4)';
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_retrieval_queries" (
	"id" text PRIMARY KEY,
	"session_id" text NOT NULL,
	"project_id" text NOT NULL,
	"context_package_id" text NOT NULL,
	"context_package_revision" integer NOT NULL,
	"context_package_sha256" text NOT NULL,
	"query_sha256" text NOT NULL,
	"query_redacted" text NOT NULL,
	"method" text NOT NULL,
	"index_version" text NOT NULL,
	"embedding_model_ref" jsonb NOT NULL,
	"policy_decision" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "dopaios_retrieval_queries_provenance_uniq" UNIQUE(
		"id", "project_id", "context_package_id", "context_package_revision", "context_package_sha256"
	),
	CONSTRAINT "dopaios_retrieval_queries_package_fk" FOREIGN KEY(
		"project_id", "context_package_id", "context_package_revision", "context_package_sha256"
	) REFERENCES "dopaios_context_packages"("project_id", "id", "revision", "sha256"),
	CONSTRAINT "dopaios_retrieval_queries_session_package_fk" FOREIGN KEY(
		"session_id", "context_package_id", "context_package_revision", "context_package_sha256"
	) REFERENCES "dopaios_ai_sessions"(
		"id", "context_package_id", "context_package_revision", "context_package_sha256"
	)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_retrieval_hits" (
	"query_id" text NOT NULL,
	"rank" integer NOT NULL,
	"project_id" text NOT NULL,
	"context_package_id" text NOT NULL,
	"context_package_revision" integer NOT NULL,
	"context_package_sha256" text NOT NULL,
	"source_id" text NOT NULL,
	"source_revision" integer NOT NULL,
	"source_sha256" text NOT NULL,
	"chunk_id" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"range_unit" text NOT NULL,
	"excerpt" text NOT NULL,
	"method" text NOT NULL,
	"index_version" text NOT NULL,
	"embedding_model_ref" jsonb NOT NULL,
	"score" double precision NOT NULL,
	"policy_decision" text NOT NULL,
	CONSTRAINT "dopaios_retrieval_hits_pk" PRIMARY KEY("query_id", "rank"),
	CONSTRAINT "dopaios_retrieval_hits_query_chunk_uniq" UNIQUE(
		"query_id", "project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "chunk_id", "index_version"
	),
	CONSTRAINT "dopaios_retrieval_hits_query_fk" FOREIGN KEY(
		"query_id", "project_id", "context_package_id", "context_package_revision", "context_package_sha256"
	) REFERENCES "dopaios_retrieval_queries"(
		"id", "project_id", "context_package_id", "context_package_revision", "context_package_sha256"
	),
	CONSTRAINT "dopaios_retrieval_hits_package_fk" FOREIGN KEY(
		"project_id", "context_package_id", "context_package_revision", "context_package_sha256"
	) REFERENCES "dopaios_context_packages"("project_id", "id", "revision", "sha256"),
	CONSTRAINT "dopaios_retrieval_hits_source_fk" FOREIGN KEY(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "source_sha256"
	) REFERENCES "dopaios_context_package_sources"(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "source_sha256"
	),
	CONSTRAINT "dopaios_retrieval_hits_chunk_fk" FOREIGN KEY(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "chunk_id", "index_version"
	) REFERENCES "dopaios_dkp_chunks"(
		"project_id", "context_package_id", "context_package_revision",
		"source_id", "source_revision", "chunk_id", "index_version"
	)
);
