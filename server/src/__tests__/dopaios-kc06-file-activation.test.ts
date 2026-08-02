import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createSopDefinition,
  publishSopDefinition,
  registerApprovedArtifact,
  requestTestRun,
} from "../dopaios/commands.ts";
import { payloadSha256 } from "../dopaios/event-store.ts";
import { requestActivation, runActivation } from "../dopaios/activation.ts";
import { FakeEngine } from "../dopaios/engine.ts";
import { qualityContractContentSha256 } from "../dopaios/lifecycle.ts";
import { runUntilQuiescent, type RunnerFixtureConfig } from "../dopaios/runner.ts";
import { seedApprovedQualityContract } from "./helpers/dopaios-kc14.ts";
import { activateRunFromProcessDefinition } from "../dopaios/process-run-adapter.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const QUOTE = JSON.parse(
  readFileSync(new URL("../../../dopaios/processes/quote-request.v1.json", import.meta.url), "utf8"),
) as {
  id: string;
  revision: number;
  states: Record<string, { activity?: string; activationGuards?: string[] }>;
};
const DEFINITION_SHA = payloadSha256(QUOTE);
const OUTPUT_SHA = "a".repeat(64);
const SELF_SHA = "b".repeat(64);
const REVIEW_SHA = "c".repeat(64);
const QC_CHECKS = ["self-check", "independent-review"];
const QC_REF = {
  id: "QC-KC06-QUOTE",
  revision: 1,
  sha256: qualityContractContentSha256({ outputType: "quote-draft", requiredChecks: QC_CHECKS }),
};
const FIXTURE: RunnerFixtureConfig = {
  executor: "AI-QUOTE-PREPARER",
  reviewer: "AI-QUOTE-REVIEWER",
  contentSha256: OUTPUT_SHA,
  outputType: "quote-draft",
  qualityContractRef: QC_REF,
  selfCheckSha256: SELF_SHA,
  reviewSha256: REVIEW_SHA,
};

