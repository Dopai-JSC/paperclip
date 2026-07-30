import { describe, expect, it } from "vitest";
import {
  AUTH_CIRCUIT_TRIP_THRESHOLD,
  isAuthCircuitOpen,
  isAuthFailureErrorCode,
  readAuthCircuit,
  recordAuthRunOutcome,
} from "./adapter-auth-circuit.js";

describe("adapter auth circuit (Dopaios, issue #9539)", () => {
  it("recognizes adapter auth failure error codes by suffix", () => {
    expect(isAuthFailureErrorCode("claude_auth_required")).toBe(true);
    expect(isAuthFailureErrorCode("codex_auth_required")).toBe(true);
    expect(isAuthFailureErrorCode("acpx_auth_required")).toBe(true);
    expect(isAuthFailureErrorCode("adapter_failed")).toBe(false);
    expect(isAuthFailureErrorCode("timeout")).toBe(false);
    expect(isAuthFailureErrorCode(null)).toBe(false);
  });

  it("trips after the configured number of consecutive auth failures", () => {
    let state: unknown = {};
    let tripped = false;
    for (let attempt = 1; attempt <= AUTH_CIRCUIT_TRIP_THRESHOLD; attempt += 1) {
      const outcome = recordAuthRunOutcome(state, {
        failed: true,
        errorCode: "claude_auth_required",
        runId: `run-${attempt}`,
      });
      state = outcome.stateJson;
      tripped = outcome.tripped;
      expect(outcome.circuit.consecutiveFailures).toBe(attempt);
      if (attempt < AUTH_CIRCUIT_TRIP_THRESHOLD) {
        expect(outcome.tripped).toBe(false);
        expect(isAuthCircuitOpen(state)).toBe(false);
      }
    }
    expect(tripped).toBe(true);
    expect(isAuthCircuitOpen(state)).toBe(true);
    expect(readAuthCircuit(state).lastErrorCode).toBe("claude_auth_required");
  });

  it("stays open on further auth failures without re-tripping", () => {
    let state: unknown = {};
    for (let attempt = 0; attempt < AUTH_CIRCUIT_TRIP_THRESHOLD; attempt += 1) {
      state = recordAuthRunOutcome(state, { failed: true, errorCode: "claude_auth_required" }).stateJson;
    }
    const again = recordAuthRunOutcome(state, { failed: true, errorCode: "claude_auth_required" });
    expect(again.tripped).toBe(false);
    expect(again.circuit.consecutiveFailures).toBe(AUTH_CIRCUIT_TRIP_THRESHOLD + 1);
    expect(isAuthCircuitOpen(again.stateJson)).toBe(true);
  });

  it("resets on a successful run", () => {
    let state: unknown = {};
    for (let attempt = 0; attempt < AUTH_CIRCUIT_TRIP_THRESHOLD; attempt += 1) {
      state = recordAuthRunOutcome(state, { failed: true, errorCode: "claude_auth_required" }).stateJson;
    }
    const reset = recordAuthRunOutcome(state, { failed: false, errorCode: null });
    expect(reset.changed).toBe(true);
    expect(reset.circuit.consecutiveFailures).toBe(0);
    expect(isAuthCircuitOpen(reset.stateJson)).toBe(false);
  });

  it("resets on a non-auth failure so unrelated errors do not keep the breaker charged", () => {
    let state: unknown = {};
    state = recordAuthRunOutcome(state, { failed: true, errorCode: "claude_auth_required" }).stateJson;
    state = recordAuthRunOutcome(state, { failed: true, errorCode: "timeout" }).stateJson;
    expect(readAuthCircuit(state).consecutiveFailures).toBe(0);
    const next = recordAuthRunOutcome(state, { failed: true, errorCode: "claude_auth_required" });
    expect(next.circuit.consecutiveFailures).toBe(1);
  });

  it("tolerates malformed persisted state", () => {
    for (const malformed of [null, undefined, "junk", 42, [], { authCircuit: "junk" }]) {
      expect(readAuthCircuit(malformed).consecutiveFailures).toBe(0);
      expect(isAuthCircuitOpen(malformed)).toBe(false);
      const outcome = recordAuthRunOutcome(malformed, { failed: true, errorCode: "claude_auth_required" });
      expect(outcome.circuit.consecutiveFailures).toBe(1);
    }
  });

  it("preserves unrelated stateJson keys", () => {
    const outcome = recordAuthRunOutcome({ existing: "value" }, {
      failed: true,
      errorCode: "claude_auth_required",
    });
    expect(outcome.stateJson.existing).toBe("value");
    const reset = recordAuthRunOutcome(outcome.stateJson, { failed: false });
    expect(reset.stateJson.existing).toBe("value");
    expect("authCircuit" in reset.stateJson).toBe(false);
  });
});
