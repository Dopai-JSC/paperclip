import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe : describe.skip;

describeDb("dopaios KC-09 database-enforced audit immutability", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc09-audit-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql`
      INSERT INTO message_store.messages (stream_name, type, position, data)
      VALUES ('kc09-audit-fixture', 'AuditFixture', 0, '{}'::jsonb)
    `);
    await db.execute(sql`
      INSERT INTO dopaios_connector_audit_events (
        id, project_id, actor_id, session_id, connector_id, connector_version,
        purpose, action, direction, decision, reason_code, request_id,
        request_summary, retry_class, attempt, created_at
      ) VALUES (
        'KC09-AUDIT-CONNECTOR', 'PROJECT-KC09', 'ACTOR-KC09', 'SESSION-KC09',
        'fixture', '1', 'audit-proof', 'read', 'egress', 'deny', 'fixture',
        'REQUEST-KC09', '{}'::jsonb, 'none', 0, CURRENT_TIMESTAMP
      )
    `);
    await db.execute(sql`
      INSERT INTO dopaios_authorization_audit_events (
        id, actor_type, actor_id, company_id, project_id, action, decision, reason
      ) VALUES (
        'KC09-AUDIT-AUTHORIZATION', 'agent', 'ACTOR-KC09', 'COMPANY-KC09',
        'PROJECT-KC09', 'issue:read', 'deny', 'deny_scope'
      )
    `);
    await db.execute(sql`
      INSERT INTO dopaios_gate_records (id, gate_name, point_id, approval_record_id)
      VALUES ('KC09-AUDIT-GATE', 'Cổng A', 'B0-12', 'APPROVAL-KC09-FIXTURE')
    `);
  }, 120_000);

  afterAll(async () => tempDb?.cleanup());

  it("defines one NOLOGIN runtime role as the database identity shared by system actors", async () => {
    const rows = (await db.execute(sql`
      SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = 'dopaios_runtime_actor'
    `)) as unknown as Array<{ rolname: string; rolcanlogin: boolean }>;
    expect(rows).toEqual([{ rolname: "dopaios_runtime_actor", rolcanlogin: false }]);
  });

  it("binds an ephemeral LOGIN principal to the runtime role without inheriting owner privileges", async () => {
    const loginRole = "kc09_runtime_login";
    const loginPassword = `kc09_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`
      CREATE ROLE ${loginRole}
        LOGIN PASSWORD '${loginPassword}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    `));
    const runtimeUrl = new URL(tempDb!.connectionString);
    runtimeUrl.username = loginRole;
    runtimeUrl.password = loginPassword;
    const runtimeDb = createDb(runtimeUrl.toString());
    try {
      const direct = (await runtimeDb.execute(sql.raw(`
        SELECT session_user, current_user,
               has_table_privilege(current_user, 'public.dopaios_authorization_audit_events', 'INSERT') AS insert_allowed
      `))) as unknown as Array<{
        session_user: string;
        current_user: string;
        insert_allowed: boolean;
      }>;
      expect(direct).toEqual([{
        session_user: loginRole,
        current_user: loginRole,
        insert_allowed: false,
      }]);

      let preGrantSqlState: string | undefined;
      try {
        await runtimeDb.execute(sql.raw("SET ROLE dopaios_runtime_actor"));
      } catch (error) {
        const databaseError = error as { code?: string; cause?: { code?: string } };
        preGrantSqlState = databaseError.code ?? databaseError.cause?.code;
      }
      expect(preGrantSqlState).toBe("42501");

      await db.execute(sql.raw(`GRANT dopaios_runtime_actor TO ${loginRole}`));
      const identity = await runtimeDb.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE dopaios_runtime_actor"));
        await tx.execute(sql`
          INSERT INTO dopaios_authorization_audit_events (
            id, actor_type, actor_id, company_id, project_id, action, decision, reason
          ) VALUES (
            'KC09-AUDIT-RUNTIME-LOGIN', 'machine', 'KC09-RUNTIME-LOGIN', 'COMPANY-KC09',
            'PROJECT-KC09', 'audit:append', 'allow', 'production-like local principal'
          )
        `);
        return tx.execute(sql.raw(`
          SELECT session_user, current_user, decision
          FROM public.dopaios_authorization_audit_events
          WHERE id = 'KC09-AUDIT-RUNTIME-LOGIN'
        `));
      });
      expect(identity).toEqual([{
        session_user: loginRole,
        current_user: "dopaios_runtime_actor",
        decision: "allow",
      }]);

      for (const operation of [
        "UPDATE public.dopaios_authorization_audit_events SET decision = 'deny' WHERE id = 'KC09-AUDIT-RUNTIME-LOGIN'",
        "DELETE FROM public.dopaios_authorization_audit_events WHERE id = 'KC09-AUDIT-RUNTIME-LOGIN'",
        "TRUNCATE public.dopaios_authorization_audit_events",
      ]) {
        let sqlState: string | undefined;
        try {
          await runtimeDb.transaction(async (tx) => {
            await tx.execute(sql.raw("SET LOCAL ROLE dopaios_runtime_actor"));
            await tx.execute(sql.raw(operation));
          });
        } catch (error) {
          const databaseError = error as { code?: string; cause?: { code?: string } };
          sqlState = databaseError.code ?? databaseError.cause?.code;
        }
        expect(sqlState, operation).toBe("42501");
      }
    } finally {
      await runtimeDb.$client.end();
      await db.execute(sql.raw(`DROP ROLE IF EXISTS ${loginRole}`));
    }
  });

  it("allows runtime reads but makes update and delete impossible on immutable record/audit stores", async () => {
    const immutableTargets = [
      {
        table: "message_store.messages",
        mutableColumn: "type",
        predicate: "stream_name = 'kc09-audit-fixture'",
      },
      {
        table: "public.dopaios_authorization_audit_events",
        mutableColumn: "decision",
        predicate: "id = 'KC09-AUDIT-AUTHORIZATION'",
      },
      {
        table: "public.dopaios_connector_audit_events",
        mutableColumn: "decision",
        predicate: "id = 'KC09-AUDIT-CONNECTOR'",
      },
      {
        table: "public.dopaios_gate_records",
        mutableColumn: "gate_name",
        predicate: "id = 'KC09-AUDIT-GATE'",
      },
    ] as const;
    for (const target of immutableTargets) {
      const selected = await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE dopaios_runtime_actor"));
        return tx.execute(sql.raw(`
          SELECT count(*)::int AS n,
                 current_user AS actor,
                 has_table_privilege(current_user, '${target.table}', 'UPDATE') AS update_allowed,
                 has_table_privilege(current_user, '${target.table}', 'DELETE') AS delete_allowed
          FROM ${target.table}
        `));
      });
      const access = (selected as unknown as Array<{
        n: number;
        actor: string;
        update_allowed: boolean;
        delete_allowed: boolean;
      }>)[0]!;
      expect(Number(access.n)).toBeGreaterThanOrEqual(0);
      expect(access).toMatchObject({
        actor: "dopaios_runtime_actor",
        update_allowed: false,
        delete_allowed: false,
      });
      for (const operation of ["UPDATE", "DELETE"] as const) {
        let sqlState: string | undefined;
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql.raw("SET LOCAL ROLE dopaios_runtime_actor"));
            await tx.execute(sql.raw(
              operation === "UPDATE"
                ? `UPDATE ${target.table} SET ${target.mutableColumn} = ${target.mutableColumn} WHERE ${target.predicate}`
                : `DELETE FROM ${target.table} WHERE ${target.predicate}`,
            ));
          });
        } catch (error) {
          const databaseError = error as { code?: string; cause?: { code?: string } };
          sqlState = databaseError.code ?? databaseError.cause?.code;
        }
        expect(sqlState, `${operation} ${target.table}`).toBe("42501");
      }
    }
  });
});
