export const JOURNEYS = [
  "project-list",
  "project-detail",
  "action-inbox",
  "work-item",
  "search",
];

export const PINNED_BROWSERS = Object.freeze({
  "chrome-150": "Google Chrome for Testing 150.0.7871.187",
  "chrome-149": "Google Chrome for Testing 149.0.7827.201",
  "edge-150": "Microsoft Edge 150.0.4078.105",
  "edge-149": "Microsoft Edge 149.0.4022.98",
});

export const PINNED_BROWSER_PACKAGES = Object.freeze({
  "chrome-150": Object.freeze({
    url: "https://storage.googleapis.com/chrome-for-testing-public/150.0.7871.187/linux64/chrome-linux64.zip",
    sha256: "898521a0356c5815342c5553f47cd230fcaa30076b83b28a0fb6cb4550ec5f1a",
  }),
  "chrome-149": Object.freeze({
    url: "https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.201/linux64/chrome-linux64.zip",
    sha256: "528800a1e74fbf42ff4d7768de5635fb0c4e1f3c070680f693d7dde6642d4415",
  }),
  "edge-150": Object.freeze({
    url: "https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable/microsoft-edge-stable_150.0.4078.105-1_amd64.deb",
    sha256: "7114192e2c7e8c12aeecb604b2732355e925716035729ebf8a0afe6895cdc01b",
  }),
  "edge-149": Object.freeze({
    url: "https://packages.microsoft.com/repos/edge/pool/main/m/microsoft-edge-stable/microsoft-edge-stable_149.0.4022.98-1_amd64.deb",
    sha256: "b4ce51b1eb017770b2682ae45daff09f9385d399373a5470cca1b383697136d2",
  }),
});

export function extractPrimaryJsAsset(html) {
  const matches = [...String(html).matchAll(/["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/g)];
  if (matches.length !== 1) {
    throw new Error(`application index must reference exactly one primary JavaScript asset; found ${matches.length}`);
  }
  return matches[0][1];
}

export function staffCapabilityUrl(baseUrl, companyPrefix, agentId) {
  return `${baseUrl}/${companyPrefix}/agents/${encodeURIComponent(agentId)}/configuration`;
}

export function standardPermissionPayload(agent) {
  const permissions = agent?.permissions ?? {};
  const authorizationPolicy = { ...(permissions.authorizationPolicy ?? {}) };
  delete authorizationPolicy.trustPreset;
  delete authorizationPolicy.reviewPreset;
  delete authorizationPolicy.trustBoundary;
  return {
    canCreateAgents: Boolean(permissions.canCreateAgents),
    canCreateSkills: permissions.canCreateSkills !== false,
    canAssignTasks: Boolean(permissions.canAssignTasks),
    trustPreset: "standard",
    authorizationPolicy,
  };
}

export function allRecordedFocusVisible(entries) {
  return Array.isArray(entries)
    && entries.length > 0
    && entries.every((entry) => entry?.active?.focusVisible === true);
}

export function assertPinnedBrowserEvidence({ id, version, productVersion }) {
  const expected = PINNED_BROWSERS[id];
  if (!expected) throw new Error(`browser ${id} is not in POL-NFR6-BROWSER-A11Y-001@1`);
  if (version === expected) return;
  const expectedProductVersion = expected.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  const extractedEdgePackage = id.startsWith("edge-") && version === `${expected} unknown`;
  if (extractedEdgePackage && productVersion === expectedProductVersion) return;
  throw new Error(
    `browser ${id} must report ${expected} (product ${expectedProductVersion}), received ${version}`
      + (productVersion ? ` (product ${productVersion})` : ""),
  );
}

export function nearestRankPercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("percentile requires samples");
  if (!(percentile > 0 && percentile <= 1)) throw new Error("percentile must be in (0, 1]");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

export function assertOfficialWorkload({ users, durationSeconds, minimumSamples }) {
  if (users !== 10) throw new Error(`official KC-10 workload requires 10 users, received ${users}`);
  if (durationSeconds < 1_800) {
    throw new Error(`official KC-10 workload requires 1800 seconds, received ${durationSeconds}`);
  }
  if (minimumSamples < 200) {
    throw new Error(`official KC-10 workload requires at least 200 samples per journey, received ${minimumSamples}`);
  }
}

export function summarizeOfficialSamples(samples, { minimumSamples = 200, thresholdMs = 3_000 } = {}) {
  return Object.fromEntries(JOURNEYS.map((journey) => {
    const measured = samples.filter((sample) => sample.phase === "measure" && sample.journey === journey);
    const successful = measured.filter((sample) => sample.ok);
    const failures = measured.length - successful.length;
    const p95Ms = successful.length > 0
      ? nearestRankPercentile(successful.map((sample) => sample.elapsedMs), 0.95)
      : null;
    return [journey, {
      samples: measured.length,
      successes: successful.length,
      failures,
      p50Ms: successful.length > 0
        ? nearestRankPercentile(successful.map((sample) => sample.elapsedMs), 0.5)
        : null,
      p95Ms,
      maxMs: successful.length > 0 ? Math.max(...successful.map((sample) => sample.elapsedMs)) : null,
      thresholdMs,
      minimumSamples,
      pass: measured.length >= minimumSamples && failures === 0 && p95Ms !== null && p95Ms <= thresholdMs,
    }];
  }));
}
