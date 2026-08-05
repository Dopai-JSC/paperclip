import { api } from "./client";

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

export interface Kc10ObjectQuery {
  objectId?: string;
  kinds?: string[];
  projectId?: string;
  state?: string;
  ownerId?: string;
  query?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface Kc10ObjectPage {
  indexState: "complete" | "partial" | "error";
  items: Kc10OperationalObject[];
  hasMore: boolean;
  limit: number;
  offset: number;
  correlationId: string;
}

function append(params: URLSearchParams, key: string, value: string | undefined) {
  if (value) params.set(key, value);
}

export const kc10Api = {
  listObjects(companyId: string, query: Kc10ObjectQuery) {
    const params = new URLSearchParams();
    append(params, "objectId", query.objectId);
    append(params, "kind", query.kinds?.join(","));
    append(params, "projectId", query.projectId);
    append(params, "state", query.state);
    append(params, "ownerId", query.ownerId);
    append(params, "q", query.query);
    append(params, "from", query.from);
    append(params, "to", query.to);
    params.set("limit", String(Math.max(1, Math.min(50, Math.trunc(query.limit ?? 50)))));
    params.set("offset", String(Math.max(0, Math.trunc(query.offset ?? 0))));
    return api.get<Kc10ObjectPage>(
      `/companies/${encodeURIComponent(companyId)}/kc10/objects?${params.toString()}`,
    );
  },
};
