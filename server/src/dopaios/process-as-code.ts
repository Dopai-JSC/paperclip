import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import Ajv, { type ErrorObject } from "ajv";
import { createActor, createMachine } from "xstate";

const PROCESS_SCHEMA = JSON.parse(
  readFileSync(
    new URL("../../../dopaios/processes/process-definition.schema.json", import.meta.url),
    "utf8",
  ),
) as object;
// Ajv's CJS/ESM type shape differs across Node/tsc loaders used by Paperclip.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AjvCtor = (Ajv as any).default ?? Ajv;
const validateSchema = new AjvCtor({ allErrors: true, strict: false }).compile(PROCESS_SCHEMA);

export type ProcessValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ProcessValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: ProcessValidationIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type AutomaticProcessState = {
  kind: "automatic";
  actor: string;
  activity: string;
  evidence: string[];
  onCompleted: string;
};

export type HumanDecisionProcessState = {
  kind: "human-decision";
  actor: string;
  evidence: string[];
  decisions: Record<string, string>;
  decisionEffects?: Record<string, string[]>;
};

export type FinalProcessState = { kind: "final" };
export type ProcessState = AutomaticProcessState | HumanDecisionProcessState | FinalProcessState;

export type ProcessDefinition = {
  schemaVersion: "1.0";
  id: string;
  revision: number;
  sourceAuthority: "business-text";
  initial: string;
  states: Record<string, ProcessState>;
};

export type ProcessDirective =
  | {
      kind: "run-automatic";
      stateId: string;
      actor: string;
      activity: string;
      evidence: string[];
    }
  | {
      kind: "wait-for-human";
      stateId: string;
      actor: string;
      decisions: string[];
      evidence: string[];
    }
  | { kind: "final"; stateId: string };

export class HumanDecisionRequiredError extends Error {
  constructor(stateId: string) {
    super(`state ${stateId} requires a human decision`);
    this.name = "HumanDecisionRequiredError";
  }
}

function gitBlobSha1(content: string): string {
  const header = `blob ${Buffer.byteLength(content, "utf8")}\0`;
  return createHash("sha1").update(header).update(content, "utf8").digest("hex");
}

function valueAtJsonPointer(input: unknown, pointer: string): unknown {
  if (pointer === "") return input;
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, part) => (isRecord(value) ? value[part] : undefined), input);
}

function schemaIssue(error: ErrorObject): ProcessValidationIssue {
  const missing = error.keyword === "required" ? String(error.params.missingProperty ?? "") : "";
  return {
    path: `${error.instancePath}/${missing}`.replace(/\/$/, "") || "/",
    code: "SCHEMA",
    message: error.message ?? "schema validation failed",
  };
}

export function validateProcessDefinition(input: unknown): ProcessValidationResult {
  if (!isRecord(input) || !isRecord(input.states)) {
    return {
      ok: false,
      issues: [{ path: "/states", code: "SCHEMA", message: "states must be an object" }],
    };
  }

  const states = input.states;
  for (const [stateId, state] of Object.entries(states)) {
    if (isRecord(state) && state.kind === "automatic" && typeof state.onCompleted !== "string") {
      return {
        ok: false,
        issues: [
          {
            path: `/states/${stateId}/onCompleted`,
            code: "AUTO_TRANSITION_REQUIRED",
            message: "automatic state must declare onCompleted",
          },
        ],
      };
    }
    if (isRecord(state) && state.kind === "human-decision" && "onCompleted" in state) {
      return {
        ok: false,
        issues: [
          {
            path: `/states/${stateId}/onCompleted`,
            code: "HUMAN_BOUNDARY_BYPASS",
            message: "human decision state cannot auto-complete",
          },
        ],
      };
    }
  }

  const transitions = new Map<string, Array<{ path: string; target: string }>>();
  for (const [stateId, state] of Object.entries(states)) {
    if (!isRecord(state)) continue;
    const outgoing: Array<{ path: string; target: string }> = [];
    if (typeof state.onCompleted === "string") {
      outgoing.push({ path: `/states/${stateId}/onCompleted`, target: state.onCompleted });
    }
    if (isRecord(state.decisions)) {
      for (const [decision, target] of Object.entries(state.decisions)) {
        if (typeof target === "string") {
          outgoing.push({ path: `/states/${stateId}/decisions/${decision}`, target });
        }
      }
    }
    transitions.set(stateId, outgoing);
    for (const transition of outgoing) {
      if (!(transition.target in states)) {
        return {
          ok: false,
          issues: [
            {
              path: transition.path,
              code: "UNKNOWN_TARGET",
              message: `transition targets unknown state ${transition.target}`,
            },
          ],
        };
      }
    }
  }

  const initial = typeof input.initial === "string" ? input.initial : "";
  const reachable = new Set<string>();
  const pending = initial in states ? [initial] : [];
  while (pending.length > 0) {
    const stateId = pending.shift()!;
    if (reachable.has(stateId)) continue;
    reachable.add(stateId);
    for (const transition of transitions.get(stateId) ?? []) {
      pending.push(transition.target);
    }
  }
  for (const stateId of Object.keys(states)) {
    if (!reachable.has(stateId)) {
      return {
        ok: false,
        issues: [
          {
            path: `/states/${stateId}`,
            code: "UNREACHABLE_STATE",
            message: `state ${stateId} is unreachable from ${initial}`,
          },
        ],
      };
    }
  }

  if (!validateSchema(input)) {
    return {
      ok: false,
      issues: (validateSchema.errors ?? []).map(schemaIssue),
    };
  }

  return { ok: true, issues: [] };
}

