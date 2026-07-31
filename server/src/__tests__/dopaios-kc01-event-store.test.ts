import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CommandPayloadMismatchError,
  CommandRejectedError,
  countAllEvents,
  executeCommand,
  payloadSha256,
  readAllEvents,
  readStream,
  replayProjections,
  snapshotProjections,
} from "../dopaios/event-store.ts";
import {
  activateSopRun,
  advanceToDecision,
  completeSopRun,
  createProjectShell,
  createSopDefinition,
  interruptRetryReassign,
  markArtifactImpact,
  pinProductBaseline,
  publishSopDefinition,
  recordApproval,
  registerActor,
  registerApprovedArtifact,
  requestTestRun,
  reviewFixtureExecution,
  runFixtureExecution,
} from "../dopaios/commands.ts";

// KC-01 contract tests over the canonical batch-1 fixtures fx-01 and fx-02
// (dopaios/fixtures). The embedded test database runs the full migration
// chain, so the message-db event store (0501) and the projection tables
// (0502) are exactly what production migrations produce.

const fx01 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-01-none-preparing.json", import.meta.url), "utf8"),
);
const fx02 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-02-run-test-chain.json", import.meta.url), "utf8"),
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-01 event store tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dopaios KC-01 event store", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const templateSha256 = fx01.components[0].sha256 as string;
  const sopSha256 = fx02.components[0].sha256 as string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc01-");
    db = createDb(tempDb.connectionString);
    for (const [actorId, description] of Object.entries<string>(fx01.actors)) {
      const capabilities: string[] = [];
      if (actorId === "STAFF-HUMAN-CREATOR-001") capabilities.push("project-creator");
      if (actorId === "STAFF-HUMAN-ORCH-001") capabilities.push("orchestrator");
      await registerActor(db, `CMD-SEED-${actorId}`, {
        actorId,
        kind: description.includes("người") ? "human" : "other",
        active: !actorId.includes("INACTIVE"),
        capabilities,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("fx-01 C01: valid shell lands in PREPARING with the event written before the projection", async () => {
    const result = await createProjectShell(db, "CMD-FX01-C01", {
      projectId: "PROJECT-FX01",
      actor: "STAFF-HUMAN-CREATOR-001",
      templateRef: fx01.base_command.template_ref,
      expectedTemplateSha256: templateSha256,
      orchestrator: "STAFF-HUMAN-ORCH-001",
    });
    expect(result).toMatchObject({ projectId: "PROJECT-FX01", state: "PREPARING" });

    const events = await readStream(db, "dopaiosProject-PROJECT-FX01");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ProjectShellCreated");
    expect(events[0].metadata).toMatchObject({ commandId: "CMD-FX01-C01", audit: true });

    const rows = (await db.execute(
      sql`SELECT state FROM dopaios_projects WHERE id = 'PROJECT-FX01'`,
    )) as unknown as Array<{ state: string }>;
    expect(rows[0]?.state).toBe("PREPARING");
  });

  it("idempotency: same command_id + same payload replays the stored result without new events", async () => {
    const before = await countAllEvents(db);
    const replayed = await createProjectShell(db, "CMD-FX01-C01", {
      projectId: "PROJECT-FX01",
      actor: "STAFF-HUMAN-CREATOR-001",
      templateRef: fx01.base_command.template_ref,
      expectedTemplateSha256: templateSha256,
      orchestrator: "STAFF-HUMAN-ORCH-001",
    });
    expect(replayed).toMatchObject({
      projectId: "PROJECT-FX01",
      state: "PREPARING",
      idempotentReplay: true,
    });
    expect(await countAllEvents(db)).toBe(before);
  });

  it("idempotency: same command_id + different payload is rejected without side effects", async () => {
    const before = await countAllEvents(db);
    await expect(
      createProjectShell(db, "CMD-FX01-C01", {
        projectId: "PROJECT-FX01-OTHER",
        actor: "STAFF-HUMAN-CREATOR-001",
        templateRef: fx01.base_command.template_ref,
        expectedTemplateSha256: templateSha256,
        orchestrator: "STAFF-HUMAN-ORCH-001",
      }),
    ).rejects.toBeInstanceOf(CommandPayloadMismatchError);
    expect(await countAllEvents(db)).toBe(before);
  });

  it("fx-01 guards on the same snapshot: inactive actor and missing capability are rejected with zero events", async () => {
    const before = await countAllEvents(db);
    await expect(
      createProjectShell(db, "CMD-FX01-ERR001", {
        projectId: "PROJECT-FX01-ERR",
        actor: "STAFF-HUMAN-INACTIVE-001",
        templateRef: fx01.base_command.template_ref,
        expectedTemplateSha256: templateSha256,
        orchestrator: "STAFF-HUMAN-ORCH-001",
      }),
    ).rejects.toMatchObject({ code: "ERR-001" });
    await expect(
      createProjectShell(db, "CMD-FX01-SFR004", {
        projectId: "PROJECT-FX01-ERR",
        actor: "ACTOR-NO-CAP-001",
        templateRef: fx01.base_command.template_ref,
        expectedTemplateSha256: templateSha256,
        orchestrator: "STAFF-HUMAN-ORCH-001",
      }),
    ).rejects.toMatchObject({ code: "SFR-004" });
    expect(await countAllEvents(db)).toBe(before);
    const rows = (await db.execute(
      sql`SELECT count(*)::bigint AS n FROM dopaios_projects WHERE id = 'PROJECT-FX01-ERR'`,
    )) as unknown as Array<{ n: string | number }>;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("REC-001: a handler failure after emitting rolls back events, projections and the command row", async () => {
    const before = await countAllEvents(db);
    await expect(
      executeCommand(db, {
        commandId: "CMD-REC-001",
        payload: { probe: true },
        handler: async (ctx) => {
          await ctx.emit({
            streamName: "dopaiosProject-PROJECT-REC001",
            type: "ProjectShellCreated",
            data: {
              projectId: "PROJECT-REC001",
              templateRef: fx01.base_command.template_ref,
              orchestrator: "STAFF-HUMAN-ORCH-001",
              createdBy: "STAFF-HUMAN-CREATOR-001",
            },
          });
          throw new Error("simulated interruption after event + projection write");
        },
      }),
    ).rejects.toThrow("simulated interruption");
    expect(await countAllEvents(db)).toBe(before);
    const rows = (await db.execute(sql`
      SELECT
        (SELECT count(*)::bigint FROM dopaios_projects WHERE id = 'PROJECT-REC001') AS projects,
        (SELECT count(*)::bigint FROM dopaios_commands WHERE command_id = 'CMD-REC-001') AS commands
    `)) as unknown as Array<{ projects: string | number; commands: string | number }>;
    expect(Number(rows[0]?.projects)).toBe(0);
    expect(Number(rows[0]?.commands)).toBe(0);
  });

  it("ordering: per-stream positions are gapless and global positions strictly increase", async () => {
    const events = await readAllEvents(db);
    expect(events.length).toBeGreaterThan(0);
    const globals = events.map((event) => event.globalPosition);
    for (let index = 1; index < globals.length; index += 1) {
      expect(globals[index]).toBeGreaterThan(globals[index - 1]);
    }
    const byStream = new Map<string, number[]>();
    for (const event of events) {
      const positions = byStream.get(event.streamName) ?? [];
      positions.push(event.position);
      byStream.set(event.streamName, positions);
    }
    for (const positions of byStream.values()) {
      expect(positions).toEqual(positions.map((_, index) => index));
    }
  });

  it("fx-02 S01–S10: the canonical run-test chain drives all seven state types", async () => {
    await registerApprovedArtifact(db, "CMD-FX02-S01", {
      artifactId: "SOP-TEST-001",
      revision: 1,
      sha256: sopSha256,
    });
    await createSopDefinition(db, "CMD-FX02-S02", {
      definitionId: "SOPDEF-TEST-001",
      revision: 1,
      sopPin: { artifactId: "SOP-TEST-001", revision: 1, sha256: sopSha256 },
    });

    // FX-02-N01: publish with a diverging definition is blocked, stays draft.
    await expect(
      publishSopDefinition(db, "CMD-FX02-N01", {
        definitionId: "SOPDEF-TEST-001",
        definitionContentSha256: "0".repeat(64),
        expectedSopSha256: sopSha256,
      }),
    ).rejects.toMatchObject({ code: "US1-AC3" });

    await publishSopDefinition(db, "CMD-FX02-S03", {
      definitionId: "SOPDEF-TEST-001",
      definitionContentSha256: sopSha256,
      expectedSopSha256: sopSha256,
    });
    await requestTestRun(db, "CMD-FX02-S04", {
      runId: "RUN-T-001",
      definitionRef: { definitionId: "SOPDEF-TEST-001", revision: 1 },
      decider: fx02.fixture_package.decider,
      pod: fx02.fixture_package.pod,
      fixturePackage: { executor: fx02.fixture_package.executor },
    });

    const activation = await activateSopRun(db, "CMD-FX02-S05", {
      runId: "RUN-T-001",
      workItemId: "WI-T1-001",
    });
    expect(activation).toMatchObject({ state: "RUNNING", workItem: "ACCEPTED" });

    // SFR-011: re-issuing the activation command replays, it does not re-run.
    const reactivation = await activateSopRun(db, "CMD-FX02-S05", {
      runId: "RUN-T-001",
      workItemId: "WI-T1-001",
    });
    expect(reactivation).toMatchObject({ idempotentReplay: true });

    await runFixtureExecution(db, "CMD-FX02-S06", {
      workItemId: "WI-T1-001",
      executor: fx02.fixture_package.executor,
      outputId: "OUT-T1-001",
      outputRevision: 1,
      contentSha256: fx02.components.find((c: { path: string }) => c.path.includes("t1-output-rev1"))
        ?.sha256 as string,
    });

    // SFR-019: reviewer must not equal executor.
    await expect(
      reviewFixtureExecution(db, "CMD-FX02-S07-SELF", {
        workItemId: "WI-T1-001",
        outputId: "OUT-T1-001",
        outputRevision: 1,
        executor: fx02.fixture_package.executor,
        reviewer: fx02.fixture_package.executor,
      }),
    ).rejects.toBeInstanceOf(CommandRejectedError);

    await reviewFixtureExecution(db, "CMD-FX02-S07", {
      workItemId: "WI-T1-001",
      outputId: "OUT-T1-001",
      outputRevision: 1,
      executor: fx02.fixture_package.executor,
      reviewer: "FIXTURE-REVIEWER-001",
    });

    const refs = {
      output: { id: "OUT-T1-001", revision: 1 },
      definition: { id: "SOPDEF-TEST-001", revision: 1 },
    };
    await advanceToDecision(db, "CMD-FX02-S08", {
      runId: "RUN-T-001",
      outputId: "OUT-T1-001",
      outputRevision: 1,
      packageId: "PKG-T2-001",
      packageRevision: 1,
      refs,
      requestId: "REQ-T2-001",
    });

    // Completing with an undecided obligation must be blocked.
    await expect(
      completeSopRun(db, "CMD-FX02-S10-EARLY", { runId: "RUN-T-001" }),
    ).rejects.toMatchObject({ code: "ERR-OPEN-OBLIGATION" });

    // SFR-028: refs must be byte-equivalent to the package.
    await expect(
      recordApproval(db, "CMD-FX02-S09-BADREF", {
        requestId: "REQ-T2-001",
        recordId: "AR-T2-BAD",
        packageId: "PKG-T2-001",
        packageRevision: 1,
        pinnedRefs: { ...refs, extra: true },
        actor: fx02.fixture_package.decider,
        outputId: "OUT-T1-001",
        outputRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "SFR-028" });

    await recordApproval(db, "CMD-FX02-S09", {
      requestId: "REQ-T2-001",
      recordId: "AR-T2-001",
      packageId: "PKG-T2-001",
      packageRevision: 1,
      pinnedRefs: { definition: { id: "SOPDEF-TEST-001", revision: 1 }, output: { id: "OUT-T1-001", revision: 1 } },
      actor: fx02.fixture_package.decider,
      outputId: "OUT-T1-001",
      outputRevision: 1,
    });
    const completion = await completeSopRun(db, "CMD-FX02-S10", { runId: "RUN-T-001" });
    expect(completion).toMatchObject({ state: "COMPLETED" });

    const states = (await db.execute(sql`
      SELECT
        (SELECT state FROM dopaios_sop_definitions WHERE id = 'SOPDEF-TEST-001') AS definition,
        (SELECT state FROM dopaios_sop_runs WHERE id = 'RUN-T-001') AS run,
        (SELECT state FROM dopaios_work_items WHERE id = 'WI-T1-001') AS work_item,
        (SELECT state FROM dopaios_output_versions WHERE id = 'OUT-T1-001' AND revision = 1) AS output,
        (SELECT state FROM dopaios_action_requests WHERE id = 'REQ-T2-001') AS request,
        (SELECT state FROM dopaios_decision_packages WHERE id = 'PKG-T2-001') AS package,
        (SELECT outcome FROM dopaios_approval_records WHERE id = 'AR-T2-001') AS approval
    `)) as unknown as Array<Record<string, string>>;
    expect(states[0]).toEqual({
      definition: "published",
      run: "COMPLETED",
      work_item: "COMPLETED",
      output: "APPROVED",
      request: "DECIDED",
      package: "DECIDED",
      approval: "approve",
    });
  });

  it("retry–continue–reassign: the sample work-item chain is append-only and replayable", async () => {
    await requestTestRun(db, "CMD-FX02-S04-R2", {
      runId: "RUN-T-002",
      definitionRef: { definitionId: "SOPDEF-TEST-001", revision: 1 },
      decider: fx02.fixture_package.decider,
      pod: fx02.fixture_package.pod,
      fixturePackage: { executor: fx02.fixture_package.executor },
    });
    await activateSopRun(db, "CMD-FX02-S05-R2", { runId: "RUN-T-002", workItemId: "WI-R-001" });
    const chain = await interruptRetryReassign(db, "CMD-CHAIN-001", {
      workItemId: "WI-R-001",
      firstExecutor: fx02.fixture_package.executor,
      secondExecutor: "FIXTURE-EXECUTOR-002",
    });
    expect(chain).toMatchObject({ state: "SUBMITTED", hops: 8 });

    const events = await readStream(db, "dopaiosWorkItem-WI-R-001");
    const states = events
      .filter((event) => event.type === "WorkItemStateChanged")
      .map((event) => event.data["state"]);
    expect(states).toEqual([
      "ACCEPTED",
      "CLAIMED",
      "IN_PROGRESS",
      "INTERRUPTED",
      "IN_PROGRESS",
      "INTERRUPTED",
      "CLAIMED",
      "IN_PROGRESS",
      "SUBMITTED",
    ]);
    const rows = (await db.execute(
      sql`SELECT state, executor FROM dopaios_work_items WHERE id = 'WI-R-001'`,
    )) as unknown as Array<{ state: string; executor: string }>;
    expect(rows[0]).toEqual({ state: "SUBMITTED", executor: "FIXTURE-EXECUTOR-002" });
  });

  it("product baseline pins exact revisions and hashes; wrong hash or unapproved artifact is rejected", async () => {
    await expect(
      pinProductBaseline(db, "CMD-BASE-BADHASH", {
        baselineId: "PB-001",
        revision: 1,
        pinnedBy: fx02.fixture_package.decider,
        items: [{ artifactId: "SOP-TEST-001", revision: 1, sha256: "0".repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: "ERR-BASELINE-HASH" });
    await expect(
      pinProductBaseline(db, "CMD-BASE-MISSING", {
        baselineId: "PB-001",
        revision: 1,
        pinnedBy: fx02.fixture_package.decider,
        items: [{ artifactId: "SOP-KHONG-TON-TAI", revision: 9, sha256: sopSha256 }],
      }),
    ).rejects.toMatchObject({ code: "ERR-BASELINE-ITEM" });

    const pinned = await pinProductBaseline(db, "CMD-BASE-001", {
      baselineId: "PB-001",
      revision: 1,
      pinnedBy: fx02.fixture_package.decider,
      items: [{ artifactId: "SOP-TEST-001", revision: 1, sha256: sopSha256 }],
    });
    expect(pinned).toMatchObject({ itemCount: 1 });
    const rows = (await db.execute(
      sql`SELECT state, items FROM dopaios_product_baselines WHERE id = 'PB-001' AND revision = 1`,
    )) as unknown as Array<{ state: string; items: Array<{ sha256: string }> }>;
    expect(rows[0]?.state).toBe("pinned");
    expect(rows[0]?.items[0]?.sha256).toBe(sopSha256);
  });

  it("artifact dual axis: impact status changes without touching artifact_state", async () => {
    await markArtifactImpact(db, "CMD-IMPACT-001", {
      artifactId: "SOP-TEST-001",
      revision: 1,
      impactStatus: "impact-pending",
    });
    const rows = (await db.execute(
      sql`SELECT artifact_state, impact_status FROM dopaios_artifacts WHERE id = 'SOP-TEST-001' AND revision = 1`,
    )) as unknown as Array<{ artifact_state: string; impact_status: string }>;
    expect(rows[0]).toEqual({ artifact_state: "approved", impact_status: "impact-pending" });
  });

  it("optimistic concurrency: a stale expected version is rejected by the store", async () => {
    await expect(
      executeCommand(db, {
        commandId: "CMD-CONFLICT-001",
        payload: { probe: "conflict" },
        handler: async (ctx) => {
          await ctx.emit({
            streamName: "dopaiosSopRun-RUN-T-001",
            type: "SopRunStateChanged",
            data: { runId: "RUN-T-001", state: "COMPLETED" },
            expectedVersion: 0,
          });
          return {};
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      for (let current = error; current; current = (current as { cause?: unknown }).cause) {
        if (/Wrong expected version/.test(String((current as Error).message ?? current))) {
          return true;
        }
      }
      return false;
    });
  });

  it("SQR-003: replay from the event log alone reconstructs all seven state types byte-identically", async () => {
    const before = await snapshotProjections(db);
    const sevenTypes = [
      "dopaios_sop_definitions",
      "dopaios_sop_runs",
      "dopaios_work_items",
      "dopaios_output_versions",
      "dopaios_action_requests",
      "dopaios_decision_packages",
      "dopaios_approval_records",
      "dopaios_product_baselines",
    ];
    for (const table of sevenTypes) {
      expect(before[table]!.length, `${table} must hold fixture state before replay`).toBeGreaterThan(0);
    }

    await replayProjections(db);

    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });

  it("payload hashing is canonical: key order does not change the command hash", () => {
    expect(payloadSha256({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(
      payloadSha256({ b: { d: "x", c: [1, 2] }, a: 1 }),
    );
  });
});
