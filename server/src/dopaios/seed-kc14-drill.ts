import { readFileSync } from "node:fs";
import { createDb } from "@paperclipai/db";
import { countAllEvents, replayProjections, snapshotProjections } from "./event-store.js";
import {
  registerActor,
  registerApprovedArtifact,
  createSopDefinition,
  publishSopDefinition,
  requestTestRun,
  activateSopRun,
  runFixtureExecution,
  validateSelfCheck,
  reviewFixtureExecution,
  advanceToDecision,
  recordApproval,
  completeSopRun,
} from "./commands.js";
import { seedApprovedQualityContract } from "./seed-quality-contract.js";
import { readTwoLifecycles } from "./read-model.js";

// KC-14 drill seeder: chạy trọn ca chuẩn tắc FX-04 (fail-then-fix, AC-V1-03)
// trên DATABASE_URL (container dopaios_kc14) rồi replay đối soát — bằng chứng
// hai vòng đời tái dựng đúng từ event log trên Postgres ngoài.
// Usage: DATABASE_URL=postgres://... pnpm exec tsx server/src/dopaios/seed-kc14-drill.ts

const fx02 = JSON.parse(
  readFileSync(new URL("../../../dopaios/fixtures/fx-02-run-test-chain.json", import.meta.url), "utf8"),
);

