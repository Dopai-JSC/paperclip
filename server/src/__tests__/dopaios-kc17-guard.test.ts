import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand } from "../dopaios/event-store.js";
import { executeCutover, setCutoverReadiness, CUTOVER_READINESS_FLAGS } from "../dopaios/cutover.js";
import {
  setupCutoverBase,
  stagePlanWithApproval,
  baseCutoverPayload,
  FX05,
  FEATURE_ID,
  ORCHESTRATOR,
  SYSTEM_ACTOR,
  AI_LEAD,
} from "./helpers/dopaios-kc17.js";

// KC-17 B2 — guard kích hoạt cutover (FX-05 C01–C04, C11 + guard phụ).
// Fixture cutover GIẢ LẬP theo kế hoạch KC-17 Mục 5.3: tiền điều kiện DS-1
// biểu diễn bằng bốn cờ readiness (QD-1, PRD revision 3 d.402); approval
// PILOT-CUTOVER chỉ được TIÊU THỤ (ngữ nghĩa phê duyệt thuộc KC-03).
// Mỗi ca âm assert ĐÚNG mã lỗi + thông điệp nêu đích danh nguyên nhân —
// chứng minh lệnh bị chặn vì đúng lý do của ca, không phải vì guard khác.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-17 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

let seq = 0;
const cmd = (label: string) => `KC17-B2-${label}-${(seq += 1)}`;