export function validateDefinitionAgainstSources(
  input: unknown,
  sources: Record<string, string>,
): ProcessValidationResult {
  const structure = validateProcessDefinition(input);
  if (!structure.ok) return structure;
  if (!isRecord(input) || !Array.isArray(input.sourceContracts)) {
    return {
      ok: false,
      issues: [
        {
          path: "/sourceContracts",
          code: "SOURCE_CONTRACT_REQUIRED",
          message: "definition must declare source contracts",
        },
      ],
    };
  }

  for (const contract of input.sourceContracts) {
    if (!isRecord(contract)) continue;
    const sourceId = String(contract.sourceId ?? "unknown");
    const path = String(contract.path ?? "");
    const content = sources[path];
    if (content === undefined) {
      return {
        ok: false,
        issues: [
          {
            path: `/sourceContracts/${sourceId}/path`,
            code: "SOURCE_MISSING",
            message: `source ${path} is unavailable`,
          },
        ],
      };
    }
    if (gitBlobSha1(content) !== contract.gitBlob) {
      return {
        ok: false,
        issues: [
          {
            path: `/sourceContracts/${sourceId}/gitBlob`,
            code: "SOURCE_BLOB_MISMATCH",
            message: `source ${path} does not match pinned git blob`,
          },
        ],
      };
    }
    for (const assertion of Array.isArray(contract.assertions) ? contract.assertions : []) {
      if (!isRecord(assertion)) continue;
      const sourceContains = String(assertion.sourceContains ?? "");
      const processPath = String(assertion.processPath ?? "");
      if (!content.includes(sourceContains)) {
        return {
          ok: false,
          issues: [
            {
              path: `/sourceContracts/${sourceId}/assertions`,
              code: "SOURCE_TEXT_MISMATCH",
              message: `source assertion is absent from ${path}`,
            },
          ],
        };
      }
      if (!isDeepStrictEqual(valueAtJsonPointer(input, processPath), assertion.equals)) {
        return {
          ok: false,
          issues: [
            {
              path: processPath,
              code: "PROCESS_SEMANTIC_MISMATCH",
              message: `process value does not match the contract anchored in ${path}`,
            },
          ],
        };
      }
    }
  }

  return { ok: true, issues: [] };
}

function asDefinition(input: unknown): ProcessDefinition {
  const result = validateProcessDefinition(input);
  if (!result.ok) {
    throw new Error(`invalid process definition: ${result.issues[0]?.code ?? "UNKNOWN"}`);
  }
  return input as ProcessDefinition;
}

export function createProcessRuntime(input: unknown) {
  const definition = asDefinition(input);
  const machineStates = Object.fromEntries(
    Object.entries(definition.states).map(([stateId, state]) => {
      if (state.kind === "final") return [stateId, { type: "final" as const }];
      if (state.kind === "automatic") {
        return [stateId, { on: { COMPLETE_AUTOMATIC: state.onCompleted } }];
      }
      return [
        stateId,
        {
          on: Object.fromEntries(
            Object.entries(state.decisions).map(([decision, target]) => [
              `DECIDE.${decision}`,
              target,
            ]),
          ),
        },
      ];
    }),
  );
  const actor = createActor(
    createMachine({ id: definition.id, initial: definition.initial, states: machineStates }),
  );
  actor.start();

  const stateId = (): string => String(actor.getSnapshot().value);
  const current = (): ProcessState => definition.states[stateId()];

  return {
    directive(): ProcessDirective {
      const id = stateId();
      const state = current();
      if (state.kind === "automatic") {
        return {
          kind: "run-automatic",
          stateId: id,
          actor: state.actor,
          activity: state.activity,
          evidence: [...state.evidence],
        };
      }
      if (state.kind === "human-decision") {
        return {
          kind: "wait-for-human",
          stateId: id,
          actor: state.actor,
          decisions: Object.keys(state.decisions),
          evidence: [...state.evidence],
        };
      }
      return { kind: "final", stateId: id };
    },
    completeAutomatic(): void {
      const id = stateId();
      if (current().kind === "human-decision") throw new HumanDecisionRequiredError(id);
      actor.send({ type: "COMPLETE_AUTOMATIC" });
    },
    decide(decision: string): string[] {
      const id = stateId();
      const state = current();
      if (state.kind !== "human-decision") {
        throw new Error(`state ${id} does not accept a human decision`);
      }
      if (!(decision in state.decisions)) {
        throw new Error(`decision ${decision} is not allowed at state ${id}`);
      }
      actor.send({ type: `DECIDE.${decision}` });
      return [...(state.decisionEffects?.[decision] ?? [])];
    },
  };
}
