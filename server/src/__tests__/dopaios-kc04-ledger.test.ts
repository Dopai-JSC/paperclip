import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { replayProjections, snapshotProjections } from "../dopaios/event-store.ts";
import { registerActor, registerApprovedArtifact } from "../dopaios/commands.ts";
import { registerDraftArtifact } from "../dopaios/approval.ts";
import { createArtifactRevision } from "../dopaios/lifecycle.ts";

// KC-04 B1: provenance TAMPERED by production actor (migration 0515) — hợp
// đồng input "Danh sách nguồn" d.629 + EDGE-001 (pin ID@revision hoặc hash,
// không "latest"; thiếu → danh sách rỗng) và "nơi lưu" theo tiêu chí 2 của
// kế hoạch KC-04. Ba cửa đăng ký (fixture approved, draft FS-002,
// create-revision) đi cùng một parser fail-closed; projection tái dựng từ
// event log (SQR-003).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-04 B1 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const SHA_SPEC = "a".repeat(64);
const SHA_CODE = "b".repeat(64);
const SHA_EXTERNAL = "c".repeat(64);
const SHA_REV2 = "d".repeat(64);

describeEmbeddedPostgres("dopaios KC-04 B1 — provenance sổ cái artifact", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  async function artifactRow(id: string, revision: number): Promise<Record<string, unknown> | undefined> {
    const rows = (await db.execute(
      sql`SELECT id, revision, sha256, artifact_state, source_refs, storage_ref
          FROM dopaios_artifacts WHERE id = ${id} AND revision = ${revision}`,
    )) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc04-b1-");
    db = createDb(tempDb.connectionString);
    await registerActor(db, "KC04-B1-ACTOR", {
      actorId: "AUTHOR-KC04",
      kind: "ai",
      active: true,
      capabilities: ["producer"],
    });
    // Nguồn approved trong sổ để các ca dưới pin ID@revision.
    await registerApprovedArtifact(db, "KC04-B1-SRC", {
      artifactId: "ART-KC04-SPEC",
      revision: 1,
      sha256: SHA_SPEC,
      artifactType: "feature-spec",
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("đăng ký draft với nguồn pin ID@revision@sha256 và nơi lưu → projection đủ hai cột", async () => {
    await registerDraftArtifact(db, "KC04-B1-T1", {
      artifactId: "ART-KC04-CODE",
      revision: 1,
      sha256: SHA_CODE,
      createdBy: "AUTHOR-KC04",
      artifactType: "code",
      hasRegionSchema: false,
      sourceRefs: [{ artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC }],
      storageRef: `fixtures/content/${SHA_CODE}.md`,
    });
    const row = await artifactRow("ART-KC04-CODE", 1);
    expect(row).toMatchObject({
      artifact_state: "draft",
      source_refs: [{ artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC }],
      storage_ref: `fixtures/content/${SHA_CODE}.md`,
    });
  });

  it("EDGE-001: không khai nguồn → danh sách rỗng; không khai nơi lưu → null", async () => {
    await registerDraftArtifact(db, "KC04-B1-T2", {
      artifactId: "ART-KC04-BRIEF",
      revision: 1,
      sha256: SHA_EXTERNAL,
      createdBy: "AUTHOR-KC04",
      artifactType: "brief",
      hasRegionSchema: false,
    });
    const row = await artifactRow("ART-KC04-BRIEF", 1);
    expect(row?.["source_refs"]).toEqual([]);
    expect(row?.["storage_ref"]).toBeNull();
  });

  it('pin "latest" hoặc ID thiếu revision bị từ chối fail-closed, không để lại row', async () => {
    await expect(
      registerDraftArtifact(db, "KC04-B1-T3A", {
        artifactId: "ART-KC04-BAD",
        revision: 1,
        sha256: SHA_CODE,
        createdBy: "AUTHOR-KC04",
        artifactType: "code",
        hasRegionSchema: false,
        sourceRefs: [{ artifactId: "ART-KC04-SPEC", revision: "latest" as unknown as number }],
      }),
    ).rejects.toMatchObject({ code: "ERR-SOURCE-PIN" });
    await expect(
      registerDraftArtifact(db, "KC04-B1-T3B", {
        artifactId: "ART-KC04-BAD",
        revision: 1,
        sha256: SHA_CODE,
        createdBy: "AUTHOR-KC04",
        artifactType: "code",
        hasRegionSchema: false,
        sourceRefs: [{ artifactId: "ART-KC04-SPEC" }],
      }),
    ).rejects.toMatchObject({ code: "ERR-SOURCE-PIN" });
    const rows = (await db.execute(
      sql`SELECT revision FROM dopaios_artifacts WHERE id = ${"ART-KC04-BAD"}`,
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([]);
  });

  it("pin hash đứng một mình hợp lệ — nguồn ngoài sổ chỉ có nội dung bất biến", async () => {
    await registerDraftArtifact(db, "KC04-B1-T4", {
      artifactId: "ART-KC04-NOTES",
      revision: 1,
      sha256: SHA_CODE,
      createdBy: "AUTHOR-KC04",
      artifactType: "notes",
      hasRegionSchema: false,
      sourceRefs: [{ sha256: SHA_EXTERNAL }],
      storageRef: `fixtures/content/${SHA_CODE}.md`,
    });
    const row = await artifactRow("ART-KC04-NOTES", 1);
    expect(row?.["source_refs"]).toEqual([{ sha256: SHA_EXTERNAL }]);
  });

  it("create-revision khai lại nguồn và nơi lưu — bản cũ bất biến, không kế thừa im lặng", async () => {
    await createArtifactRevision(db, "KC04-B1-T5", {
      artifactId: "ART-KC04-CODE",
      revision: 2,
      sha256: SHA_REV2,
      createdBy: "AUTHOR-KC04",
      semanticChange: false,
      dependents: [],
      sourceRefs: [{ sha256: SHA_EXTERNAL }],
      storageRef: `fixtures/content/${SHA_REV2}.md`,
    });
    const rev2 = await artifactRow("ART-KC04-CODE", 2);
    expect(rev2).toMatchObject({
      source_refs: [{ sha256: SHA_EXTERNAL }],
      storage_ref: `fixtures/content/${SHA_REV2}.md`,
    });
    // Bản 1 giữ nguyên bằng chứng đăng ký của nó — không bị ghi đè.
    const rev1 = await artifactRow("ART-KC04-CODE", 1);
    expect(rev1).toMatchObject({
      sha256: SHA_CODE,
      source_refs: [{ artifactId: "ART-KC04-SPEC", revision: 1, sha256: SHA_SPEC }],
      storage_ref: `fixtures/content/${SHA_CODE}.md`,
    });
    // Không kế thừa: revision mới không khai nguồn → danh sách rỗng.
    await createArtifactRevision(db, "KC04-B1-T5B", {
      artifactId: "ART-KC04-CODE",
      revision: 3,
      sha256: SHA_SPEC,
      createdBy: "AUTHOR-KC04",
      semanticChange: false,
      dependents: [],
    });
    const rev3 = await artifactRow("ART-KC04-CODE", 3);
    expect(rev3?.["source_refs"]).toEqual([]);
    expect(rev3?.["storage_ref"]).toBeNull();
  });

  it("replay dựng lại projection y hệ từ event log (SQR-003)", async () => {
    const before = await snapshotProjections(db);
    await replayProjections(db);
    const after = await snapshotProjections(db);
    expect(after).toEqual(before);
  });
});
