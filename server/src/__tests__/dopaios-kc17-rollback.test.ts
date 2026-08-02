import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { readStream, snapshotProjections, replayProjections } from "../dopaios/event-store.js";
import { registerDraftArtifact } from "../dopaios/approval.js";
import {
  executeCutover,
  rollbackCutover,
  createCutoverReconciliation,
  pinReconciliationReview,
  closeReconciliation,
  recordPostClosureCutoverRevision,
  writeBootstrapState,
  sha256Utf8,
} from "../dopaios/cutover.js";
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
} from "./helpers/dopaios-kc17.js";

// KC-17 B4 — nhánh rollback chuỗi hash MỘT CHIỀU (FX-05 C09, C10 và nửa
// rolled-back của C08) theo PRD d.320: rolled-back (reconciliation ref null)
// → Reconciliation ánh xạ đúng-một-lần (residual owner–due–guard, không
// target giả) → AI-Reviewer pin mapping revision/hash trong Review Evidence
// ready → closure không pin mapping mới hơn evidence đã kiểm → revision kế
// tiếp pin Reconciliation ID@revision@hash; Reconciliation không pin ngược;
// lịch sử không bị xóa. AI-Reviewer là actor fixture giả lập (QD-4) — không
// gọi model thật.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-17 B4 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC17-B4-${label}-${(seq += 1)}`;

const ACTIVATION_KEY = FX05.activation.activation_idempotency_key;
const RECORD_ID = "CUTOVER-REC-SIM-001";
const RECON_ID = RECON_DOC.mapping_id; // CUTOVER-RECON-SIM-001
const MAPPING_ARTIFACT_ID = "CUTOVER-RECON-MAPPING-SIM-001";
const EVIDENCE_REF = "review-evidence/kc17-recon-sim-001.json";

