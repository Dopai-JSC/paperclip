import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HumanDecisionRequiredError,
  createProcessRuntime,
  validateDefinitionAgainstSources,
  validateProcessDefinition,
} from "../dopaios/process-as-code.ts";

const MINIMAL_QUOTE_DEFINITION = {
  schemaVersion: "1.0",
  id: "quote-request",
  revision: 1,
  sourceAuthority: "business-text",
  initial: "prepare-quote",
  states: {
    "prepare-quote": {
      kind: "automatic",
      actor: "quote-preparer",
      activity: "produce-output",
      evidence: ["quote-draft"],
      onCompleted: "orchestrator-decision",
    },
    "orchestrator-decision": {
      kind: "human-decision",
      actor: "orchestrator",
      evidence: ["decision-record"],
      decisions: {
        approve: "completed",
        reject: "rejected",
        "request-rework": "prepare-quote",
      },
    },
    completed: { kind: "final" },
    rejected: { kind: "final" },
  },
} as const;

function loadDefinition(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../dopaios/processes/${name}`, import.meta.url), "utf8"),
  );
}

const sourceRoot = process.env.DOPAIOS_SOURCE_ROOT;
const itWithDopaiosSources = sourceRoot ? it : it.skip;

describe("dopaios KC-06 — process-as-code", () => {
  it("validates both process files with the same schema and interpreter core", () => {
    const quote = loadDefinition("quote-request.v1.json");
    const software = loadDefinition("software-development-skeleton.v1.json");

    expect(validateProcessDefinition(quote)).toEqual({ ok: true, issues: [] });
    expect(validateProcessDefinition(software)).toEqual({ ok: true, issues: [] });
    expect(createProcessRuntime(quote).directive()).toMatchObject({
      kind: "run-automatic",
      stateId: "prepare-quote",
    });
    expect(createProcessRuntime(software).directive()).toMatchObject({
      kind: "wait-for-human",
      stateId: "p0-initiation",
    });
  });

  it("returns generic effects for a rework decision and re-enters the declared step", () => {
    const runtime = createProcessRuntime(loadDefinition("quote-request.v1.json"));
    runtime.completeAutomatic();
    runtime.completeAutomatic();

    expect(runtime.decide("request-rework")).toEqual(["output.create-successor-revision"]);
    expect(runtime.directive()).toMatchObject({
      kind: "run-automatic",
      stateId: "prepare-quote",
    });
  });

  it("represents the next-release loop separately from completing scope into P3", () => {
    const runtime = createProcessRuntime(loadDefinition("software-development-skeleton.v1.json"));
    runtime.decide("approve");
    runtime.completeAutomatic();
    runtime.completeAutomatic();
    runtime.completeAutomatic();
    runtime.decide("approve");
    runtime.completeAutomatic();
    runtime.completeAutomatic();
    runtime.decide("approve");
    runtime.completeAutomatic();
    runtime.decide("approve");
    runtime.completeAutomatic();
    runtime.decide("approve");
    runtime.completeAutomatic();
    runtime.decide("approve");
    runtime.decide("accepted");
    runtime.decide("go");
    runtime.decide("released");
    runtime.completeAutomatic();
    runtime.completeAutomatic();

    expect(runtime.directive()).toMatchObject({
      kind: "wait-for-human",
      stateId: "release-continuation-decision",
      decisions: ["next-release", "scope-complete"],
    });
    runtime.decide("next-release");
    expect(runtime.directive()).toMatchObject({ kind: "run-automatic", stateId: "b0-spec-design" });
  });

  itWithDopaiosSources("matches both process files against the pinned Dopaios business text", () => {
    for (const name of ["quote-request.v1.json", "software-development-skeleton.v1.json"]) {
      const definition = loadDefinition(name) as {
        sourceContracts: Array<{ path: string }>;
      };
      const sources = Object.fromEntries(
        definition.sourceContracts.map(({ path }) => [
          path,
          readFileSync(join(sourceRoot!, path), "utf8"),
        ]),
      );

      expect(validateDefinitionAgainstSources(definition, sources)).toEqual({ ok: true, issues: [] });
    }
  });

  it("accepts a generic definition with automatic work and an explicit human decision boundary", () => {
    expect(validateProcessDefinition(MINIMAL_QUOTE_DEFINITION)).toEqual({ ok: true, issues: [] });
  });

  it("rejects an automatic state that has no machine-completion transition", () => {
    const invalid = structuredClone(MINIMAL_QUOTE_DEFINITION) as Record<string, unknown>;
    const states = invalid.states as Record<string, Record<string, unknown>>;
    delete states["prepare-quote"].onCompleted;

    expect(validateProcessDefinition(invalid)).toEqual({
      ok: false,
      issues: [
        {
          path: "/states/prepare-quote/onCompleted",
          code: "AUTO_TRANSITION_REQUIRED",
          message: "automatic state must declare onCompleted",
        },
      ],
    });
  });

  it("rejects a definition that omits required schema metadata", () => {
    const invalid = structuredClone(MINIMAL_QUOTE_DEFINITION) as Record<string, unknown>;
    delete invalid.id;

    expect(validateProcessDefinition(invalid)).toMatchObject({
      ok: false,
      issues: [{ path: "/id", code: "SCHEMA" }],
    });
  });

  it("rejects an automatic exit from a human decision state", () => {
    const invalid = structuredClone(MINIMAL_QUOTE_DEFINITION) as Record<string, unknown>;
    const states = invalid.states as Record<string, Record<string, unknown>>;
    states["orchestrator-decision"].onCompleted = "completed";

    expect(validateProcessDefinition(invalid)).toEqual({
      ok: false,
      issues: [
        {
          path: "/states/orchestrator-decision/onCompleted",
          code: "HUMAN_BOUNDARY_BYPASS",
          message: "human decision state cannot auto-complete",
        },
      ],
    });
  });

  it("rejects a transition to an unknown state", () => {
    const invalid = structuredClone(MINIMAL_QUOTE_DEFINITION) as Record<string, unknown>;
    const states = invalid.states as Record<string, Record<string, unknown>>;
    states["prepare-quote"].onCompleted = "missing-state";

    expect(validateProcessDefinition(invalid)).toEqual({
      ok: false,
      issues: [
        {
          path: "/states/prepare-quote/onCompleted",
          code: "UNKNOWN_TARGET",
          message: "transition targets unknown state missing-state",
        },
      ],
    });
  });

  it("rejects an unreachable declared state", () => {
    const invalid = structuredClone(MINIMAL_QUOTE_DEFINITION) as Record<string, unknown>;
    const states = invalid.states as Record<string, Record<string, unknown>>;
    states.orphan = {
      kind: "automatic",
      actor: "unused",
      activity: "produce-output",
      evidence: ["unused-output"],
      onCompleted: "completed",
    };

    expect(validateProcessDefinition(invalid)).toEqual({
      ok: false,
      issues: [
        {
          path: "/states/orphan",
          code: "UNREACHABLE_STATE",
          message: "state orphan is unreachable from prepare-quote",
        },
      ],
    });
  });

  it("opens eligible automatic work and stops before the human decision", () => {
    const runtime = createProcessRuntime(MINIMAL_QUOTE_DEFINITION);

    expect(runtime.directive()).toEqual({
      kind: "run-automatic",
      stateId: "prepare-quote",
      actor: "quote-preparer",
      activity: "produce-output",
      evidence: ["quote-draft"],
    });

    runtime.completeAutomatic();
    expect(runtime.directive()).toEqual({
      kind: "wait-for-human",
      stateId: "orchestrator-decision",
      actor: "orchestrator",
      decisions: ["approve", "reject", "request-rework"],
      evidence: ["decision-record"],
    });
    expect(() => runtime.completeAutomatic()).toThrow(HumanDecisionRequiredError);

    runtime.decide("approve");
    expect(runtime.directive()).toEqual({ kind: "final", stateId: "completed" });
  });

  it("detects when pinned business text changes", () => {
    const definition = {
      ...structuredClone(MINIMAL_QUOTE_DEFINITION),
      sourceContracts: [
        {
          sourceId: "quote-text",
          path: "quote.md",
          gitBlob: "c6b7310e85f44d2dfdf96d9f50df4a529c1a5769",
          assertions: [
            {
              sourceContains: "Quote Request -> Quote Draft",
              processPath: "/states/prepare-quote/activity",
              equals: "produce-output",
            },
          ],
        },
      ],
    };

    expect(
      validateDefinitionAgainstSources(definition, {
        "quote.md": "Quote Request -> Proposal -> Orchestrator approve/reject.",
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "/sourceContracts/quote-text/gitBlob",
          code: "SOURCE_BLOB_MISMATCH",
          message: "source quote.md does not match pinned git blob",
        },
      ],
    });
  });

  it("detects semantic text drift even when the new text blob is repinned", () => {
    const definition = {
      ...structuredClone(MINIMAL_QUOTE_DEFINITION),
      sourceContracts: [
        {
          sourceId: "quote-text",
          path: "quote.md",
          gitBlob: "c7ab6bee6e4ce739f789dfd06a0e85fa48d0fd98",
          assertions: [
            {
              sourceContains: "Quote Request -> Quote Draft",
              processPath: "/states/prepare-quote/activity",
              equals: "produce-output",
            },
          ],
        },
      ],
    };

    expect(
      validateDefinitionAgainstSources(definition, {
        "quote.md": "Quote Request -> Proposal -> Orchestrator approve/reject.",
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "/sourceContracts/quote-text/assertions",
          code: "SOURCE_TEXT_MISMATCH",
          message: "source assertion is absent from quote.md",
        },
      ],
    });
  });

  it("reports the process field that diverges from its textual contract", () => {
    const definition = {
      ...structuredClone(MINIMAL_QUOTE_DEFINITION),
      sourceContracts: [
        {
          sourceId: "quote-text",
          path: "quote.md",
          gitBlob: "c6b7310e85f44d2dfdf96d9f50df4a529c1a5769",
          assertions: [
            {
              sourceContains: "Quote Request -> Quote Draft",
              processPath: "/states/prepare-quote/activity",
              equals: "prepare-quote",
            },
          ],
        },
      ],
    };

    expect(
      validateDefinitionAgainstSources(definition, {
        "quote.md": "Quote Request -> Quote Draft -> Orchestrator approve/reject.",
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          path: "/states/prepare-quote/activity",
          code: "PROCESS_SEMANTIC_MISMATCH",
          message: "process value does not match the contract anchored in quote.md",
        },
      ],
    });
  });
});
