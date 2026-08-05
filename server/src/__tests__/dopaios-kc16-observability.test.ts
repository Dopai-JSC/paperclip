import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const metricsCli = fileURLToPath(
  new URL("../dopaios/emit-kc16-recovery-metrics.ts", import.meta.url),
);
const tsxLoader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

test("metrics CLI derives the recovery measurements from monotonic timestamps", () => {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
    encoding: "utf8",
    env: {
      ...process.env,
      KC16_FAULT_MONOTONIC_MS: "100000",
      KC16_DETECTION_MONOTONIC_MS: "103490",
      KC16_READINESS_MONOTONIC_MS: "480890",
      KC16_RPO_LOSS_COUNT: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    "# TYPE dopaios_kc16_detection_seconds gauge",
    "dopaios_kc16_detection_seconds 3.49",
    "# TYPE dopaios_kc16_rto_seconds gauge",
    "dopaios_kc16_rto_seconds 380.89",
    "# TYPE dopaios_kc16_rpo_loss_records gauge",
    "dopaios_kc16_rpo_loss_records 0",
    "# TYPE dopaios_kc16_objective_pass gauge",
    "dopaios_kc16_objective_pass 1",
    "",
  ].join("\n"));
});

test("metrics CLI accepts the exact inclusive detection and RTO boundaries", () => {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
    encoding: "utf8",
    env: {
      ...process.env,
      KC16_FAULT_MONOTONIC_MS: "0",
      KC16_DETECTION_MONOTONIC_MS: "300000",
      KC16_READINESS_MONOTONIC_MS: "14400000",
      KC16_RPO_LOSS_COUNT: "0",
    },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /dopaios_kc16_objective_pass 1\n$/u);
});

test("metrics CLI fails closed when a recovery objective is missed", () => {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
    encoding: "utf8",
    env: {
      ...process.env,
      KC16_FAULT_MONOTONIC_MS: "100000",
      KC16_DETECTION_MONOTONIC_MS: "400001",
      KC16_READINESS_MONOTONIC_MS: "480890",
      KC16_RPO_LOSS_COUNT: "0",
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stdout, /dopaios_kc16_objective_pass 0\n$/u);
});

test("metrics CLI fails closed for RTO and RPO breaches", () => {
  const baseEnv = {
    ...process.env,
    KC16_FAULT_MONOTONIC_MS: "100000",
    KC16_DETECTION_MONOTONIC_MS: "103490",
    KC16_READINESS_MONOTONIC_MS: "480890",
    KC16_RPO_LOSS_COUNT: "0",
  };
  const cases = [
    {
      label: "RTO over 14400 seconds",
      env: { ...baseEnv, KC16_READINESS_MONOTONIC_MS: "14500001" },
    },
    {
      label: "RPO loss above zero",
      env: { ...baseEnv, KC16_RPO_LOSS_COUNT: "1" },
    },
  ];

  for (const item of cases) {
    const result = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
      encoding: "utf8",
      env: item.env,
    });
    assert.equal(result.status, 2, item.label);
    assert.match(result.stdout, /dopaios_kc16_objective_pass 0\n$/u, item.label);
  }
});

test("metrics CLI rejects timestamps that are not monotonic", () => {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
    encoding: "utf8",
    env: {
      ...process.env,
      KC16_FAULT_MONOTONIC_MS: "100000",
      KC16_DETECTION_MONOTONIC_MS: "99999",
      KC16_READINESS_MONOTONIC_MS: "480890",
      KC16_RPO_LOSS_COUNT: "0",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /detection monotonic timestamp cannot precede fault/u);
});

