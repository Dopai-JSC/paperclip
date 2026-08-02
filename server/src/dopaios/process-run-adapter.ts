import { activateSopRun } from "./commands.js";
import { type Db } from "./event-store.js";
import { createProcessRuntime } from "./process-as-code.js";

export class MissingProcessGuardError extends Error {
  constructor(readonly missingGuards: string[]) {
    super(`process activation guards are not satisfied: ${missingGuards.join(", ")}`);
    this.name = "MissingProcessGuardError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function evaluateGuard(
  guard: string,
  context: { input: Record<string, unknown>; facts?: Record<string, boolean> },
): boolean {
  const inputPresent = /^input\.(.+)\.present$/.exec(guard);
  if (inputPresent) return isPresent(context.input[inputPresent[1]]);
  return context.facts?.[guard] === true;
}

export async function activateRunFromProcessDefinition(
  db: Db,
  commandId: string,
  input: {
    runId: string;
    definition: unknown;
    guardContext: { input: Record<string, unknown>; facts?: Record<string, boolean> };
  },
): Promise<{ runId: string; workItemId: string; stateId: string; activity: string }> {
  const runtime = createProcessRuntime(input.definition);
  const directive = runtime.directive();
  if (directive.kind !== "run-automatic") {
    throw new Error(`process initial state ${directive.stateId} is not automatically activatable`);
  }

  const definition = input.definition as { states: Record<string, unknown> };
  const state = definition.states[directive.stateId];
  const guards = isRecord(state) && Array.isArray(state.activationGuards)
    ? state.activationGuards.filter((guard): guard is string => typeof guard === "string")
    : [];
  const missing = guards.filter((guard) => !evaluateGuard(guard, input.guardContext));
  if (missing.length > 0) throw new MissingProcessGuardError(missing);

  const workItemId = `${input.runId}-${directive.stateId}`;
  await activateSopRun(db, commandId, { runId: input.runId, workItemId });
  return {
    runId: input.runId,
    workItemId,
    stateId: directive.stateId,
    activity: directive.activity,
  };
}
