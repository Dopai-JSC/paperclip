import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "./commands.js";
import { requestActivation, runActivation } from "./activation.js";
import {
  countAllEvents,
  payloadSha256,
  replayProjections,
  snapshotProjections,
} from "./event-store.js";
import { FakeEngine } from "./engine.js";
import { qualityContractContentSha256 } from "./lifecycle.js";
import { activateRunFromProcessDefinition } from "./process-run-adapter.js";
import { validateDefinitionAgainstSources } from "./process-as-code.js";
import { runUntilQuiescent, type RunnerFixtureConfig } from "./runner.js";
import { seedApprovedQualityContract } from "./seed-quality-contract.js";

const databaseUrl = process.env.DATABASE_URL;
const sourceRoot = process.env.DOPAIOS_SOURCE_ROOT;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!sourceRoot) throw new Error("DOPAIOS_SOURCE_ROOT is required");

const definition = JSON.parse(
  readFileSync(new URL("../../../dopaios/processes/quote-request.v1.json", import.meta.url), "utf8"),
) as {
  id: string;
  revision: number;
  sourceContracts: Array<{ path: string }>;
  states: Record<string, { activationGuards?: string[] }>;
};
const sources = Object.fromEntries(
  definition.sourceContracts.map(({ path }) => [path, readFileSync(join(sourceRoot, path), "utf8")]),
);
const sourceValidation = validateDefinitionAgainstSources(definition, sources);
if (!sourceValidation.ok) {
  throw new Error(`source contract failed: ${JSON.stringify(sourceValidation.issues)}`);
}

const definitionSha = payloadSha256(definition);
const outputSha = "a".repeat(64);
const selfCheckSha = "b".repeat(64);
const reviewSha = "c".repeat(64);
const requiredChecks = ["self-check", "independent-review"];
const qualityContractRef = {
  id: "QC-KC06-DRILL",
  revision: 1,
  sha256: qualityContractContentSha256({ outputType: "quote-draft", requiredChecks }),
};
const fixture: RunnerFixtureConfig = {
  executor: "AI-QUOTE-PREPARER",
  reviewer: "AI-QUOTE-REVIEWER",
  contentSha256: outputSha,
  outputType: "quote-draft",
  qualityContractRef,
  selfCheckSha256: selfCheckSha,
  reviewSha256: reviewSha,
};
const db = createDb(databaseUrl);

await registerApprovedArtifact(db, "KC06-DRILL-ARTIFACT", {
  artifactId: "SOP-QUOTE-FILE-R1",
  revision: 1,
  sha256: definitionSha,
  sourceRefs: [
    { artifactId: "brief", revision: 3 },
    { artifactId: "prd", revision: 3 },
  ],
  storageRef: "dopaios/processes/quote-request.v1.json",
});
await createSopDefinition(db, "KC06-DRILL-DEFINITION", {
  definitionId: definition.id,
  revision: definition.revision,
  sopPin: { artifactId: "SOP-QUOTE-FILE-R1", revision: 1, sha256: definitionSha },
});
await publishSopDefinition(db, "KC06-DRILL-PUBLISH", {
  definitionId: definition.id,
  definitionContentSha256: definitionSha,
  expectedSopSha256: definitionSha,
});
await requestTestRun(db, "KC06-DRILL-RUN", {
  runId: "RUN-KC06-DRILL",
  definitionRef: { definitionId: definition.id, revision: definition.revision, sha256: definitionSha },
  decider: "ORCHESTRATOR-KC06",
  pod: "POD-KC06",
  fixturePackage: { processFile: "dopaios/processes/quote-request.v1.json" },
});
await seedApprovedQualityContract(db, {
  id: qualityContractRef.id,
  outputType: "quote-draft",
  requiredChecks,
  cmdPrefix: "KC06-DRILL",
});

const activated = await activateRunFromProcessDefinition(db, "KC06-DRILL-ACTIVATE", {
  runId: "RUN-KC06-DRILL",
  definition,
  guardContext: {
    input: {
      requester: "Dopai JSC",
      scope: "KC-06 verification quote",
      source: "approved Brief and PRD",
      assumptions: ["FakeEngine only"],
      "due-date": "2026-08-02",
    },
  },
});
await requestActivation(db, "KC06-DRILL-FAKE-REQUEST", {
  activationId: "ACT-KC06-DRILL",
  workItemId: activated.workItemId,
  agentId: fixture.executor,
  engine: "fake",
});
await runActivation(db, {
  activationId: "ACT-KC06-DRILL",
  claimedBy: "KC06-DRILL-RUNNER",
  sessionId: "SESSION-KC06-DRILL",
  agentId: fixture.executor,
  adapter: new FakeEngine(),
  contract: {
    workItemId: activated.workItemId,
    contractRevision: 1,
    sopRef: { definitionId: definition.id, revision: definition.revision, sha256: definitionSha },
    steps: [activated.activity],
  },
});
const { actions } = await runUntilQuiescent(db, { nowMs: Date.UTC(2026, 7, 2), fixture });

const runRows = (await db.execute(
  sql`SELECT state, definition_ref FROM dopaios_sop_runs WHERE id = 'RUN-KC06-DRILL'`,
)) as unknown as Array<{ state: string; definition_ref: Record<string, unknown> }>;
const requestRows = (await db.execute(
  sql`SELECT state FROM dopaios_action_requests WHERE id = 'REQ-RUN-KC06-DRILL'`,
)) as unknown as Array<{ state: string }>;
const sessionRows = (await db.execute(
  sql`SELECT state, outcome FROM dopaios_ai_sessions WHERE id = 'SESSION-KC06-DRILL'`,
)) as unknown as Array<{ state: string; outcome: string }>;
if (runRows[0]?.state !== "RUNNING") throw new Error("run crossed or left the human boundary");
if (requestRows[0]?.state !== "OPEN") throw new Error("Orchestrator request is not OPEN");
if (sessionRows[0]?.state !== "TERMINAL" || sessionRows[0]?.outcome !== "succeeded") {
  throw new Error("FakeEngine session did not complete successfully");
}

const before = await snapshotProjections(db);
const eventCount = await countAllEvents(db);
await replayProjections(db);
const after = await snapshotProjections(db);
const replayIdentical = JSON.stringify(before) === JSON.stringify(after);
if (!replayIdentical) throw new Error("event replay changed projections");

console.log(
  JSON.stringify(
    {
      definition: { id: definition.id, revision: definition.revision, sha256: definitionSha },
      sourceValidation: "pass",
      activated,
      automaticActions: actions.filter((action) => action.outcome === "ok").map((action) => action.command),
      run: runRows[0],
      decisionRequest: requestRows[0],
      fakeEngineSession: sessionRows[0],
      eventCount,
      replayIdentical,
    },
    null,
    2,
  ),
);
process.exit(0);
