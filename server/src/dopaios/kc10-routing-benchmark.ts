import { performance } from "node:perf_hooks";
import { sql } from "drizzle-orm";
import { requestActivation } from "./activation.js";
import { executeCommand, type Db } from "./event-store.js";

export type Kc10RouteToActivationSample = {
  schema: "dopaios.kc10.route-to-activation-sample/v1";
  runId: string;
  ordinal: number;
  workItemId: string;
  agentId: string;
  activationId: string;
  activationState: "QUEUED";
  elapsedMs: number;
};

export async function measureKc10RouteToActivation(
  db: Db,
  input: { runId: string; ordinal: number },
): Promise<Kc10RouteToActivationSample> {
  if (!input.runId.trim()) throw new Error("KC-10 routing benchmark runId is required");
  if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
    throw new Error("KC-10 routing benchmark ordinal must be a positive integer");
  }

  const suffix = `${input.runId}-${String(input.ordinal).padStart(4, "0")}`;
  const workItemId = `KC10-ROUTE-WI-${suffix}`;
  const agentId = `KC10-ROUTE-AGENT-${input.ordinal % 10}`;
  const activationId = `KC10-ROUTE-ACT-${suffix}`;

  await executeCommand(db, {
    commandId: `KC10-ROUTE-CREATE-${suffix}`,
    payload: { workItemId },
    handler: async (ctx) => {
      await ctx.emit({
        streamName: `dopaiosWorkItem-${workItemId}`,
        type: "WorkItemCreated",
        data: { workItemId, runId: null, state: "READY" },
        expectedVersion: -1,
      });
      return { workItemId };
    },
  });

  const startedAt = performance.now();
  await executeCommand(db, {
    commandId: `KC10-ROUTE-ROUTED-${suffix}`,
    payload: { workItemId, agentId },
    handler: async (ctx) => {
      await ctx.emit({
        streamName: `dopaiosWorkItem-${workItemId}`,
        type: "WorkItemRouted",
        data: {
          workItemId,
          staffId: agentId,
          role: "kc10-benchmark",
          basis: { runId: input.runId, source: "kc10-benchmark" },
        },
      });
      return { workItemId, agentId };
    },
  });
  await requestActivation(db, `KC10-ROUTE-ACTIVATE-${suffix}`, {
    activationId,
    workItemId,
    agentId,
    engine: "kc10-no-model-benchmark",
  });
  const elapsedMs = performance.now() - startedAt;

  const rows = await db.execute(sql`
    SELECT state FROM dopaios_activations WHERE id = ${activationId}
  `) as unknown as Array<{ state: string }>;
  if (rows[0]?.state !== "QUEUED") {
    throw new Error(`KC-10 activation ${activationId} was not projected QUEUED`);
  }

  return {
    schema: "dopaios.kc10.route-to-activation-sample/v1",
    runId: input.runId,
    ordinal: input.ordinal,
    workItemId,
    agentId,
    activationId,
    activationState: "QUEUED",
    elapsedMs,
  };
}
