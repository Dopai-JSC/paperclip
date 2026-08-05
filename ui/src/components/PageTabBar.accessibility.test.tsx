// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import { PageTabBar } from "./PageTabBar";

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

describe("PageTabBar accessibility", () => {
  it("can associate every route tab with a shared dynamic panel", () => {
    const html = renderToStaticMarkup(
      <Tabs value="configuration">
        <PageTabBar
          items={[
            { value: "dashboard", label: "Dashboard" },
            { value: "configuration", label: "Configuration" },
          ]}
          value="configuration"
          panelId="agent-view-panel"
        />
      </Tabs>,
    );

    expect(html.match(/aria-controls="agent-view-panel"/g)).toHaveLength(2);
  });

  it("preserves Radix panel associations when no shared panel is supplied", () => {
    const html = renderToStaticMarkup(
      <Tabs value="dashboard">
        <PageTabBar items={[{ value: "dashboard", label: "Dashboard" }]} />
      </Tabs>,
    );

    expect(html).toMatch(/aria-controls="radix-[^"]+-content-dashboard"/);
  });
});
