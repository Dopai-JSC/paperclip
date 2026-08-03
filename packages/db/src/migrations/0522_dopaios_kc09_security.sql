-- 0522: KC-09 — retention/hold controls and database-enforced audit safety.
-- The first slice adds the event-projected retention control to each
-- workspace. Runtime-role restrictions for immutable record stores are added
-- in the audit-immutability batch of the same KC migration.
ALTER TABLE "dopaios_workspaces"
	ADD COLUMN IF NOT EXISTS "retention_control" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_authorization_audit_events" (
	"id" text PRIMARY KEY,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"company_id" text NOT NULL,
	"project_id" text,
	"action" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dopaios_authorization_audit_scope_idx"
	ON "dopaios_authorization_audit_events" ("company_id", "project_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dopaios_connector_credentials" (
	"secret_ref" text NOT NULL,
	"rotation_epoch" integer NOT NULL,
	"issued_at" timestamptz NOT NULL,
	"expires_at" timestamptz NOT NULL,
	"revoked_at" timestamptz,
	"last_actor_id" text,
	CONSTRAINT "dopaios_connector_credentials_pk" PRIMARY KEY("secret_ref", "rotation_epoch"),
	CONSTRAINT "dopaios_connector_credentials_ttl" CHECK ("expires_at" > "issued_at")
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dopaios_runtime_actor') THEN
		CREATE ROLE dopaios_runtime_actor
			NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
	ELSE
		ALTER ROLE dopaios_runtime_actor
			NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
	END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA message_store, public TO dopaios_runtime_actor;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
	message_store.messages,
	public.dopaios_authorization_audit_events,
	public.dopaios_connector_audit_events,
	public.dopaios_gate_records
TO dopaios_runtime_actor;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE message_store.messages_global_position_seq TO dopaios_runtime_actor;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.dopaios_connector_credentials TO dopaios_runtime_actor;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
	message_store.messages,
	public.dopaios_authorization_audit_events,
	public.dopaios_connector_audit_events,
	public.dopaios_gate_records
FROM dopaios_runtime_actor, PUBLIC;
