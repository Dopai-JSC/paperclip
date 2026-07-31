import type { Pool } from "pg";
import { PostgresSessionStore } from "./PostgresSessionStore.js";
import type { SessionKey, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

// Lớp Dopai sở hữu, đặt trên bản chép verbatim PostgresSessionStore:
// SDK retry append tối đa 3 lần nên cùng một entry có thể tới nhiều lần —
// bản mẫu insert trần sẽ nhân bản entry. Ở đây dedupe theo entry->>'uuid'
// bằng unique index bộ phận + ON CONFLICT DO NOTHING; entry không có uuid
// (hiếm — dòng metadata) giữ nguyên ngữ nghĩa append của bản mẫu.

export class DopaiosSessionStore extends PostgresSessionStore {
  private readonly dedupePool: Pool;
  private readonly dedupeTable: string;

  constructor(opts: { pool: Pool; tableName?: string }) {
    super(opts);
    this.dedupePool = opts.pool;
    const t = opts.tableName ?? "claude_session_entries";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
      throw new Error(`invalid tableName: ${t}`);
    }
    this.dedupeTable = t;
  }

  override async ensureSchema(): Promise<void> {
    await super.ensureSchema();
    await this.dedupePool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${this.dedupeTable}_entry_uuid_uniq
        ON ${this.dedupeTable} (project_key, session_id, COALESCE(subpath, ''), (entry->>'uuid'))
        WHERE entry ? 'uuid'
    `);
  }

  override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const withUuid = entries.filter((e) => typeof (e as Record<string, unknown>)["uuid"] === "string");
    const withoutUuid = entries.filter((e) => typeof (e as Record<string, unknown>)["uuid"] !== "string");
    if (withUuid.length > 0) {
      const params: unknown[] = [key.projectKey, key.sessionId, key.subpath ?? null];
      const rows = withUuid.map((e, i) => {
        params.push(JSON.stringify(e));
        return `($1,$2,$3,$${4 + i}::jsonb)`;
      });
      await this.dedupePool.query(
        `INSERT INTO ${this.dedupeTable} (project_key, session_id, subpath, entry)
         VALUES ${rows.join(",")}
         ON CONFLICT (project_key, session_id, COALESCE(subpath, ''), (entry->>'uuid'))
           WHERE entry ? 'uuid'
         DO NOTHING`,
        params,
      );
    }
    if (withoutUuid.length > 0) {
      await super.append(key, withoutUuid);
    }
  }
}
