import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { countAllEvents } from "./event-store.js";
import {
  activateSopRun,
  advanceToDecision,
  completeSopRun,
  createProjectShell,
  createSopDefinition,
  publishSopDefinition,
  recordApproval,
  registerActor,
  registerApprovedArtifact,
  requestTestRun,
  reviewFixtureExecution,
  runFixtureExecution,
  validateSelfCheck,
} from "./commands.js";
import { seedApprovedQualityContract } from "./seed-quality-contract.js";

// KC-01 drill seeder: drives the canonical fixture chain (fx-01 C01 +
// fx-02 S01–S10) against DATABASE_URL so the schema-evolution and
// backup/restore drills run over real event-sourced sample data.
// Usage: DATABASE_URL=postgres://... pnpm exec tsx server/src/dopaios/seed-kc01-drill.ts

const fx01 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-01-none-preparing.json", import.meta.url), "utf8"),
);
const fx02 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-02-run-test-chain.json", import.meta.url), "utf8"),
);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const templateSha256 = fx01.components[0].sha256 as string;
const sopSha256 = fx02.components[0].sha256 as string;
const outputSha256 = fx02.components.find((c: { path: string }) => c.path.includes("t1-output-rev1"))
  ?.sha256 as string;
const selfCheckSha256 = fx02.components.find((c: { path: string }) => c.path.includes("t1-selfcheck-rev1"))
  ?.sha256 as string;
const reviewSha256 = fx02.components.find((c: { path: string }) =>
  c.path.includes("t1-review-evidence-rev1"),
)?.sha256 as string;

// KC-14: Hợp đồng chất lượng đã duyệt theo đường sổ FS-002 (QD-2).
const QC_CHECKS = ["self-check", "independent-review"];

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

await createProjectShell(db, "CMD-FX01-C01", {
  projectId: "PROJECT-FX01",
  actor: "STAFF-HUMAN-CREATOR-001",
  templateRef: fx01.base_command.template_ref,
  expectedTemplateSha256: templateSha256,
  orchestrator: "STAFF-HUMAN-ORCH-001",
});
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
await activateSopRun(db, "CMD-FX02-S05", { runId: "RUN-T-001", workItemId: "WI-T1-001" });
const qcRef = await seedApprovedQualityContract(db, {
  id: "QC-FX02",
  outputType: "code-change",
  requiredChecks: QC_CHECKS,
  cmdPrefix: "CMD-FX02",
});
await runFixtureExecution(db, "CMD-FX02-S06", {
  workItemId: "WI-T1-001",
  executor: fx02.fixture_package.executor,
  outputId: "OUT-T1-001",
  outputRevision: 1,
  contentSha256: outputSha256,
  outputType: "code-change",
  qualityContractRef: qcRef,
});
await validateSelfCheck(db, "CMD-FX02-S06B", {
  outputId: "OUT-T1-001",
  outputRevision: 1,
  evidence: {
    ref: "t1-selfcheck-rev1.json",
    sha256: selfCheckSha256,
    targetSha256: outputSha256,
    by: fx02.fixture_package.executor,
  },
  expectedSha256: selfCheckSha256,
});
await reviewFixtureExecution(db, "CMD-FX02-S07", {
  workItemId: "WI-T1-001",
  outputId: "OUT-T1-001",
  outputRevision: 1,
  executor: fx02.fixture_package.executor,
  reviewer: "FIXTURE-REVIEWER-001",
  reviewEvidence: {
    ref: "t1-review-evidence-rev1.json",
    sha256: reviewSha256,
    targetSha256: outputSha256,
    conclusion: "ready",
  },
  expectedReviewSha256: reviewSha256,
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
await recordApproval(db, "CMD-FX02-S09", {
  requestId: "REQ-T2-001",
  recordId: "AR-T2-001",
  packageId: "PKG-T2-001",
  packageRevision: 1,
  pinnedRefs: refs,
  actor: fx02.fixture_package.decider,
  outputId: "OUT-T1-001",
  outputRevision: 1,
});
await completeSopRun(db, "CMD-FX02-S10", { runId: "RUN-T-001" });

console.log(`seed complete: ${await countAllEvents(db)} events in message_store.messages`);
process.exit(0);
