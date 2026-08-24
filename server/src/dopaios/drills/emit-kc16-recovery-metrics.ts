import { renderRecoveryMetrics } from "./kc16-observability.js";

function requireNonNegativeNumber(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") throw new Error(`${name} is required`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
  return value;
}

const faultMonotonicMs = requireNonNegativeNumber("KC16_FAULT_MONOTONIC_MS");
const detectionMonotonicMs = requireNonNegativeNumber("KC16_DETECTION_MONOTONIC_MS");
const readinessMonotonicMs = requireNonNegativeNumber("KC16_READINESS_MONOTONIC_MS");
const rpoLossCount = requireNonNegativeNumber("KC16_RPO_LOSS_COUNT");
if (!Number.isInteger(rpoLossCount)) {
  throw new Error("KC16_RPO_LOSS_COUNT must be a non-negative integer");
}
if (detectionMonotonicMs < faultMonotonicMs) {
  throw new Error("detection monotonic timestamp cannot precede fault");
}
if (readinessMonotonicMs < detectionMonotonicMs) {
  throw new Error("readiness monotonic timestamp cannot precede detection");
}

const detectionMs = detectionMonotonicMs - faultMonotonicMs;
const rtoMs = readinessMonotonicMs - faultMonotonicMs;
const detectionPass = detectionMs <= 300_000;
const rtoPass = rtoMs <= 14_400_000;
const rpoPass = rpoLossCount === 0;
const pass = detectionPass && rtoPass && rpoPass;

process.stdout.write(renderRecoveryMetrics({
  detectionMs,
  rtoMs,
  rpoLossCount,
  detectionPass,
  rtoPass,
  rpoPass,
  pass,
}));
if (!pass) process.exitCode = 2;
