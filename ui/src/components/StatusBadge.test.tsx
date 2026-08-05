// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AgentStatusBadge, IssueStatusBadge, StatusBadge } from "./StatusBadge";
import { agentStatusVar, taskStatusVar } from "../lib/status-colors";

/**
 * Issue/task status chips carry the unified glyph and are recolored from the
 * `--status-task-*` base hue via the `.status-chip` color-mix helper.
 */
describe("IssueStatusBadge", () => {
  it("wires each issue status to its --status-task-* base hue, with a glyph", () => {
    for (const [status, cssVar] of Object.entries(taskStatusVar)) {
      const html = renderToStaticMarkup(<IssueStatusBadge status={status} />);
      expect(html).toContain("status-chip");
      expect(html).toContain("border");
      expect(html).toContain(`var(${cssVar})`);
      expect(html).toContain('viewBox="0 0 24 24"'); // unified glyph
    }
  });

  it("points in_progress at the blue liveness var and todo at the amber var", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="in_progress" />)).toContain("var(--status-task-in_progress)");
    expect(renderToStaticMarkup(<IssueStatusBadge status="todo" />)).toContain("var(--status-task-todo)");
  });

  it("sentence-cases the label and uses regular weight", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="in_review" />);
    expect(html).toContain("In review");
    expect(html).not.toContain("In Review"); // sentence case, not title case
    expect(html).toContain("font-normal");
    expect(html).not.toContain("font-medium");
  });

  it("strikes through cancelled chips", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="cancelled" />)).toContain("line-through");
  });

  it("falls back to the backlog (gray) var for unknown statuses", () => {
    expect(renderToStaticMarkup(<IssueStatusBadge status="mystery" />)).toContain("var(--status-task-backlog)");
  });

  it("renders task chips without depending on the chat flag", () => {
    const html = renderToStaticMarkup(<IssueStatusBadge status="todo" />);
    expect(html).toContain("status-chip");
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("Todo");
  });
});

/** Agent chips recolor from the `--status-agent-*` base hues. */
describe("AgentStatusBadge", () => {
  it("wires each agent status to its --status-agent-* base hue via status-chip", () => {
    for (const [status, cssVar] of Object.entries(agentStatusVar)) {
      const html = renderToStaticMarkup(<AgentStatusBadge status={status} />);
      expect(html).toContain("status-chip");
      expect(html).toContain(`var(${cssVar})`);
    }
  });

  it('renders "active" as the idle label', () => {
    expect(renderToStaticMarkup(<AgentStatusBadge status="active" />)).toContain("idle");
  });

  it("keeps the idle chip foreground above the 4.5:1 text contrast floor", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const match = css.match(/--status-agent-idle:\s*(#[0-9a-f]{6})/i);
    expect(match).not.toBeNull();

    const rgb = match![1].slice(1).match(/.{2}/g)!.map((value) => Number.parseInt(value, 16));
    const mix = (foreground: number[], background: number[], weight: number) =>
      foreground.map((value, index) => Math.round(value * weight + background[index] * (1 - weight)));
    const foreground = mix(rgb, [0, 0, 0], 0.82);
    const background = mix(rgb, [255, 255, 255], 0.15);
    const luminance = (color: number[]) => {
      const channels = color.map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const lighter = luminance(background);
    const darker = luminance(foreground);
    expect((lighter + 0.05) / (darker + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("StatusBadge", () => {
  it("uses the graduated brand hues", () => {
    expect(renderToStaticMarkup(<StatusBadge status="todo" />)).toContain("bg-amber-100");
    expect(renderToStaticMarkup(<StatusBadge status="in_progress" />)).toContain("bg-blue-100");
  });

  it("uses a contrast-safe foreground for neutral badges", () => {
    const html = renderToStaticMarkup(<StatusBadge status="planned" />);
    expect(html).toContain("bg-muted");
    expect(html).toContain("text-neutral-700");
    expect(html).not.toContain("text-muted-foreground");
  });
});