describeEmbeddedPostgres("dopaios KC-17 B2 — guard kích hoạt cutover", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc17-b2-");
    db = createDb(tempDb.connectionString);
    await setupCutoverBase(db, cmd);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function withFlagOff(flag: string, run: () => Promise<void>): Promise<void> {
    await setCutoverReadiness(db, cmd(`off-${flag}`), {
      featureId: FEATURE_ID,
      flag,
      ready: false,
      actor: ORCHESTRATOR,
    });
    try {
      await run();
    } finally {
      await setCutoverReadiness(db, cmd(`on-${flag}`), {
        featureId: FEATURE_ID,
        flag,
        ready: true,
        actor: ORCHESTRATOR,
      });
    }
  }

  // FX-05-C01/C02/C03/C11: từng tiền điều kiện DS-1 một ca âm riêng.
  const readinessCases: Array<{ caseId: string; flag: (typeof CUTOVER_READINESS_FLAGS)[number] }> = [
    { caseId: "FX-05-C01", flag: "fs005_ready" },
    { caseId: "FX-05-C11", flag: "fs006_ready" },
    { caseId: "FX-05-C02", flag: "product_baseline_p1" },
    { caseId: "FX-05-C03", flag: "adp3" },
  ];
  for (const { caseId, flag } of readinessCases) {
    it(`${caseId}: guard chặn khi ${flag} chưa đạt — không snapshot, không Cutover Record`, async () => {
      await withFlagOff(flag, async () => {
        const key = `KC17-ACT-${caseId}`;
        await expect(executeCutover(db, key, baseCutoverPayload(key))).rejects.toMatchObject({
          code: "ERR-CUTOVER-READINESS",
          message: expect.stringContaining(flag),
        });
        const snapshots = (await db.execute(
          sql`SELECT id FROM dopaios_runtime_activation_snapshots`,
        )) as unknown as unknown[];
        const records = (await db.execute(sql`SELECT id FROM dopaios_cutover_records`)) as unknown as unknown[];
        expect(snapshots).toHaveLength(0);
        expect(records).toHaveLength(0);
      });
    });
  }

  it("FX-05-C04a: approval thiếu — approvalRecordId không tồn tại bị từ chối", async () => {
    const key = "KC17-ACT-C04A";
    await expect(
      executeCutover(db, key, baseCutoverPayload(key, { approvalRecordId: "APR-KHONG-TON-TAI" })),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("không tồn tại"),
    });
  });

  it("FX-05-C04b: approval hợp lệ nhưng pin Plan khác — sai revision/hash bị từ chối", async () => {
    // Approval sạch trên một bản plan KHÁC (PLAN-V-OTHER) — tiêu thụ nó cho
    // CUTOVER-PLAN-SIM-001 phải bị chặn ở đối chiếu target revision/hash.
    await stagePlanWithApproval(db, cmd, {
      artifactId: "PLAN-V-OTHER",
      approvalRecordId: "APR-SIM-OTHER",
    });
    const key = "KC17-ACT-C04B";
    await expect(
      executeCutover(db, key, baseCutoverPayload(key, { approvalRecordId: "APR-SIM-OTHER" })),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("không duyệt đúng Plan revision/hash"),
    });
  });

  it("FX-05-C04c: approval hết hiệu lực theo expiry bị từ chối", async () => {
    await stagePlanWithApproval(db, cmd, {
      artifactId: "PLAN-V-EXPIRED",
      approvalRecordId: "APR-SIM-EXPIRED",
      expiry: { expires_at: "2026-07-30T00:00:00+07:00" },
    });
    const key = "KC17-ACT-C04C";
    await expect(
      executeCutover(
        db,
        key,
        baseCutoverPayload(key, {
          plan: { artifactId: "PLAN-V-EXPIRED", revision: 1, sha256: baseCutoverPayload(key).plan.sha256 },
          approvalRecordId: "APR-SIM-EXPIRED",
        }),
      ),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("hết hiệu lực"),
    });
  });

  it("FX-05-C04d: approval đã bị vô hiệu (ApprovalInvalidated) bị từ chối", async () => {
    await stagePlanWithApproval(db, cmd, {
      artifactId: "PLAN-V-INVALID",
      approvalRecordId: "APR-SIM-INVALID",
    });
    // Mô phỏng cơ chế vô hiệu khi target đổi nghĩa (ApprovalInvalidated) —
    // cơ chế phát event này đã được kiểm tại KC-03/KC-14/KC-15; KC-17 chỉ
    // kiểm guard TIÊU THỤ: approval mang invalidated_at không còn dùng được.
    await executeCommand(db, {
      commandId: cmd("invalidate-apr"),
      payload: { recordId: "APR-SIM-INVALID" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosApprovalRecord-APR-SIM-INVALID",
          type: "ApprovalInvalidated",
          data: { recordId: "APR-SIM-INVALID", reason: "target-changed (mô phỏng KC-17 C04d)" },
        });
        return { invalidated: true };
      },
    });
    const key = "KC17-ACT-C04D";
    await expect(
      executeCutover(
        db,
        key,
        baseCutoverPayload(key, {
          plan: { artifactId: "PLAN-V-INVALID", revision: 1, sha256: baseCutoverPayload(key).plan.sha256 },
          approvalRecordId: "APR-SIM-INVALID",
        }),
      ),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("vô hiệu"),
    });
  });

  it("guard phụ: approval outcome không phải approve bị từ chối", async () => {
    await stagePlanWithApproval(db, cmd, {
      artifactId: "PLAN-V-REJECTED",
      approvalRecordId: "APR-SIM-REJECTED",
      outcome: "reject",
    });
    const key = "KC17-ACT-OUTCOME";
    await expect(
      executeCutover(db, key, baseCutoverPayload(key, { approvalRecordId: "APR-SIM-REJECTED" })),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("'reject'"),
    });
  });

  it("guard phụ: approval không thuộc điểm PILOT-CUTOVER bị từ chối", async () => {
    await stagePlanWithApproval(db, cmd, {
      artifactId: "PLAN-V-POINT",
      approvalRecordId: "APR-SIM-POINT",
      pointId: "P0-05",
    });
    const key = "KC17-ACT-POINT";
    await expect(
      executeCutover(
        db,
        key,
        baseCutoverPayload(key, {
          plan: { artifactId: "PLAN-V-POINT", revision: 1, sha256: baseCutoverPayload(key).plan.sha256 },
          approvalRecordId: "APR-SIM-POINT",
        }),
      ),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-APPROVAL",
      message: expect.stringContaining("PILOT-CUTOVER"),
    });
  });

  it("guard phụ: nội dung Plan không khớp hash tham chiếu bị từ chối", async () => {
    const key = "KC17-ACT-PLANHASH";
    await expect(
      executeCutover(
        db,
        key,
        baseCutoverPayload(key, { planContentUtf8: `${baseCutoverPayload(key).planContentUtf8}\n` }),
      ),
    ).rejects.toMatchObject({
      code: "ERR-CUTOVER-PLAN",
      message: expect.stringContaining("không khớp hash"),
    });
  });

  it("guard phụ: authority phải là người, executor phải là system actor (UJ-11)", async () => {
    const keyAuthority = "KC17-ACT-AUTHORITY";
    await expect(
      executeCutover(db, keyAuthority, baseCutoverPayload(keyAuthority, { authorityActor: AI_LEAD })),
    ).rejects.toMatchObject({ code: "ERR-ACTOR", message: expect.stringContaining("human") });
    const keyExecutor = "KC17-ACT-EXECUTOR";
    await expect(
      executeCutover(db, keyExecutor, baseCutoverPayload(keyExecutor, { executionActor: ORCHESTRATOR })),
    ).rejects.toMatchObject({ code: "ERR-ACTOR", message: expect.stringContaining("system") });
  });

  it("guard phụ: activationKey trong payload phải trùng key của lệnh (QD-5)", async () => {
    await expect(
      executeCutover(db, "KC17-ACT-KEY-A", baseCutoverPayload("KC17-ACT-KEY-B")),
    ).rejects.toMatchObject({ code: "ERR-002" });
  });

  it("guard phụ: thiếu từng trường bắt buộc bị nêu đích danh (fail-closed)", async () => {
    const key = "KC17-ACT-MISSING";
    await expect(
      executeCutover(db, key, { ...baseCutoverPayload(key), effectiveAt: "" }),
    ).rejects.toMatchObject({ code: "ERR-002", message: expect.stringContaining("effectiveAt") });
    await expect(
      executeCutover(db, key, {
        ...baseCutoverPayload(key),
        cutoverRecordId: undefined as unknown as string,
      }),
    ).rejects.toMatchObject({ code: "ERR-002", message: expect.stringContaining("cutoverRecordId") });
  });

  it("độ phủ fixture: bốn cờ readiness và danh sách ca khớp fx-05 đã cập nhật (QD-1)", () => {
    for (const flag of CUTOVER_READINESS_FLAGS) {
      expect(FX05.readiness_flags[flag]).toBe(true);
    }
    const caseIds = FX05.cases.map((c) => c.case_id);
    expect(caseIds).toHaveLength(11);
    for (const required of ["FX-05-C01", "FX-05-C02", "FX-05-C03", "FX-05-C11", "FX-05-C06"]) {
      expect(caseIds).toContain(required);
    }
    expect(FX05.activation.activation_idempotency_key).toBe("CUTOVER-ACT-SIM-001");
    expect(SYSTEM_ACTOR).not.toBe(ORCHESTRATOR);
  });
});
