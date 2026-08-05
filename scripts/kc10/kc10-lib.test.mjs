import assert from "node:assert/strict";
import test from "node:test";
import {
  JOURNEYS,
  assertPinnedBrowserEvidence,
  allRecordedFocusVisible,
  assertOfficialWorkload,
  extractPrimaryJsAsset,
  nearestRankPercentile,
  summarizeOfficialSamples,
  staffCapabilityUrl,
  standardPermissionPayload,
} from "./kc10-lib.mjs";

test("application provenance resolves exactly one primary JavaScript asset", () => {
  assert.equal(
    extractPrimaryJsAsset('<script type="module" src="/assets/index-Cf2wGGon.js"></script>'),
    "/assets/index-Cf2wGGon.js",
  );
  assert.throws(() => extractPrimaryJsAsset("<html></html>"));
  assert.throws(() => extractPrimaryJsAsset(
    '<script src="/assets/index-one.js"></script><script src="/assets/index-two.js"></script>',
  ));
});

test("browser evidence accepts only the four policy-pinned official binaries", () => {
  assert.doesNotThrow(() => assertPinnedBrowserEvidence({
    id: "chrome-150",
    version: "Google Chrome for Testing 150.0.7871.187",
  }));
  assert.doesNotThrow(() => assertPinnedBrowserEvidence({
    id: "edge-149",
    version: "Microsoft Edge 149.0.4022.98",
  }));
  assert.doesNotThrow(() => assertPinnedBrowserEvidence({
    id: "edge-150",
    version: "Microsoft Edge 150.0.4078.105 unknown",
    productVersion: "150.0.4078.105",
  }));
  assert.throws(() => assertPinnedBrowserEvidence({
    id: "chrome-150",
    version: "HeadlessChrome 150.0.7871.187",
  }));
  assert.throws(() => assertPinnedBrowserEvidence({
    id: "edge-149",
    version: "Microsoft Edge 150.0.4078.105",
  }));
  assert.throws(() => assertPinnedBrowserEvidence({
    id: "edge-150",
    version: "Microsoft Edge 150.0.4078.105 unknown",
    productVersion: "149.0.4022.98",
  }));
});

test("nearest-rank percentile does not average away a slow tail", () => {
  const values = Array.from({ length: 19 }, (_, index) => index + 1).concat(3_500);
  assert.equal(nearestRankPercentile(values, 0.95), 19);
  assert.equal(nearestRankPercentile(values, 1), 3_500);
});

test("official workload guard rejects shortened duration, concurrency, or sample floor", () => {
  assert.throws(() => assertOfficialWorkload({ users: 9, durationSeconds: 1_800, minimumSamples: 200 }));
  assert.throws(() => assertOfficialWorkload({ users: 10, durationSeconds: 1_799, minimumSamples: 200 }));
  assert.throws(() => assertOfficialWorkload({ users: 10, durationSeconds: 1_800, minimumSamples: 199 }));
  assert.doesNotThrow(() => assertOfficialWorkload({ users: 10, durationSeconds: 1_800, minimumSamples: 200 }));
});

test("summary excludes warm-up and evaluates every journey independently", () => {
  const samples = JOURNEYS.flatMap((journey) => [
    { phase: "warmup", journey, elapsedMs: 9_999, ok: true },
    ...Array.from({ length: 200 }, (_, index) => ({
      phase: "measure", journey, elapsedMs: index === 199 ? 2_900 : 100 + index, ok: true,
    })),
  ]);
  const summary = summarizeOfficialSamples(samples, { minimumSamples: 200, thresholdMs: 3_000 });
  for (const journey of JOURNEYS) {
    assert.equal(summary[journey].samples, 200);
    assert.equal(summary[journey].failures, 0);
    assert.equal(summary[journey].pass, true);
    assert.ok(summary[journey].p95Ms < 3_000);
  }
});

test("one failing journey cannot be hidden by a global percentile", () => {
  const samples = JOURNEYS.flatMap((journey) => Array.from({ length: 200 }, () => ({
    phase: "measure",
    journey,
    elapsedMs: journey === "work-item" ? 3_100 : 50,
    ok: true,
  })));
  const summary = summarizeOfficialSamples(samples, { minimumSamples: 200, thresholdMs: 3_000 });
  assert.equal(summary["work-item"].pass, false);
  assert.equal(summary["project-list"].pass, true);
});

test("staff capability journey opens the configuration tab", () => {
  assert.equal(
    staffCapabilityUrl("http://172.26.14.51:3100", "KC10", "agent-1"),
    "http://172.26.14.51:3100/KC10/agents/agent-1/configuration",
  );
});

test("staff capability cleanup restores a deterministic Standard permission baseline", () => {
  assert.deepEqual(standardPermissionPayload({
    permissions: {
      canCreateAgents: true,
      canCreateSkills: false,
      canAssignTasks: true,
      trustPreset: "low_trust_review",
      authorizationPolicy: { trustPreset: "low_trust_review" },
    },
  }), {
    canCreateAgents: true,
    canCreateSkills: false,
    canAssignTasks: true,
    trustPreset: "standard",
    authorizationPolicy: {},
  });
});

test("keyboard acceptance rejects any intermediate focus event without a visible indicator", () => {
  assert.equal(allRecordedFocusVisible([
    { active: { focusVisible: true } },
    { active: { focusVisible: true } },
  ]), true);
  assert.equal(allRecordedFocusVisible([
    { active: { focusVisible: true } },
    { active: { focusVisible: false } },
  ]), false);
  assert.equal(allRecordedFocusVisible([{ active: null }]), false);
});
