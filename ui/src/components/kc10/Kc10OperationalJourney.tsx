import { useEffect, useMemo, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { kc10Api, type Kc10ObjectQuery, type Kc10OperationalObject } from "@/api/kc10";
import { useCompany } from "@/context/CompanyContext";
import { Link, useParams, useSearchParams } from "@/lib/router";

export type Kc10Journey =
  | "project-list"
  | "project-detail"
  | "action-inbox"
  | "work-item"
  | "search";

export function isKc10VerificationUiEnabled(value = import.meta.env.VITE_DOPAIOS_KC10_ENABLED) {
  return value === "true";
}

type JourneyParams = { projectId?: string; issueId?: string };

const TITLES: Record<Kc10Journey, string> = {
  "project-list": "Projects",
  "project-detail": "Project",
  "action-inbox": "Action inbox",
  "work-item": "Work item",
  search: "Operational search",
};

function searchValue(params: URLSearchParams, key: string): string | undefined {
  return params.get(key)?.trim() || undefined;
}

export function buildKc10JourneyRequest(
  journey: Kc10Journey,
  route: JourneyParams,
  search: URLSearchParams,
): Kc10ObjectQuery {
  const offset = Math.max(0, Number.parseInt(search.get("offset") ?? "0", 10) || 0);
  const common = {
    state: searchValue(search, "state"),
    ownerId: searchValue(search, "ownerId"),
    from: searchValue(search, "from"),
    to: searchValue(search, "to"),
  };

  if (journey === "project-detail") {
    return { objectId: route.projectId, limit: 1, offset: 0 };
  }
  if (journey === "work-item") {
    return { objectId: route.issueId, limit: 1, offset: 0 };
  }
  if (journey === "project-list") {
    return { kinds: ["project"], limit: 50, offset };
  }
  if (journey === "action-inbox") {
    return { kinds: ["action_request"], state: common.state ?? "open", limit: 50, offset };
  }
  const kind = searchValue(search, "kind");
  return {
    query: searchValue(search, "q"),
    kinds: kind ? [kind] : undefined,
    ...common,
    limit: 50,
    offset,
  };
}

function mark(name: string, detail: Record<string, string>) {
  try {
    performance.mark(name, { detail });
  } catch {
    performance.mark?.(name);
  }
}

export function markKc10Command(journey: Kc10Journey, source: string) {
  const prefix = `kc10:${journey}`;
  try {
    performance.clearMarks?.(`${prefix}:command`);
    performance.clearMarks?.(`${prefix}:usable`);
    performance.clearMeasures?.(`${prefix}:e2e`);
    mark(`${prefix}:command`, { journey, source });
  } catch {
    // Performance marks are evidence aids; an unsupported API must not break navigation.
  }
}

function markUsable(journey: Kc10Journey, correlationId: string) {
  const prefix = `kc10:${journey}`;
  try {
    if (performance.getEntriesByName?.(`${prefix}:command`).length === 0) {
      markKc10Command(journey, "direct-load");
    }
    mark(`${prefix}:usable`, { journey, correlationId });
    performance.measure(`${prefix}:e2e`, `${prefix}:command`, `${prefix}:usable`);
  } catch {
    // Keep the product surface usable if a browser omits User Timing details.
  }
}

function ItemCard({ item }: { item: Kc10OperationalObject }) {
  return (
    <article className="rounded-lg border border-border bg-card p-4" aria-labelledby={`kc10-item-${item.objectId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.kind.replaceAll("_", " ")}</p>
          <h2 id={`kc10-item-${item.objectId}`} className="text-base font-semibold">
            <Link
              className="rounded-sm underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to={item.sourceHref}
            >
              {item.title}
            </Link>
          </h2>
          <p className="font-mono text-xs text-muted-foreground">{item.stableId}</p>
        </div>
        <span className="rounded-full border px-2 py-1 text-xs font-medium">State: {item.state}</span>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <div><dt className="text-muted-foreground">Project</dt><dd className="font-mono text-xs">{item.projectId}</dd></div>
        <div><dt className="text-muted-foreground">Owner</dt><dd>{item.ownerId ?? "Unassigned"}</dd></div>
        <div><dt className="text-muted-foreground">Occurred</dt><dd>{new Date(item.occurredAt).toISOString()}</dd></div>
      </dl>
    </article>
  );
}

function FilterForm({ journey, search, update }: {
  journey: Kc10Journey;
  search: URLSearchParams;
  update: (next: URLSearchParams) => void;
}) {
  if (journey === "project-detail" || journey === "work-item") return null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const next = new URLSearchParams(search);
    next.set("kc10", "1");
    for (const key of ["q", "kind", "state", "ownerId", "from", "to"]) {
      const value = String(values.get(key) ?? "").trim();
      if (value) next.set(key, value);
      else next.delete(key);
    }
    next.delete("offset");
    markKc10Command(journey, "filter-submit");
    update(next);
  };
  return (
    <form className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-3" onSubmit={submit}>
      <label className="grid gap-1 text-sm">Search<input name="q" defaultValue={search.get("q") ?? ""} className="rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <label className="grid gap-1 text-sm">Kind<input name="kind" defaultValue={search.get("kind") ?? ""} className="rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <label className="grid gap-1 text-sm">State<input name="state" defaultValue={search.get("state") ?? ""} className="rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <label className="grid gap-1 text-sm">Owner<input name="ownerId" defaultValue={search.get("ownerId") ?? ""} className="rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <label className="grid gap-1 text-sm">From (UTC)<input name="from" type="datetime-local" defaultValue={search.get("from") ?? ""} className="rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <label className="grid gap-1 text-sm">To (UTC)<input name="to" type="datetime-local" defaultValue={search.get("to") ?? ""} className="rounded-md border bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:col-span-3 md:justify-self-start">Apply filters</button>
    </form>
  );
}

export function Kc10OperationalJourney({ journey }: { journey: Kc10Journey }) {
  const { selectedCompanyId } = useCompany();
  const route = useParams<JourneyParams>();
  const [search, setSearch] = useSearchParams();
  const request = useMemo(
    () => buildKc10JourneyRequest(journey, route, search),
    [journey, route.projectId, route.issueId, search],
  );
  useEffect(() => {
    markKc10Command(journey, "route-mount");
  }, [journey]);
  const result = useQuery({
    queryKey: ["kc10-operational", selectedCompanyId, journey, request],
    queryFn: () => kc10Api.listObjects(selectedCompanyId!, request),
    enabled: Boolean(selectedCompanyId),
  });
  const ready = result.data?.indexState === "complete" && result.isSuccess;
  useEffect(() => {
    if (ready && result.data) markUsable(journey, result.data.correlationId);
  }, [journey, ready, result.data]);

  const changePage = (offset: number) => {
    const next = new URLSearchParams(search);
    next.set("kc10", "1");
    if (offset > 0) next.set("offset", String(offset));
    else next.delete("offset");
    markKc10Command(journey, "pagination");
    setSearch(next);
  };
  const page = result.data;

  return (
    <main
      className="mx-auto grid w-full max-w-6xl gap-5 p-4 md:p-6"
      aria-labelledby={`kc10-${journey}-title`}
      data-kc10-journey={journey}
      data-kc10-ready={ready ? "true" : "false"}
    >
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">KC-10 operational journey</p>
        <h1 id={`kc10-${journey}-title`} className="text-2xl font-semibold">{TITLES[journey]}</h1>
      </header>
      <FilterForm journey={journey} search={search} update={setSearch} />
      {!selectedCompanyId ? <p role="alert">No company is selected.</p> : null}
      {result.isLoading ? <p role="status" aria-live="polite">Loading operational data…</p> : null}
      {result.isError ? <p role="alert">Operational data failed to load: {result.error.message}</p> : null}
      {page && page.indexState !== "complete" ? (
        <p role="alert" className="rounded-md border border-destructive p-3">
          Operational projection is {page.indexState}; results are not presented as complete.
        </p>
      ) : null}
      {page?.indexState === "complete" ? (
        <section aria-label={`${TITLES[journey]} results`} className="grid gap-3">
          {page.items.length === 0 ? <p>No accessible results match this request.</p> : null}
          {page.items.map((item) => <ItemCard key={item.objectId} item={item} />)}
        </section>
      ) : null}
      {page?.indexState === "complete" && (page.offset > 0 || page.hasMore) ? (
        <nav aria-label="Result pages" className="flex gap-3">
          <button type="button" disabled={page.offset === 0} onClick={() => changePage(Math.max(0, page.offset - page.limit))} className="rounded-md border px-3 py-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Previous</button>
          <button type="button" disabled={!page.hasMore} onClick={() => changePage(page.offset + page.limit)} className="rounded-md border px-3 py-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Next</button>
        </nav>
      ) : null}
      {page ? <p className="font-mono text-xs text-muted-foreground">Correlation: {page.correlationId}</p> : null}
    </main>
  );
}

export function Kc10RouteSwitch({
  journey,
  fallback,
  enabled = isKc10VerificationUiEnabled(),
}: {
  journey: Kc10Journey;
  fallback: ReactNode;
  enabled?: boolean;
}) {
  const [search] = useSearchParams();
  return enabled && search.get("kc10") === "1"
    ? <Kc10OperationalJourney journey={journey} />
    : fallback;
}
