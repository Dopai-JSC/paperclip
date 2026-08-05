// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Kc10OperationalJourney,
  Kc10RouteSwitch,
  buildKc10JourneyRequest,
  isKc10VerificationUiEnabled,
} from "./Kc10OperationalJourney";

const mockKc10Api = vi.hoisted(() => ({
  listObjects: vi.fn(),
}));

vi.mock("@/api/kc10", () => ({ kc10Api: mockKc10Api }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-kc10",
    selectedCompany: { id: "company-kc10", issuePrefix: "KC" },
  }),
}));

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitForText(container: HTMLElement, text: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (container.textContent?.includes(text)) return;
    await flushReact();
  }
  expect(container.textContent).toContain(text);
}

describe("KC-10 operational journeys", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockKc10Api.listObjects.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("maps all five journeys to bounded operational queries", () => {
    expect(buildKc10JourneyRequest("project-list", {}, new URLSearchParams())).toEqual({
      kinds: ["project"], limit: 50, offset: 0,
    });
    expect(buildKc10JourneyRequest("project-detail", { projectId: "project-7" }, new URLSearchParams())).toEqual({
      objectId: "project-7", limit: 1, offset: 0,
    });
    expect(buildKc10JourneyRequest("action-inbox", {}, new URLSearchParams())).toEqual({
      kinds: ["action_request"], state: "open", limit: 50, offset: 0,
    });
    expect(buildKc10JourneyRequest("work-item", { issueId: "work-9" }, new URLSearchParams())).toEqual({
      objectId: "work-9", limit: 1, offset: 0,
    });
    expect(buildKc10JourneyRequest("search", {}, new URLSearchParams("q=invoice&kind=decision&ownerId=STAFF-01"))).toEqual({
      query: "invoice", kinds: ["decision"], ownerId: "STAFF-01", limit: 50, offset: 0,
    });
  });

  it("keeps the native route unless verification mode is explicit", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={["/projects"]}>
          <Kc10RouteSwitch journey="project-list" fallback={<p>Native projects</p>} />
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("Native projects");
    expect(mockKc10Api.listObjects).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });

  it("requires the build-time verification gate even when the query flag is present", () => {
    expect(isKc10VerificationUiEnabled(undefined)).toBe(false);
    expect(isKc10VerificationUiEnabled("false")).toBe(false);
    expect(isKc10VerificationUiEnabled("true")).toBe(true);

    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <MemoryRouter initialEntries={["/projects?kc10=1"]}>
          <Kc10RouteSwitch journey="project-list" enabled={false} fallback={<p>Native projects</p>} />
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toContain("Native projects");
    expect(mockKc10Api.listObjects).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });

  it("renders an accessible, source-linked page and exposes readiness", async () => {
    mockKc10Api.listObjects.mockResolvedValue({
      indexState: "complete",
      items: [{
        objectId: "project-1",
        stableId: "PROJECT-001",
        kind: "project",
        projectId: "project-1",
        title: "Project 001",
        state: "active",
        ownerId: null,
        occurredAt: "2026-07-07T00:00:00.000Z",
        sourceHref: "/projects/project-1?kc10=1",
        metadata: {},
      }],
      hasMore: false,
      limit: 50,
      offset: 0,
      correlationId: "correlation-1",
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/projects?kc10=1"]}>
            <Routes>
              <Route path="/projects" element={<Kc10OperationalJourney journey="project-list" />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await waitForText(container, "Project 001");
    const main = container.querySelector("main");
    expect(main?.getAttribute("data-kc10-ready")).toBe("true");
    expect(main?.getAttribute("aria-labelledby")).toBe("kc10-project-list-title");
    expect(container.querySelector("a")?.getAttribute("href")).toContain("/projects/project-1?kc10=1");
    expect(mockKc10Api.listObjects).toHaveBeenCalledWith("company-kc10", {
      kinds: ["project"], limit: 50, offset: 0,
    });
    flushSync(() => root.unmount());
  });

  it("announces a partial projection instead of presenting incomplete data as complete", async () => {
    mockKc10Api.listObjects.mockResolvedValue({
      indexState: "partial", items: [], hasMore: false, limit: 50, offset: 0,
      correlationId: "correlation-2",
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/search?kc10=1"]}>
            <Kc10OperationalJourney journey="search" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitForText(container, "partial");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("partial");
    expect(container.querySelector("main")?.getAttribute("data-kc10-ready")).toBe("false");
    flushSync(() => root.unmount());
  });
});