describeEmbeddedPostgres("dopaios KC-06 — activate SOP Báo giá from file", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc06-file-");
    db = createDb(tempDb.connectionString);

    await registerApprovedArtifact(db, "KC06-SEED-ARTIFACT", {
      artifactId: "SOP-QUOTE-FILE-R1",
      revision: 1,
      sha256: DEFINITION_SHA,
      sourceRefs: [
        { artifactId: "brief", revision: 3 },
        { artifactId: "prd", revision: 3 },
      ],
      storageRef: "dopaios/processes/quote-request.v1.json",
    });
    await createSopDefinition(db, "KC06-SEED-DEFINITION", {
      definitionId: QUOTE.id,
      revision: QUOTE.revision,
      sopPin: { artifactId: "SOP-QUOTE-FILE-R1", revision: 1, sha256: DEFINITION_SHA },
    });
    await publishSopDefinition(db, "KC06-SEED-PUBLISH", {
      definitionId: QUOTE.id,
      definitionContentSha256: DEFINITION_SHA,
      expectedSopSha256: DEFINITION_SHA,
    });
    await requestTestRun(db, "KC06-SEED-RUN", {
      runId: "RUN-KC06-QUOTE",
      definitionRef: { definitionId: QUOTE.id, revision: QUOTE.revision, sha256: DEFINITION_SHA },
      decider: "ORCHESTRATOR-KC06",
      pod: "POD-KC06",
      fixturePackage: { processFile: "dopaios/processes/quote-request.v1.json" },
    });
    await seedApprovedQualityContract(db, {
      id: QC_REF.id,
      outputType: "quote-draft",
      requiredChecks: QC_CHECKS,
      cmdPrefix: "KC06",
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("requires file guards, opens eligible work, runs FakeEngine, and stops at Orchestrator", async () => {
    await expect(
      activateRunFromProcessDefinition(db, "KC06-ACT-MISSING", {
        runId: "RUN-KC06-QUOTE",
        definition: QUOTE,
        guardContext: {
          input: { requester: "ACME", scope: "ERP", source: "brief", assumptions: ["USD"] },
        },
      }),
    ).rejects.toMatchObject({
      name: "MissingProcessGuardError",
      missingGuards: ["input.due-date.present"],
    });

    const missingGuardRows = (await db.execute(
      sql`SELECT id FROM dopaios_work_items WHERE run_id = 'RUN-KC06-QUOTE'`,
    )) as unknown as Array<{ id: string }>;
    expect(missingGuardRows).toEqual([]);

    const activated = await activateRunFromProcessDefinition(db, "KC06-ACT-READY", {
      runId: "RUN-KC06-QUOTE",
      definition: QUOTE,
      guardContext: {
        input: {
          requester: "ACME",
          scope: "ERP",
          source: "brief",
          assumptions: ["USD"],
          "due-date": "2026-08-15",
        },
      },
    });
    expect(activated).toEqual({
      runId: "RUN-KC06-QUOTE",
      workItemId: "RUN-KC06-QUOTE-prepare-quote",
      stateId: "prepare-quote",
      activity: "prepare-quote",
    });
    await expect(
      activateRunFromProcessDefinition(db, "KC06-ACT-READY", {
        runId: "RUN-KC06-QUOTE",
        definition: QUOTE,
        guardContext: {
          input: {
            requester: "ACME",
            scope: "ERP",
            source: "brief",
            assumptions: ["USD"],
            "due-date": "2026-08-15",
          },
        },
      }),
    ).resolves.toEqual(activated);
    const activatedRows = (await db.execute(
      sql`SELECT id FROM dopaios_work_items WHERE run_id = 'RUN-KC06-QUOTE'`,
    )) as unknown as Array<{ id: string }>;
    expect(activatedRows).toEqual([{ id: "RUN-KC06-QUOTE-prepare-quote" }]);

    await requestActivation(db, "KC06-FAKE-REQUEST", {
      activationId: "ACT-KC06-QUOTE",
      workItemId: activated.workItemId,
      agentId: "AI-QUOTE-PREPARER",
      engine: "fake",
    });
    await expect(
      runActivation(db, {
        activationId: "ACT-KC06-QUOTE",
        claimedBy: "KC06-RUNNER",
        sessionId: "SESSION-KC06-QUOTE",
        agentId: "AI-QUOTE-PREPARER",
        adapter: new FakeEngine(),
        contract: {
          workItemId: activated.workItemId,
          contractRevision: 1,
          sopRef: { definitionId: QUOTE.id, revision: QUOTE.revision, sha256: DEFINITION_SHA },
          steps: [activated.activity],
        },
      }),
    ).resolves.toEqual({ kind: "succeeded", sessionId: "SESSION-KC06-QUOTE" });

    const { actions } = await runUntilQuiescent(db, { nowMs: Date.UTC(2026, 7, 2), fixture: FIXTURE });
    expect(actions.filter((action) => action.outcome === "ok").map((action) => action.command)).toEqual([
      "run-fixture-execution",
      "validate-self-check",
      "run-fixture-review",
      "advance-to-decision",
    ]);

    const runRows = (await db.execute(
      sql`SELECT state, definition_ref FROM dopaios_sop_runs WHERE id = 'RUN-KC06-QUOTE'`,
    )) as unknown as Array<{ state: string; definition_ref: Record<string, unknown> }>;
    expect(runRows[0]).toEqual({
      state: "RUNNING",
      definition_ref: { definitionId: QUOTE.id, revision: QUOTE.revision, sha256: DEFINITION_SHA },
    });
    const requestRows = (await db.execute(
      sql`SELECT state FROM dopaios_action_requests WHERE id = 'REQ-RUN-KC06-QUOTE'`,
    )) as unknown as Array<{ state: string }>;
    expect(requestRows).toEqual([{ state: "OPEN" }]);
  }, 120_000);
});
