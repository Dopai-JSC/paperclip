export type RecoveryMeasurement = {
  detectionMs: number;
  rtoMs: number;
  rpoLossCount: number;
  detectionPass: boolean;
  rtoPass: boolean;
  rpoPass: boolean;
  pass: boolean;
};

export function renderRecoveryMetrics(measurement: RecoveryMeasurement): string {
  return [
    "# TYPE dopaios_kc16_detection_seconds gauge",
    `dopaios_kc16_detection_seconds ${measurement.detectionMs / 1_000}`,
    "# TYPE dopaios_kc16_rto_seconds gauge",
    `dopaios_kc16_rto_seconds ${measurement.rtoMs / 1_000}`,
    "# TYPE dopaios_kc16_rpo_loss_records gauge",
    `dopaios_kc16_rpo_loss_records ${measurement.rpoLossCount}`,
    "# TYPE dopaios_kc16_objective_pass gauge",
    `dopaios_kc16_objective_pass ${measurement.pass ? 1 : 0}`,
    "",
  ].join("\n");
}

export type RecoveryTraceEvent = {
  traceId: string;
  monotonicMs: number;
  severity: "info" | "warn" | "error";
  component: string;
  code: string;
};

export function correlateRecoveryIncident(events: RecoveryTraceEvent[], traceId: string) {
  const trail = events
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => left.monotonicMs - right.monotonicMs);
  const rootCause = trail.find((event) => event.severity === "error");
  if (!rootCause) return null;
  return {
    traceId,
    detectedAtMonotonicMs: rootCause.monotonicMs,
    rootCause: { component: rootCause.component, code: rootCause.code },
    trail: trail.map((event) => event.code),
  };
}

function redactDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDetails);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /password|token|secret|databaseurl|credential/iu.test(key) ? "[redacted]" : redactDetails(item),
    ]));
  }
  return value;
}

export function formatRecoveryTraceEvent(
  event: RecoveryTraceEvent & { details?: Record<string, unknown> },
): string {
  return JSON.stringify({
    traceId: event.traceId,
    monotonicMs: event.monotonicMs,
    severity: event.severity,
    component: event.component,
    code: event.code,
    ...(event.details ? { details: redactDetails(event.details) } : {}),
  });
}
