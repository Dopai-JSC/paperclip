import { access, readFile, rm } from "node:fs/promises";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { createProjectShell, registerActor } from "./commands.js";
import { persistConfirmedFile } from "./kc16-recovery.js";
import {
  completeSession,
  recordSessionArtifact,
  startAiSession,
} from "./sessions.js";

const databaseUrl = process.env.DATABASE_URL;
const runtimeRoot = process.env.KC16_RUNTIME_ROOT ?? "/kc16";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const db = createDb(databaseUrl);
const fixture = JSON.parse(
  await readFile(new URL("../../../dopaios/fixtures/fx-01-none-preparing.json", import.meta.url), "utf8"),
) as {
  base_command: {
    template_ref: { template_id: string; revision: number; sha256: string };
  };
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await registerActor(db, "KC16-SEED-CREATOR", {
  actorId: "KC16-DRILL-CREATOR",
  kind: "human",
  active: true,
  capabilities: ["project-creator"],
});
await registerActor(db, "KC16-SEED-ORCHESTRATOR", {
  actorId: "KC16-DRILL-ORCHESTRATOR",
  kind: "human",
  active: true,
  capabilities: ["orchestrator"],
});
await registerActor(db, "KC16-SEED-AGENT", {
  actorId: "KC16-DRILL-AGENT",
  kind: "ai",
  active: true,
  capabilities: [],
});
await createProjectShell(db, "KC16-SEED-PROJECT", {
  projectId: "KC16-DRILL-PROJECT",
  actor: "KC16-DRILL-CREATOR",
  templateRef: fixture.base_command.template_ref,
  expectedTemplateSha256: fixture.base_command.template_ref.sha256,
  orchestrator: "KC16-DRILL-ORCHESTRATOR",
});

await startAiSession(db, "KC16-SEED-SESSION", {
  sessionId: "KC16-DRILL-SESSION",
  workItemId: "WI-FX04-T1",
  agentId: "KC16-DRILL-AGENT",
  engine: "fixture",
});

const artifactRoot = `${runtimeRoot}/artifacts`;
const checkpointRoot = `${runtimeRoot}/checkpoints`;
const artifactMirrorRoot = `${runtimeRoot}/mirror/artifacts`;
const checkpointMirrorRoot = `${runtimeRoot}/mirror/checkpoints`;
const unconfirmedRelativePath = "faults/unconfirmed-before-boundary.txt";
const unconfirmedLivePath = `${artifactRoot}/${unconfirmedRelativePath}`;
const unconfirmedMirrorPath = `${artifactMirrorRoot}/${unconfirmedRelativePath}`;
await Promise.all([
  rm(unconfirmedLivePath, { force: true }),
  rm(unconfirmedMirrorPath, { force: true }),
]);

let beforeBoundaryFaultObserved = false;
try {
  await persistConfirmedFile({
    liveRoot: artifactRoot,
    mirrorRoot: artifactMirrorRoot,
    relativePath: unconfirmedRelativePath,
    content: "not confirmed\n",
    faultAt: "after-live",
    commitReference: async () => {
      throw new Error("confirmation callback crossed the injected boundary");
    },
  });
} catch (error) {
  beforeBoundaryFaultObserved = (error as Error).message === "Injected fault after live write";
}
assert(beforeBoundaryFaultObserved, "before-confirmation fault was not observed");
assert(!(await fileExists(unconfirmedMirrorPath)), "unconfirmed bytes reached the recovery mirror");
await rm(unconfirmedLivePath, { force: true });

const output = await persistConfirmedFile({
  liveRoot: artifactRoot,
  mirrorRoot: artifactMirrorRoot,
  relativePath: "confirmed/kc16-output.txt",
  content: "Dopaios KC-16 confirmed output\n",
  commitReference: async (reference) => {
    await recordSessionArtifact(db, "KC16-SEED-OUTPUT", {
      sessionId: "KC16-DRILL-SESSION",
      seq: 1,
      kind: "output",
      ref: `artifacts/${reference.path}`,
      sha256: reference.sha256,
      confirmed: true,
    });
  },
});

const checkpoint = await persistConfirmedFile({
  liveRoot: checkpointRoot,
  mirrorRoot: checkpointMirrorRoot,
  relativePath: "confirmed/kc16-checkpoint.json",
  content: `${JSON.stringify({ sessionId: "KC16-DRILL-SESSION", sequence: 2, state: "durable" })}\n`,
  commitReference: async (reference) => {
    await recordSessionArtifact(db, "KC16-SEED-CHECKPOINT", {
      sessionId: "KC16-DRILL-SESSION",
      seq: 2,
      kind: "checkpoint",
      ref: `checkpoints/${reference.path}`,
      sha256: reference.sha256,
      confirmed: true,
    });
  },
});

await completeSession(db, "KC16-SEED-SESSION-COMPLETE", {
  sessionId: "KC16-DRILL-SESSION",
  outcome: "succeeded",
});

await startAiSession(db, "KC16-SEED-RECON-SESSION", {
  sessionId: "KC16-DRILL-RECON-SESSION",
  workItemId: "WI-FX04-T1-RW",
  agentId: "KC16-DRILL-AGENT",
  engine: "fake-connector",
});
const fakeReconciliation = await persistConfirmedFile({
  liveRoot: artifactRoot,
  mirrorRoot: artifactMirrorRoot,
  relativePath: "confirmed/github-fake-reconciliation.json",
  content: `${JSON.stringify({
    schema: "dopaios.kc16.github-reconciliation/v1",
    connector: "FakeConnector",
    repository: "local-fixture/paperclip",
    headSha: "0000000000000000000000000000000000000016",
    requiredChecks: ["SDD governance"],
    observedChecks: [{ name: "SDD governance", conclusion: "success" }],
    status: "reconciled",
    productionOracle: "deferred",
  })}\n`,
  commitReference: async (reference) => {
    await recordSessionArtifact(db, "KC16-SEED-RECON-EVIDENCE", {
      sessionId: "KC16-DRILL-RECON-SESSION",
      seq: 1,
      kind: "reconciliation-evidence",
      ref: `artifacts/${reference.path}`,
      sha256: reference.sha256,
      confirmed: true,
    });
  },
});
await completeSession(db, "KC16-SEED-RECON-SESSION-COMPLETE", {
  sessionId: "KC16-DRILL-RECON-SESSION",
  outcome: "succeeded",
});

const references = (await db.execute(sql`
  SELECT kind, ref, sha256, confirmed
  FROM dopaios_session_artifacts
  WHERE session_id = 'KC16-DRILL-SESSION'
  ORDER BY seq
`)) as unknown as Array<{ kind: string; ref: string; sha256: string; confirmed: boolean }>;
assert(references.length === 2, `expected 2 confirmed references, found ${references.length}`);
assert(references.every((reference) => reference.confirmed), "a recovery reference is not confirmed");
assert(references[0]?.sha256 === output.reference.sha256, "artifact checksum/reference mismatch");
assert(references[1]?.sha256 === checkpoint.reference.sha256, "checkpoint checksum/reference mismatch");
const reconciliationReferences = (await db.execute(sql`
  SELECT sha256, confirmed
  FROM dopaios_session_artifacts
  WHERE session_id = 'KC16-DRILL-RECON-SESSION' AND kind = 'reconciliation-evidence'
`)) as unknown as Array<{ sha256: string; confirmed: boolean }>;
assert(reconciliationReferences.length === 1, "expected one FakeConnector reconciliation record");
assert(reconciliationReferences[0]?.confirmed, "FakeConnector reconciliation is not confirmed");
assert(
  reconciliationReferences[0]?.sha256 === fakeReconciliation.reference.sha256,
  "FakeConnector reconciliation checksum/reference mismatch",
);

console.log("PASS before-confirmation fault did not cross the confirmation boundary");
console.log("PASS artifact and checkpoint were durably mirrored before database confirmation");
console.log("PASS FakeConnector reconciliation is confirmed; production oracle remains deferred");
console.log(`confirmed references: ${references.length + reconciliationReferences.length}`);
process.exit(0);
