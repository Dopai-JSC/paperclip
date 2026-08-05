// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar, AvatarFallback } from "./avatar";

describe("AvatarFallback", () => {
  it("uses a contrast-safe foreground on the muted background", () => {
    const html = renderToStaticMarkup(
      <Avatar><AvatarFallback>K0</AvatarFallback></Avatar>,
    );
    expect(html).toContain("bg-muted");
    expect(html).toContain("text-neutral-700");
    expect(html).not.toContain("text-muted-foreground");
  });
});
