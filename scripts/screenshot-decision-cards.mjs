#!/usr/bin/env node
// Capture the Decisions queue surfaces for design review.
//
// Three surfaces per theme, matched to what the card change touches:
//   feed     — the collapsed list (colour, glyph, breadcrumb, spacing, radius)
//   resolver — an expanded approval (note field + decision verbs + toggle)
//   gallery  — an expanded row with evidence (thumbnail gallery layout)
//
// Usage: node scripts/screenshot-decision-cards.mjs <outDir> <prefix> [baseUrl]
//   node scripts/screenshot-decision-cards.mjs doc/design/decision-card-types after
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const [, , outDirArg, prefix, baseUrlArg] = process.argv;
if (!outDirArg || !prefix) {
  console.error("usage: screenshot-decision-cards.mjs <outDir> <prefix> [baseUrl]");
  process.exit(1);
}
const baseUrl = baseUrlArg || process.env.PAPERCLIP_URL || "http://localhost:3108";
const outDir = path.resolve(outDirArg);
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

/** Expand the first row whose source kind matches, and return whether it worked. */
async function expandRow(page, sourceKinds) {
  return page.evaluate(async (kinds) => {
    const rows = [...document.querySelectorAll("[data-attention-row]")];
    const row = rows.find((r) => kinds.includes(r.dataset.attentionSource));
    if (!row) return false;
    const toggle = row.querySelector('button[aria-label="Expand decision"]');
    if (!toggle) return false;
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    row.scrollIntoView({ block: "center" });
    return true;
  }, sourceKinds);
}

/**
 * Suppress the worktree banner at the source. It renders only when the served
 * HTML carries `paperclip-worktree-enabled=true` (see ui/src/lib/worktree-
 * branding.ts), and it prints the local instance and branch name — which must
 * never appear in a screenshot committed to a public repository. Rewriting the
 * meta tag on the document response removes the strip before React ever reads
 * it, rather than hiding it after paint and hoping the selector still matches.
 */
async function suppressWorktreeBanner(ctx) {
  const marker = 'name="paperclip-worktree-enabled" content="true"';
  let rewrote = false;
  await ctx.route(
    (url) => url.pathname === "/decisions" || url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      if (!html.includes(marker)) {
        // Either not a worktree instance, or the marker changed shape. Fail
        // loudly rather than silently shipping an unredacted screenshot.
        await route.fulfill({ response, body: html });
        return;
      }
      rewrote = true;
      await route.fulfill({
        response,
        body: html.replaceAll(marker, 'name="paperclip-worktree-enabled" content="false"'),
      });
    },
  );
  return () => rewrote;
}

/** Collapse every expanded row so each shot starts from a known state. */
async function collapseAll(page) {
  await page.evaluate(async () => {
    for (const button of [...document.querySelectorAll('button[aria-label="Collapse decision"]')]) {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const scroller = document.querySelector("main") ?? document.scrollingElement;
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

try {
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    });
    // Seed the app's own theme preference before first paint so the shot is not
    // taken mid-flash while ThemeContext hydrates.
    await ctx.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      ["paperclip.theme", theme],
    );
    const didRewrite = await suppressWorktreeBanner(ctx);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/decisions`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-attention-row]", { timeout: 30_000 });
    // The queue auto-expands its topmost inline row on mount.
    await page.waitForTimeout(1500);
    if (!didRewrite()) {
      throw new Error("worktree banner meta not found — refusing to shoot a possibly unredacted instance");
    }
    const bannerVisible = await page.evaluate(() =>
      [...document.querySelectorAll("body *")].some(
        (el) => /\bWORKTREE\b/i.test(el.textContent ?? "") && el.getBoundingClientRect().top < 40,
      ),
    );
    if (bannerVisible) throw new Error("worktree banner still rendered after suppression");

    await collapseAll(page);
    const feed = path.join(outDir, `${prefix}-${theme}-feed.png`);
    await page.screenshot({ path: feed });
    console.log(`Wrote ${feed}`);

    await collapseAll(page);
    if (await expandRow(page, ["approval"])) {
      await page.waitForTimeout(600);
      const resolver = path.join(outDir, `${prefix}-${theme}-resolver.png`);
      await page.screenshot({ path: resolver });
      console.log(`Wrote ${resolver}`);
    } else {
      console.warn(`No expandable approval row for ${theme}; skipped resolver shot`);
    }

    await collapseAll(page);
    if (await expandRow(page, ["review", "issue_thread_interaction"])) {
      await page.waitForTimeout(900);
      const gallery = path.join(outDir, `${prefix}-${theme}-gallery.png`);
      await page.screenshot({ path: gallery });
      console.log(`Wrote ${gallery}`);
    } else {
      console.warn(`No expandable evidence row for ${theme}; skipped gallery shot`);
    }

    await ctx.close();
  }
} finally {
  await browser.close();
}
