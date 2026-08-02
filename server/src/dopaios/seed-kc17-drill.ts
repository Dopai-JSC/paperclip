import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  countAllEvents,
  replayProjections,
  snapshotProjections,
} from "./event-store.js";
import {
  executeCutover,
  rollbackCutover,
  createCutoverReconciliation,
  pinReconciliationReview,
  closeReconciliation,
  recordPostClosureCutoverRevision,
  writeBootstrapState,
} from "./cutover.js";
import { registerDraftArtifact } from "./approval.js";
import {
  setupCutoverBase,
  baseCutoverPayload,
  FX05,
  FEATURE_ID,
  BOOTSTRAP_WORKFLOW_ID,
  ORCHESTRATOR,
  SYSTEM_ACTOR,
  AI_LEAD,
  AI_REVIEWER,
  RECON_CONTENT_UTF8,
  RECON_SHA256,
  RECON_DOC,
} from "../__tests__/helpers/dopaios-kc17.js";

// KC-17 B5: diễn tập trên Postgres NGOÀI (container dopaios-spike-pg, DB
// dopaios_kc17) — chạy trọn kịch bản FX-05 trên đúng hạ tầng dùng chung của
// môi trường spike: kích hoạt effective → replay idempotent → chặn đường ghi
// song song → rollback → trọn chuỗi reconciliation 5 bước → replay projection
// byte-identical. Số liệu in ra là bằng chứng đính hồ sơ (log kc17-drill.log).
//
//   DATABASE_URL=postgres://…/dopaios_kc17 pnpm exec tsx src/dopaios/seed-kc17-drill.ts

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Cần DATABASE_URL trỏ DB dopaios_kc17");
  process.exit(1);
}

function assert(condition: unknown, label: string): void {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    process.exit(1);
  }
  console.log(`PASS  ${label}`);
}

const db = createDb(DATABASE_URL);
let seq = 0;
const cmd = (label: string) => `KC17-DRILL-${label}-${(seq += 1)}`;
const ACTIVATION_KEY = FX05.activation.activation_idempotency_key;
const RECORD_ID = "CUTOVER-REC-SIM-001";
const RECON_ID = RECON_DOC.mapping_id;
const MAPPING_ARTIFACT_ID = "CUTOVER-RECON-MAPPING-SIM-001";
const EVIDENCE_REF = "review-evidence/kc17-recon-sim-001.json";

async function main(): Promise<void> {
  await setupCutoverBase(db, cmd);
  console.log(`drill DB: ${DATABASE_URL!.split("@").pop()}`);

  const preWrite = await writeBootstrapState(db, cmd("write-before"), {
    workflowId: BOOTSTRAP_WORKFLOW_ID,
    entry: { note: "drill: ghi bootstrap trước cutover" },
    actor: ORCHESTRATOR,
  });
  assert(preWrite["accepted"] === true, "đường ghi bootstrap hợp lệ trước cutover");

  const activated = await executeCutover(db, ACTIVATION_KEY, baseCutoverPayload(ACTIVATION_KEY));
  assert(activated["activated"] === true, "kích hoạt effective (C05)");
  const eventsAfterActivation = await countAllEvents(db);

  const replay = await executeCutover(db, ACTIVATION_KEY, baseCutoverPayload(ACTIVATION_KEY));
  assert(replay["idempotentReplay"] === true, "replay idempotent (C06 — AC-V1-10)");
  assert((await countAllEvents(db)) === eventsAfterActivation, "replay không thêm event");

  let parallelBlocked = false;
  try {
    await writeBootstrapState(db, cmd("write-after"), {
      workflowId: BOOTSTRAP_WORKFLOW_ID,
      entry: { note: "drill: ghi song song sau cutover" },
      actor: ORCHESTRATOR,
    });
  } catch (error) {
    parallelBlocked = (error as { code?: string }).code === "ERR-CUTOVER-PARALLEL-WRITE";
  }
  assert(parallelBlocked, "đường ghi song song bị chặn sau effective");

  const rolledBack = await rollbackCutover(db, cmd("rollback"), {
    recordId: RECORD_ID,
    executionActor: SYSTEM_ACTOR,
    reason: "drill: rollback_condition của Plan xảy ra",
  });
  assert(rolledBack["state"] === "rolled-back", "rollback tạo revision rolled-back (C09 bước 1)");

  const rev2 = (await db.execute(
    sql`SELECT sha256 FROM dopaios_cutover_records WHERE id = ${RECORD_ID} AND revision = 2`,
  )) as unknown as Array<{ sha256: string }>;
  await registerDraftArtifact(db, cmd("reg-mapping"), {
    artifactId: MAPPING_ARTIFACT_ID,
    revision: 1,
    sha256: RECON_SHA256,
    createdBy: AI_LEAD,
    artifactType: "cutover-reconciliation-mapping",
    hasRegionSchema: false,
    storageRef: "dopaios/fixtures/content/cutover-reconciliation-mapping.json",
  });
  const recon = await createCutoverReconciliation(db, cmd("recon"), {
    reconciliationId: RECON_ID,
    featureId: FEATURE_ID,
    rolledBackRecordRef: { recordId: RECORD_ID, revision: 2, sha256: rev2[0].sha256 },
    mappingArtifactRef: { artifactId: MAPPING_ARTIFACT_ID, revision: 1, sha256: RECON_SHA256 },
    mappingContentUtf8: RECON_CONTENT_UTF8,
    executionActor: SYSTEM_ACTOR,
  });
  assert(recon["revision"] === 1, "Reconciliation tạo từ đúng mapping fixture (C09 bước 2)");

  await pinReconciliationReview(db, cmd("review"), {
    reconciliationId: RECON_ID,
    revision: 1,
    reviewer: AI_REVIEWER,
    reviewEvidence: {
      ref: EVIDENCE_REF,
      conclusion: "ready",
      targetMappingRevision: 1,
      targetMappingSha256: RECON_SHA256,
    },
  });
  console.log("PASS  AI-Reviewer pin mapping revision/hash — Review Evidence ready (C09 bước 3)");

  await closeReconciliation(db, cmd("closure"), {
    reconciliationId: RECON_ID,
    revision: 1,
    closureMappingRevision: 1,
    reviewEvidenceRef: EVIDENCE_REF,
    actor: ORCHESTRATOR,
  });
  console.log("PASS  closure pin mapping revision đã kiểm (C09 bước 4)");

  const post = await recordPostClosureCutoverRevision(db, cmd("post-closure"), {
    recordId: RECORD_ID,
    reconciliationId: RECON_ID,
    executionActor: SYSTEM_ACTOR,
  });
  assert(post["revision"] === 3, "revision kế tiếp pin Reconciliation ID@revision@hash (C09 bước 5)");

  const records = (await db.execute(
    sql`SELECT revision, state FROM dopaios_cutover_records WHERE id = ${RECORD_ID} ORDER BY revision`,
  )) as unknown as Array<{ revision: number; state: string }>;
  assert(
    records.length === 3 && records[0].state === "effective" && records[2].state === "rolled-back",
    "lịch sử 3 revision đầy đủ, không xóa",
  );

  const before = await snapshotProjections(db);
  await replayProjections(db);
  const after = await snapshotProjections(db);
  assert(JSON.stringify(after) === JSON.stringify(before), "replay projection byte-identical (SQR-003)");

  console.log(`tổng event: ${await countAllEvents(db)}`);
  console.log("KC-17 DRILL PASS");
}

await main();
process.exit(0);