function componentSha(pathPart: string): string {
  const component = (fx02.components as Array<{ path: string; sha256: string }>).find((c) =>
    c.path.includes(pathPart),
  );
  if (!component) throw new Error(`FX-02 component ${pathPart} not found`);
  return component.sha256;
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createDb(url);

const executor = fx02.fixture_package.executor as string;
const decider = fx02.fixture_package.decider as string;
const sopSha = componentSha("sop-business-test");
const outRev1 = componentSha("t1-output-rev1");
const selfRev1 = componentSha("t1-selfcheck-rev1");
const reviewRev1 = componentSha("t1-review-evidence-rev1");
const outRev2 = componentSha("t1-output-rev2");
const selfRev2 = componentSha("t1-selfcheck-rev2");
const reviewRev2 = componentSha("t1-review-evidence-rev2");

const QC_CHECKS = ["self-check", "independent-review"];

await registerActor(db, "KC14-DRILL-A1", {
  actorId: decider,
  kind: "human",
  active: true,
  capabilities: ["run-decider"],
});
// Hợp đồng chất lượng qua đường KC-03 thật (Approval Record hiệu lực).
const qcRef = await seedApprovedQualityContract(db, {
  id: "QC-FX04",
  outputType: "code-change",
  requiredChecks: QC_CHECKS,
  cmdPrefix: "KC14-DRILL",
});
await registerApprovedArtifact(db, "KC14-DRILL-SOP", {
  artifactId: "SOP-FX04",
  revision: 1,
  sha256: sopSha,
});
await createSopDefinition(db, "KC14-DRILL-DEF", {
  definitionId: "DEF-FX04",
  revision: 1,
  sopPin: { artifactId: "SOP-FX04", revision: 1, sha256: sopSha },
});
await publishSopDefinition(db, "KC14-DRILL-PUB", {
  definitionId: "DEF-FX04",
  definitionContentSha256: sopSha,
  expectedSopSha256: sopSha,
});
await requestTestRun(db, "KC14-DRILL-S04", {
  runId: "RUN-FX04",
  definitionRef: { definitionId: "DEF-FX04" },
  decider,
  pod: fx02.fixture_package.pod,
  fixturePackage: { id: "FX-04", reuses: "FX-02", executor },
});
await activateSopRun(db, "KC14-DRILL-S05", { runId: "RUN-FX04", workItemId: "WI-FX04-T1" });
await runFixtureExecution(db, "KC14-DRILL-S06", {
  workItemId: "WI-FX04-T1",
  executor,
  outputId: "OUT-T1-001",
  outputRevision: 1,
  contentSha256: outRev1,
  outputType: "code-change",
  qualityContractRef: qcRef,
});
await validateSelfCheck(db, "KC14-DRILL-S06B", {
  outputId: "OUT-T1-001",
  outputRevision: 1,
  evidence: { ref: "t1-selfcheck-rev1.json", sha256: selfRev1, targetSha256: outRev1, by: executor },
  expectedSha256: selfRev1,
});
await reviewFixtureExecution(db, "KC14-DRILL-S07", {
  workItemId: "WI-FX04-T1",
  outputId: "OUT-T1-001",
  outputRevision: 1,
  executor,
  reviewer: "FIXTURE-REVIEWER-001",
  reviewEvidence: {
    ref: "t1-review-evidence-rev1.json",
    sha256: reviewRev1,
    targetSha256: outRev1,
    conclusion: "ready",
  },
  expectedReviewSha256: reviewRev1,
});
await advanceToDecision(db, "KC14-DRILL-S08", {
  runId: "RUN-FX04",
  outputId: "OUT-T1-001",
  outputRevision: 1,
  packageId: "PKG-RUN-FX04",
  packageRevision: 1,
  refs: { outputId: "OUT-T1-001", revision: 1, sha256: outRev1 },
  requestId: "REQ-RUN-FX04",
});
await recordApproval(db, "KC14-DRILL-S09-REJECT", {
  requestId: "REQ-RUN-FX04",
  recordId: "AR-RUN-FX04-1",
  packageId: "PKG-RUN-FX04",
  packageRevision: 1,
  pinnedRefs: { outputId: "OUT-T1-001", revision: 1, sha256: outRev1 },
  actor: decider,
  outputId: "OUT-T1-001",
  outputRevision: 1,
  outcome: "reject",
  reEntryPoint: "T1",
  reworkWorkItemId: "WI-FX04-T1-RW",
});
await runFixtureExecution(db, "KC14-DRILL-S03", {
  workItemId: "WI-FX04-T1-RW",
  executor,
  outputId: "OUT-T1-001",
  outputRevision: 2,
  contentSha256: outRev2,
  outputType: "code-change",
  qualityContractRef: qcRef,
});
await validateSelfCheck(db, "KC14-DRILL-S04-SELF", {
  outputId: "OUT-T1-001",
  outputRevision: 2,
  evidence: { ref: "t1-selfcheck-rev2.json", sha256: selfRev2, targetSha256: outRev2, by: executor },
  expectedSha256: selfRev2,
});
await reviewFixtureExecution(db, "KC14-DRILL-S04-REV", {
  workItemId: "WI-FX04-T1-RW",
  outputId: "OUT-T1-001",
  outputRevision: 2,
  executor,
  reviewer: "FIXTURE-REVIEWER-001",
  reviewEvidence: {
    ref: "t1-review-evidence-rev2.json",
    sha256: reviewRev2,
    targetSha256: outRev2,
    conclusion: "ready",
  },
  expectedReviewSha256: reviewRev2,
});
await advanceToDecision(db, "KC14-DRILL-S04-ADV", {
  runId: "RUN-FX04",
  outputId: "OUT-T1-001",
  outputRevision: 2,
  packageId: "PKG-RUN-FX04",
  packageRevision: 2,
  refs: { outputId: "OUT-T1-001", revision: 2, sha256: outRev2 },
  requestId: "REQ-RUN-FX04-2",
});
await recordApproval(db, "KC14-DRILL-S05-APPROVE", {
  requestId: "REQ-RUN-FX04-2",
  recordId: "AR-RUN-FX04-2",
  packageId: "PKG-RUN-FX04",
  packageRevision: 2,
  pinnedRefs: { outputId: "OUT-T1-001", revision: 2, sha256: outRev2 },
  actor: decider,
  outputId: "OUT-T1-001",
  outputRevision: 2,
  openedStep: "T3",
});
await completeSopRun(db, "KC14-DRILL-S10", { runId: "RUN-FX04" });

const events = await countAllEvents(db);
const before = await snapshotProjections(db);
await replayProjections(db);
const after = await snapshotProjections(db);
const identical = JSON.stringify(before) === JSON.stringify(after);
const view = await readTwoLifecycles(db, "RUN-FX04");
console.log(`seed complete: ${events} events in message_store.messages`);
console.log(`replay byte-identical: ${identical}`);
console.log(
  `two lifecycles: work items ${view.workItems.map((w) => `${w.id}=${w.state}`).join(", ")};` +
    ` versions ${view.outputs[0]?.versions.map((v) => `r${v.revision}=${v.state}`).join(", ")}`,
);
if (!identical) process.exit(1);
process.exit(0);