test("metrics CLI rejects missing measurements and fractional RPO loss", () => {
  const baseEnv = {
    ...process.env,
    KC16_FAULT_MONOTONIC_MS: "100000",
    KC16_DETECTION_MONOTONIC_MS: "103490",
    KC16_READINESS_MONOTONIC_MS: "480890",
    KC16_RPO_LOSS_COUNT: "0",
  };
  const missingFaultEnv: NodeJS.ProcessEnv = { ...baseEnv };
  delete missingFaultEnv.KC16_FAULT_MONOTONIC_MS;

  const missingFault = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
    encoding: "utf8",
    env: missingFaultEnv,
  });
  const fractionalLoss = spawnSync(process.execPath, ["--import", tsxLoader, metricsCli], {
    encoding: "utf8",
    env: { ...baseEnv, KC16_RPO_LOSS_COUNT: "0.5" },
  });

  assert.equal(missingFault.status, 1);
  assert.match(missingFault.stderr, /KC16_FAULT_MONOTONIC_MS is required/u);
  assert.equal(fractionalLoss.status, 1);
  assert.match(fractionalLoss.stderr, /KC16_RPO_LOSS_COUNT must be a non-negative integer/u);
});

test("recovery metrics expose detection, RTO and RPO in stable units", async () => {
  const observability = await import("../dopaios/kc16-observability.ts").catch(() => ({})) as {
    renderRecoveryMetrics?: (measurement: unknown) => string;
  };

  assert.equal(observability.renderRecoveryMetrics?.({
    detectionMs: 300_000,
    rtoMs: 14_400_000,
    rpoLossCount: 0,
    detectionPass: true,
    rtoPass: true,
    rpoPass: true,
    pass: true,
  }), [
    "# TYPE dopaios_kc16_detection_seconds gauge",
    "dopaios_kc16_detection_seconds 300",
    "# TYPE dopaios_kc16_rto_seconds gauge",
    "dopaios_kc16_rto_seconds 14400",
    "# TYPE dopaios_kc16_rpo_loss_records gauge",
    "dopaios_kc16_rpo_loss_records 0",
    "# TYPE dopaios_kc16_objective_pass gauge",
    "dopaios_kc16_objective_pass 1",
    "",
  ].join("\n"));
});

test("incident correlation finds the first component failure on one trace", async () => {
  const { correlateRecoveryIncident } = await import("../dopaios/kc16-observability.ts") as {
    correlateRecoveryIncident?: (events: unknown[], traceId: string) => unknown;
  };
  const events = [
    { traceId: "TRACE-1", monotonicMs: 1_000, severity: "info", component: "harness", code: "fault_injected" },
    { traceId: "TRACE-OTHER", monotonicMs: 1_100, severity: "error", component: "worker", code: "worker_stale" },
    { traceId: "TRACE-1", monotonicMs: 1_200, severity: "error", component: "artifact", code: "artifact_checksum_mismatch" },
    { traceId: "TRACE-1", monotonicMs: 1_250, severity: "warn", component: "readiness", code: "readiness_closed" },
  ];

  assert.deepEqual(correlateRecoveryIncident?.(events, "TRACE-1"), {
    traceId: "TRACE-1",
    detectedAtMonotonicMs: 1_200,
    rootCause: { component: "artifact", code: "artifact_checksum_mismatch" },
    trail: ["fault_injected", "artifact_checksum_mismatch", "readiness_closed"],
  });
});

test("structured recovery trace redacts credential-bearing fields", async () => {
  const { formatRecoveryTraceEvent } = await import("../dopaios/kc16-observability.ts") as {
    formatRecoveryTraceEvent?: (event: unknown) => string;
  };
  const line = formatRecoveryTraceEvent?.({
    traceId: "TRACE-SECRET",
    monotonicMs: 100,
    severity: "error",
    component: "postgres",
    code: "postgres_unreachable",
    details: {
      databaseUrl: "postgres://operator:do-not-log@127.0.0.1:5432/dopaios",
      retry: 1,
    },
  });

  assert.deepEqual(JSON.parse(line ?? "null"), {
    traceId: "TRACE-SECRET",
    monotonicMs: 100,
    severity: "error",
    component: "postgres",
    code: "postgres_unreachable",
    details: { databaseUrl: "[redacted]", retry: 1 },
  });
  assert.equal(line?.includes("do-not-log"), false);
});
