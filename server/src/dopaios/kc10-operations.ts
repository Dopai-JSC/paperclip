import type { Db } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

export interface Kc10OperationalObject {
  objectId: string;
  stableId: string;
  kind: string;
  projectId: string;
  title: string;
  state: string;
  ownerId: string | null;
  occurredAt: string;
  sourceHref: string;
  metadata: Record<string, unknown>;
}

export interface ListKc10OperationalObjectsInput {
  companyId: string;
  userId: string;
  query?: string;
  kinds?: string[];
  projectId?: string;
  state?: string;
  ownerId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  objectId?: string;
}

export interface Kc10OperationalObjectPage {
  indexState: "complete" | "partial" | "error";
  items: Kc10OperationalObject[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

function parseTimestamp(value: string | undefined, field: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field} must be an ISO timestamp`);
  return parsed.toISOString();
}

function normalizeRow(row: Record<string, unknown>): Kc10OperationalObject {
  const occurredAt = row.occurred_at;
  return {
    objectId: String(row.object_id),
    stableId: String(row.stable_id),
    kind: String(row.kind),
    projectId: String(row.project_id),
    title: String(row.title),
    state: String(row.state),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    occurredAt: occurredAt instanceof Date ? occurredAt.toISOString() : String(occurredAt),
    sourceHref: String(row.source_href),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

export async function listKc10OperationalObjects(
  db: Db,
  input: ListKc10OperationalObjectsInput,
): Promise<Kc10OperationalObjectPage> {
  if (!input.companyId || !input.userId) throw new Error("companyId and userId are required");
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const from = parseTimestamp(input.from, "from");
  const to = parseTimestamp(input.to, "to");
  const conditions: SQL[] = [
    sql`object.company_id = ${input.companyId}`,
    sql`acl.user_id = ${input.userId}`,
    sql`acl.decision = 'allow'`,
  ];

  if (input.objectId) conditions.push(sql`object.object_id = ${input.objectId}`);
  if (input.projectId) conditions.push(sql`object.project_id = ${input.projectId}`);
  if (input.state) conditions.push(sql`object.state = ${input.state}`);
  if (input.ownerId) conditions.push(sql`object.owner_id = ${input.ownerId}`);
  if (from) conditions.push(sql`object.occurred_at >= ${from}::timestamptz`);
  if (to) conditions.push(sql`object.occurred_at <= ${to}::timestamptz`);
  if (input.kinds?.length) {
    conditions.push(sql`object.kind IN (${sql.join(input.kinds.map((kind) => sql`${kind}`), sql`, `)})`);
  }
  const query = input.query?.trim();
  if (query) {
    conditions.push(sql`(
      lower(object.stable_id) = lower(${query}) OR
      object.search_vector @@ websearch_to_tsquery('simple', ${query})
    )`);
  }

  const rows = await db.execute(sql`
    SELECT object.object_id, object.stable_id, object.kind, object.project_id,
           object.title, object.state, object.owner_id, object.occurred_at,
           object.source_href, object.metadata
    FROM dopaios_kc10_objects object
    JOIN dopaios_kc10_project_acl acl
      ON acl.company_id = object.company_id AND acl.project_id = object.project_id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY object.kind, object.stable_id
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `) as unknown as Array<Record<string, unknown>>;
  const stateRows = await db.execute(sql`
    SELECT projection_state
    FROM dopaios_kc10_dataset_runs
    WHERE company_id = ${input.companyId}
    ORDER BY generated_at DESC, dataset_id DESC
    LIMIT 1
  `) as unknown as Array<{ projection_state: "complete" | "partial" | "error" }>;

  return {
    indexState: stateRows[0]?.projection_state ?? "error",
    items: rows.slice(0, limit).map(normalizeRow),
    hasMore: rows.length > limit,
    limit,
    offset,
  };
}

export async function getKc10OperationalObject(
  db: Db,
  input: Pick<ListKc10OperationalObjectsInput, "companyId" | "userId" | "objectId">,
): Promise<Kc10OperationalObject | null> {
  const page = await listKc10OperationalObjects(db, { ...input, limit: 1 });
  return page.items[0] ?? null;
}
