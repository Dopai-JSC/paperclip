import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  registerActor,
  createProjectShell,
  registerApprovedArtifact,
  declareProjectExternalParties,
} from "../dopaios/core/commands.ts";
import { replayProjections } from "../dopaios/core/event-store.ts";
import {
  evaluateSodExemptionGuard,
  recordSodExemptionUse,
} from "../dopaios/core/sod-guard.ts";

// ADR-031 — guard điều kiện tắt của ngoại lệ SoD một-người-vận-hành: contract
// test theo đúng bốn điều kiện vô hiệu của spec đã được CTO chấp nhận tại
// Approval Record closure wave 2 (20/08/2026), cộng nghĩa vụ audit "mọi lần
// dùng ngoại lệ ghi event kèm actor và target".

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios SoD guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const LOCAL = { deploymentMode: "local_trusted" };

describeEmbeddedPostgres("dopaios ADR-031 — guard điều kiện tắt ngoại lệ SoD", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-sod-guard-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("0 Staff người đang active: miễn trừ vô hiệu (điều kiện 1 + 4 phía 0)", async () => {
    const result = await evaluateSodExemptionGuard(db, LOCAL);
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("khác đúng một");
  });

  it("đúng một Staff người active + không Project: miễn trừ CÒN hiệu lực trong local_trusted", async () => {
    await registerActor(db, "SOD-SEED-HUMAN", {
      actorId: "PERSON-CTO",
      kind: "human",
      active: true,
      capabilities: ["orchestrator", "project-creator"],
    });
    const result = await evaluateSodExemptionGuard(db, LOCAL);
    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  it("chế độ chạy khác local_trusted: vô hiệu (điều kiện 3)", async () => {
    const result = await evaluateSodExemptionGuard(db, { deploymentMode: "authenticated" });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("local_trusted");
  });

  it("Staff người thứ hai đang active: vô hiệu; ngừng active thì hiệu lực lại (cách đọc hẹp)", async () => {
    await registerActor(db, "SOD-SEED-HUMAN-2", {
      actorId: "PERSON-2",
      kind: "human",
      active: true,
      capabilities: [],
    });
    const twoActive = await evaluateSodExemptionGuard(db, LOCAL);
    expect(twoActive.allowed).toBe(false);
    expect(twoActive.reasons.join(" ")).toContain("là 2");

    // Cách đọc hẹp "đang active" (CTO chấp nhận tường minh): người đã kết
    // thúc quan hệ làm việc không vô hiệu miễn trừ. Spike chưa có command
    // ngừng Staff người — mô phỏng trạng thái projection trực tiếp.
    await db.execute(sql`UPDATE dopaios_actors SET active = false WHERE id = 'PERSON-2'`);
    const oneActive = await evaluateSodExemptionGuard(db, LOCAL);
    expect(oneActive).toEqual({ allowed: true, reasons: [] });
  });

  it("Project active chưa khai thuộc tính có-bên-ngoài: vô hiệu; khai false: hiệu lực; khai true: vô hiệu (điều kiện 2)", async () => {
    const sha = "b".repeat(64);
    await registerApprovedArtifact(db, "SOD-SEED-TPL", {
      artifactId: "TPL-SOD",
      revision: 1,
      sha256: sha,
    });
    await createProjectShell(db, "SOD-SEED-PROJ", {
      projectId: "PROJ-SOD-1",
      actor: "PERSON-CTO",
      templateRef: { template_id: "TPL-SOD", revision: 1, sha256: sha },
      expectedTemplateSha256: sha,
      orchestrator: "PERSON-CTO",
    });

    const undeclared = await evaluateSodExemptionGuard(db, LOCAL);
    expect(undeclared.allowed).toBe(false);
    expect(undeclared.reasons.join(" ")).toContain("không xác định được thuộc tính có-bên-ngoài");

    await declareProjectExternalParties(db, "SOD-DECLARE-FALSE", {
      projectId: "PROJ-SOD-1",
      actor: "PERSON-CTO",
      hasExternalParties: false,
    });
    const internalOnly = await evaluateSodExemptionGuard(db, LOCAL);
    expect(internalOnly).toEqual({ allowed: true, reasons: [] });

    await declareProjectExternalParties(db, "SOD-DECLARE-TRUE", {
      projectId: "PROJ-SOD-1",
      actor: "PERSON-CTO",
      hasExternalParties: true,
    });
    const external = await evaluateSodExemptionGuard(db, LOCAL);
    expect(external.allowed).toBe(false);
    expect(external.reasons.join(" ")).toContain("có bên ngoài");
  });

  it("lifecycle Project không xác định được: vô hiệu (điều kiện 2, nhánh unknown state)", async () => {
    await db.execute(sql`UPDATE dopaios_projects SET state = 'TRANG-THAI-LA' WHERE id = 'PROJ-SOD-1'`);
    const result = await evaluateSodExemptionGuard(db, LOCAL);
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("không xác định được lifecycle");
    await db.execute(sql`UPDATE dopaios_projects SET state = 'PREPARING' WHERE id = 'PROJ-SOD-1'`);
  });

  it("audit: dùng ngoại lệ ghi event SodExemptionUsed kèm actor và target; projection replay giữ khai báo", async () => {
    await recordSodExemptionUse(db, "SOD-AUDIT-1", {
      actorId: "local-board",
      targetKind: "approval",
      targetId: "APPROVAL-X",
    });
    const events = (await db.execute(sql`
      SELECT type, data FROM message_store.messages
      WHERE stream_name = 'dopaiosSodExemption-APPROVAL-X'
    `)) as unknown as Array<{ type: string; data: Record<string, unknown> }>;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "SodExemptionUsed",
      data: { actorId: "local-board", targetKind: "approval", targetId: "APPROVAL-X" },
    });

    // Khai báo có-bên-ngoài là event: replay dựng lại projection giữ nguyên
    // giá trị đã khai (ADR-020 — không nguồn trạng thái thứ hai). Không so
    // snapshot toàn cục vì hai test trên mô phỏng trạng thái bằng UPDATE
    // trực tiếp (ngoài event) có chủ đích.
    await replayProjections(db);
    const projected = (await db.execute(sql`
      SELECT has_external_parties FROM dopaios_projects WHERE id = 'PROJ-SOD-1'
    `)) as unknown as Array<{ has_external_parties: boolean | null }>;
    expect(projected[0]?.has_external_parties).toBe(true);
  });
});
