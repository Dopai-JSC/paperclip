import assert from "node:assert/strict";
import test from "node:test";

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