async function rowsOf<T>(db: ReturnType<typeof createDb>, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

async function recordSha(db: ReturnType<typeof createDb>, revision: number): Promise<string> {
  const rows = await rowsOf<{ sha256: string }>(
    db,
    sql`SELECT sha256 FROM dopaios_cutover_records WHERE id = ${RECORD_ID} AND revision = ${revision}`,
  );
  expect(rows).toHaveLength(1);
  return rows[0].sha256;
}

describeEmbeddedPostgres("dopaios KC-17 B4 — nhánh rollback chuỗi hash một chiều", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let reconSha = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc17-b4-");
    db = createDb(tempDb.connectionString);
    await setupCutoverBase(db, cmd);
    await executeCutover(db, ACTIVATION_KEY, baseCutoverPayload(ACTIVATION_KEY));
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("FX-05-C10 (i): tạo Reconciliation trước khi có record rolled-back bị từ chối", async () => {
    const sha = await recordSha(db, 1);
    await expect(
      createCutoverReconciliation(db, cmd("c10i"), {
        reconciliationId: RECON_ID,
        featureId: FEATURE_ID,
        rolledBackRecordRef: { recordId: RECORD_ID, revision: 1, sha256: sha },
        mappingArtifactRef: { artifactId: MAPPING_ARTIFACT_ID, revision: 1, sha256: RECON_SHA256 },
        mappingContentUtf8: RECON_CONTENT_UTF8,
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("chỉ pin revision rolled-back"),
    });
  });

  it("FX-05-C09 (bước 1) + C08 (rolled-back): rollback tạo revision 2 với reconciliation ref null; bootstrap được khôi phục, không bị 'kết thúc' thêm lần nào", async () => {
    const result = await rollbackCutover(db, cmd("rollback"), {
      recordId: RECORD_ID,
      executionActor: SYSTEM_ACTOR,
      reason: "rollback_condition của Plan xảy ra (fixture C09)",
    });
    expect(result).toMatchObject({ revision: 2, state: "rolled-back", bootstrapRestored: true });

    const records = await rowsOf<Record<string, unknown>>(
      db,
      sql`SELECT revision, state, reconciliation_ref FROM dopaios_cutover_records
          WHERE id = ${RECORD_ID} ORDER BY revision`,
    );
    expect(records).toEqual([
      expect.objectContaining({ revision: 1, state: "effective" }),
      expect.objectContaining({ revision: 2, state: "rolled-back", reconciliation_ref: null }),
    ]);

    // C08 nửa rolled-back: record rolled-back KHÔNG kết thúc bootstrap —
    // bootstrap trở lại ACTIVE theo rollback target (nguồn duy nhất), và
    // tổng số event BootstrapWorkflowDisabled vẫn là 1 (chỉ từ effective).
    const workflows = await rowsOf<Record<string, unknown>>(db, sql`SELECT * FROM dopaios_bootstrap_workflows`);
    expect(workflows[0]["state"]).toBe("ACTIVE");
    const disabledEvents = (await readStream(db, `dopaiosBootstrapWorkflow-${BOOTSTRAP_WORKFLOW_ID}`))
      .filter((event) => event.type === "BootstrapWorkflowDisabled");
    expect(disabledEvents).toHaveLength(1);
    const writeBack = await writeBootstrapState(db, cmd("write-restored"), {
      workflowId: BOOTSTRAP_WORKFLOW_ID,
      entry: { note: "bootstrap là nguồn duy nhất sau rollback" },
      actor: ORCHESTRATOR,
    });
    expect(writeBack["accepted"]).toBe(true);

    await expect(
      rollbackCutover(db, cmd("rollback-again"), {
        recordId: RECORD_ID,
        executionActor: SYSTEM_ACTOR,
        reason: "lặp",
      }),
    ).rejects.toMatchObject({ code: "ERR-STATE" });
  });

  it("mapping hỏng bị chặn: residual target giả và pin sai revision rolled-back", async () => {
    const rolledBackSha = await recordSha(db, 2);
    // Residual mang target giả — vi phạm "residual trỏ action owner–due–guard,
    // không target giả" (PRD d.320).
    const badDoc = JSON.parse(RECON_CONTENT_UTF8) as Record<string, unknown>;
    (badDoc["residuals"] as Array<Record<string, unknown>>)[0]["target"] = "WI-GIA-001";
    const badContent = JSON.stringify(badDoc, null, 2);
    const badSha = sha256Utf8(badContent);
    await registerDraftArtifact(db, cmd("reg-bad-mapping"), {
      artifactId: "CUTOVER-RECON-MAPPING-BAD",
      revision: 1,
      sha256: badSha,
      createdBy: AI_LEAD,
      artifactType: "cutover-reconciliation-mapping",
      hasRegionSchema: false,
    });
    await expect(
      createCutoverReconciliation(db, cmd("recon-bad-residual"), {
        reconciliationId: "CUTOVER-RECON-BAD",
        featureId: FEATURE_ID,
        rolledBackRecordRef: { recordId: RECORD_ID, revision: 2, sha256: rolledBackSha },
        mappingArtifactRef: { artifactId: "CUTOVER-RECON-MAPPING-BAD", revision: 1, sha256: badSha },
        mappingContentUtf8: badContent,
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("target giả"),
    });

    // Mapping pin sai revision (pin revision 1 thay vì revision rolled-back 2).
    const wrongPinDoc = JSON.parse(RECON_CONTENT_UTF8) as Record<string, unknown>;
    (wrongPinDoc["pins_cutover_record"] as Record<string, unknown>)["revision"] = 1;
    const wrongPinContent = JSON.stringify(wrongPinDoc, null, 2);
    const wrongPinSha = sha256Utf8(wrongPinContent);
    await registerDraftArtifact(db, cmd("reg-wrongpin-mapping"), {
      artifactId: "CUTOVER-RECON-MAPPING-WRONGPIN",
      revision: 1,
      sha256: wrongPinSha,
      createdBy: AI_LEAD,
      artifactType: "cutover-reconciliation-mapping",
      hasRegionSchema: false,
    });
    await expect(
      createCutoverReconciliation(db, cmd("recon-wrongpin"), {
        reconciliationId: "CUTOVER-RECON-WRONGPIN",
        featureId: FEATURE_ID,
        rolledBackRecordRef: { recordId: RECORD_ID, revision: 2, sha256: rolledBackSha },
        mappingArtifactRef: { artifactId: "CUTOVER-RECON-MAPPING-WRONGPIN", revision: 1, sha256: wrongPinSha },
        mappingContentUtf8: wrongPinContent,
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("pin đúng revision rolled-back"),
    });
  });

  it("FX-05-C09 (bước 2): Reconciliation hợp lệ từ đúng mapping fixture; đúng-một-lần cho mỗi revision rolled-back", async () => {
    const rolledBackSha = await recordSha(db, 2);
    await registerDraftArtifact(db, cmd("reg-mapping"), {
      artifactId: MAPPING_ARTIFACT_ID,
      revision: 1,
      sha256: RECON_SHA256,
      createdBy: AI_LEAD,
      artifactType: "cutover-reconciliation-mapping",
      hasRegionSchema: false,
      storageRef: "dopaios/fixtures/content/cutover-reconciliation-mapping.json",
    });
    const result = await createCutoverReconciliation(db, cmd("recon"), {
      reconciliationId: RECON_ID,
      featureId: FEATURE_ID,
      rolledBackRecordRef: { recordId: RECORD_ID, revision: 2, sha256: rolledBackSha },
      mappingArtifactRef: { artifactId: MAPPING_ARTIFACT_ID, revision: 1, sha256: RECON_SHA256 },
      mappingContentUtf8: RECON_CONTENT_UTF8,
      executionActor: SYSTEM_ACTOR,
    });
    expect(result).toMatchObject({ reconciliationId: RECON_ID, revision: 1 });
    reconSha = result["sha256"] as string;

    const rows = await rowsOf<Record<string, unknown>>(db, sql`SELECT * FROM dopaios_cutover_reconciliations`);
    expect(rows).toHaveLength(1);
    expect(rows[0]["rolled_back_record_ref"]).toMatchObject({ recordId: RECORD_ID, revision: 2 });
    expect(rows[0]["review_evidence_ref"]).toBeNull();
    expect(rows[0]["closure"]).toBeNull();
    expect((rows[0]["mappings"] as unknown[]).length).toBe(RECON_DOC.mappings.length);
    expect((rows[0]["residuals"] as unknown[]).length).toBe(RECON_DOC.residuals.length);

    // Đúng-một-lần: revision rolled-back 2 không nhận Reconciliation thứ hai.
    await expect(
      createCutoverReconciliation(db, cmd("recon-dup"), {
        reconciliationId: "CUTOVER-RECON-SIM-002",
        featureId: FEATURE_ID,
        rolledBackRecordRef: { recordId: RECORD_ID, revision: 2, sha256: rolledBackSha },
        mappingArtifactRef: { artifactId: MAPPING_ARTIFACT_ID, revision: 1, sha256: RECON_SHA256 },
        mappingContentUtf8: RECON_CONTENT_UTF8,
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("ánh xạ đúng-một-lần"),
    });
  });

  it("FX-05-C09 (bước 3): AI-Reviewer pin đúng mapping revision/hash trong Review Evidence ready", async () => {
    // B6 (finding MAJOR cả hai lens): executor không tự review được mắt xích
    // AI-Reviewer — kind system bị chặn; vai người cũng không thay được vai
    // AI-Reviewer (QD-4).
    await expect(
      pinReconciliationReview(db, cmd("review-self"), {
        reconciliationId: RECON_ID,
        revision: 1,
        reviewer: SYSTEM_ACTOR,
        reviewEvidence: {
          ref: EVIDENCE_REF,
          conclusion: "ready",
          targetMappingRevision: 1,
          targetMappingSha256: RECON_SHA256,
        },
      }),
    ).rejects.toMatchObject({ code: "ERR-ACTOR", message: expect.stringContaining("kind 'ai'") });
    await expect(
      pinReconciliationReview(db, cmd("review-human"), {
        reconciliationId: RECON_ID,
        revision: 1,
        reviewer: ORCHESTRATOR,
        reviewEvidence: {
          ref: EVIDENCE_REF,
          conclusion: "ready",
          targetMappingRevision: 1,
          targetMappingSha256: RECON_SHA256,
        },
      }),
    ).rejects.toMatchObject({ code: "ERR-ACTOR", message: expect.stringContaining("kind 'ai'") });

    await expect(
      pinReconciliationReview(db, cmd("review-draft"), {
        reconciliationId: RECON_ID,
        revision: 1,
        reviewer: AI_REVIEWER,
        reviewEvidence: {
          ref: EVIDENCE_REF,
          conclusion: "draft",
          targetMappingRevision: 1,
          targetMappingSha256: RECON_SHA256,
        },
      }),
    ).rejects.toMatchObject({ code: "ERR-CUTOVER-CHAIN", message: expect.stringContaining("'ready'") });

    await expect(
      pinReconciliationReview(db, cmd("review-wrong-hash"), {
        reconciliationId: RECON_ID,
        revision: 1,
        reviewer: AI_REVIEWER,
        reviewEvidence: {
          ref: EVIDENCE_REF,
          conclusion: "ready",
          targetMappingRevision: 1,
          targetMappingSha256: "f".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("pin đúng mapping revision/hash"),
    });

    const pinned = await pinReconciliationReview(db, cmd("review-ok"), {
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
    expect(pinned["pinned"]).toBe(true);
  });

  it("FX-05-C09 (bước 5 chặn sớm): chưa closure thì chưa được tạo revision kế tiếp", async () => {
    await expect(
      recordPostClosureCutoverRevision(db, cmd("post-closure-early"), {
        recordId: RECORD_ID,
        reconciliationId: RECON_ID,
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("chưa closure"),
    });
  });

  it("FX-05-C10 (ii) + C09 (bước 4): closure không pin mapping mới hơn evidence; closure hợp lệ", async () => {
    // B6 (finding lens 2): closure actor phải đăng ký (human); revision phải
    // là số nguyên dương thật.
    await expect(
      closeReconciliation(db, cmd("closure-ghost"), {
        reconciliationId: RECON_ID,
        revision: 1,
        closureMappingRevision: 1,
        reviewEvidenceRef: EVIDENCE_REF,
        actor: "GHOST-KC17",
      }),
    ).rejects.toMatchObject({ code: "ERR-ACTOR" });
    await expect(
      closeReconciliation(db, cmd("closure-rev0"), {
        reconciliationId: RECON_ID,
        revision: 1,
        closureMappingRevision: 0,
        reviewEvidenceRef: EVIDENCE_REF,
        actor: ORCHESTRATOR,
      }),
    ).rejects.toMatchObject({ code: "ERR-002", message: expect.stringContaining("số nguyên dương") });

    await expect(
      closeReconciliation(db, cmd("closure-newer"), {
        reconciliationId: RECON_ID,
        revision: 1,
        closureMappingRevision: 2,
        reviewEvidenceRef: EVIDENCE_REF,
        actor: ORCHESTRATOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("mới hơn"),
    });

    await expect(
      closeReconciliation(db, cmd("closure-wrong-evidence"), {
        reconciliationId: RECON_ID,
        revision: 1,
        closureMappingRevision: 1,
        reviewEvidenceRef: "review-evidence/khac.json",
        actor: ORCHESTRATOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("đúng Review Evidence"),
    });

    const closed = await closeReconciliation(db, cmd("closure-ok"), {
      reconciliationId: RECON_ID,
      revision: 1,
      closureMappingRevision: 1,
      reviewEvidenceRef: EVIDENCE_REF,
      actor: ORCHESTRATOR,
    });
    expect(closed["closed"]).toBe(true);
  });

  it("FX-05-C09 (bước 5): revision kế tiếp pin đúng Reconciliation ID@revision@hash; lịch sử một chiều không xóa", async () => {
    const result = await recordPostClosureCutoverRevision(db, cmd("post-closure"), {
      recordId: RECORD_ID,
      reconciliationId: RECON_ID,
      executionActor: SYSTEM_ACTOR,
    });
    expect(result).toMatchObject({
      revision: 3,
      state: "rolled-back",
      reconciliationRef: { reconciliationId: RECON_ID, revision: 1, sha256: reconSha },
    });

    const records = await rowsOf<Record<string, unknown>>(
      db,
      sql`SELECT revision, state, reconciliation_ref FROM dopaios_cutover_records
          WHERE id = ${RECORD_ID} ORDER BY revision`,
    );
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ revision: 1, state: "effective", reconciliation_ref: null });
    // Một chiều: revision 2 (được Reconciliation pin) VẪN giữ reconciliation
    // ref null — không ai sửa ngược lịch sử.
    expect(records[1]).toMatchObject({ revision: 2, state: "rolled-back", reconciliation_ref: null });
    expect(records[2]).toMatchObject({
      revision: 3,
      state: "rolled-back",
      reconciliation_ref: { reconciliationId: RECON_ID, revision: 1, sha256: reconSha },
    });
  });

  it("FX-05-C10 (iii): Reconciliation pin revision Cutover kế tiếp (vòng hash) bị từ chối", async () => {
    const rev3Sha = await recordSha(db, 3);
    await expect(
      createCutoverReconciliation(db, cmd("c10iii"), {
        reconciliationId: "CUTOVER-RECON-SIM-002",
        featureId: FEATURE_ID,
        rolledBackRecordRef: { recordId: RECORD_ID, revision: 3, sha256: rev3Sha },
        mappingArtifactRef: { artifactId: MAPPING_ARTIFACT_ID, revision: 1, sha256: RECON_SHA256 },
        mappingContentUtf8: RECON_CONTENT_UTF8,
        executionActor: SYSTEM_ACTOR,
      }),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-CHAIN",
      message: expect.stringContaining("không pin ngược"),
    });
  });

  it("B6: kích hoạt lại sau rollback — approval cũ đã TIÊU THỤ và snapshot id cũ đều bị chặn", async () => {
    // Ngữ nghĩa "tiêu thụ" (finding lens 1): mỗi Approval Record chỉ dùng
    // cho một lần kích hoạt; lần mới sau rollback cần approval mới.
    const keyReuse = "KC17-ACT-RE-1";
    await expect(
      executeCutover(
        db,
        keyReuse,
        baseCutoverPayload(keyReuse, { snapshotId: "RAS-SIM-002", cutoverRecordId: "CUTOVER-REC-SIM-002" }),
      ),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("đã được tiêu thụ"),
    });
    // Snapshot id tái dùng là xung đột tất định → rejection sạch (finding
    // lens 2), không phải ERR-CONTENTION sau 5 lần retry.
    const keySnap = "KC17-ACT-RE-2";
    await expect(
      executeCutover(
        db,
        keySnap,
        baseCutoverPayload(keySnap, { cutoverRecordId: "CUTOVER-REC-SIM-002" }),
      ),
    ).rejects.toMatchObject({
      code: "ERR-STATE",
      message: expect.stringContaining("đã dùng cho lần kích hoạt trước"),
    });
  });

  it("SQR-003: replay projection sau trọn chuỗi rollback cho kết quả byte-identical", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
