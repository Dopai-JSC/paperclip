// Dopaios (Bước nền, issue #9539): circuit breaker for repeated adapter auth
// failures. After AUTH_CIRCUIT_TRIP_THRESHOLD consecutive auth-failure runs the
// circuit opens and automatic wakeups are skipped, so a broken credential can
// never burn tokens in a retry storm. A user-initiated wakeup still passes and a
// successful run closes the circuit.

export const AUTH_CIRCUIT_TRIP_THRESHOLD = 3;

const AUTH_FAILURE_ERROR_CODE_RE = /_auth_required$/;

export type AdapterAuthCircuitState = {
  consecutiveFailures: number;
  firstFailureAt: string | null;
  trippedAt: string | null;
  lastErrorCode: string | null;
  lastRunId: string | null;
};

export function isAuthFailureErrorCode(errorCode: unknown): errorCode is string {
  return typeof errorCode === "string" && AUTH_FAILURE_ERROR_CODE_RE.test(errorCode);
}

export function readAuthCircuit(stateJson: unknown): AdapterAuthCircuitState {
  const empty: AdapterAuthCircuitState = {
    consecutiveFailures: 0,
    firstFailureAt: null,
    trippedAt: null,
    lastErrorCode: null,
    lastRunId: null,
  };
  if (typeof stateJson !== "object" || stateJson === null || Array.isArray(stateJson)) return empty;
  const raw = (stateJson as Record<string, unknown>).authCircuit;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const record = raw as Record<string, unknown>;
  const consecutiveFailures = Number(record.consecutiveFailures);
  return {
    consecutiveFailures: Number.isFinite(consecutiveFailures) && consecutiveFailures > 0
      ? Math.floor(consecutiveFailures)
      : 0,
    firstFailureAt: typeof record.firstFailureAt === "string" ? record.firstFailureAt : null,
    trippedAt: typeof record.trippedAt === "string" ? record.trippedAt : null,
    lastErrorCode: typeof record.lastErrorCode === "string" ? record.lastErrorCode : null,
    lastRunId: typeof record.lastRunId === "string" ? record.lastRunId : null,
  };
}

export function isAuthCircuitOpen(stateJson: unknown): boolean {
  return readAuthCircuit(stateJson).trippedAt != null;
}

export function recordAuthRunOutcome(
  stateJson: unknown,
  outcome: { failed: boolean; errorCode?: string | null; runId?: string | null; at?: Date },
): { stateJson: Record<string, unknown>; circuit: AdapterAuthCircuitState; tripped: boolean; changed: boolean } {
  const base = typeof stateJson === "object" && stateJson !== null && !Array.isArray(stateJson)
    ? { ...(stateJson as Record<string, unknown>) }
    : {};
  const previous = readAuthCircuit(stateJson);

  if (!outcome.failed || !isAuthFailureErrorCode(outcome.errorCode)) {
    if (previous.consecutiveFailures === 0 && previous.trippedAt == null) {
      return { stateJson: base, circuit: previous, tripped: false, changed: false };
    }
    delete base.authCircuit;
    return {
      stateJson: base,
      circuit: {
        consecutiveFailures: 0,
        firstFailureAt: null,
        trippedAt: null,
        lastErrorCode: null,
        lastRunId: null,
      },
      tripped: false,
      changed: true,
    };
  }

  const at = (outcome.at ?? new Date()).toISOString();
  const consecutiveFailures = previous.consecutiveFailures + 1;
  const trippedNow = previous.trippedAt == null && consecutiveFailures >= AUTH_CIRCUIT_TRIP_THRESHOLD;
  const circuit: AdapterAuthCircuitState = {
    consecutiveFailures,
    firstFailureAt: previous.firstFailureAt ?? at,
    trippedAt: previous.trippedAt ?? (trippedNow ? at : null),
    lastErrorCode: outcome.errorCode ?? null,
    lastRunId: outcome.runId ?? null,
  };
  base.authCircuit = circuit;
  return { stateJson: base, circuit, tripped: trippedNow, changed: true };
}
