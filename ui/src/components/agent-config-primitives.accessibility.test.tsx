// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HintIcon, ToggleWithNumber } from "./agent-config-primitives";

describe("agent config accessibility primitives", () => {
  it("names help buttons from their help text", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HintIcon text="Explains adapter type" />
      </TooltipProvider>,
    );

    expect(html).toContain('aria-label="Help: Explains adapter type"');
  });

  it("names the switch rendered by ToggleWithNumber", () => {
    const html = renderToStaticMarkup(
      <ToggleWithNumber
        label="Heartbeat on interval"
        checked={false}
        onCheckedChange={vi.fn()}
        number={60}
        onNumberChange={vi.fn()}
        numberLabel="seconds"
        showNumber={false}
      />,
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="Heartbeat on interval"');
  });
});
