import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("recovery manifest preserves every normative RPO-0 category", async () => {
  const recovery = await import("../dopaios/kc16-recovery.ts").catch(() => ({}));
  const buildRecoveryManifest = "buildRecoveryManifest" in recovery
    ? recovery.buildRecoveryManifest as (input: unknown) => unknown
    : undefined;

  const actual = buildRecoveryManifest?.({
    backupId: "BACKUP-KC16-001",
    createdAt: "2026-08-04T05:00:00.000Z",
    source: {
      commit: "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc",
      postgresTimeline: "1",
      postgresLsn: "0/2000000",
      eventGlobalPosition: 42,
      migrationJournalSha256: "a".repeat(64),
    },
    components: {
      postgres: { path: "postgres/base.tar", sizeBytes: 11, sha256: "b".repeat(64) },
      artifacts: { path: "artifacts", inventorySha256: "c".repeat(64), fileCount: 2 },
      checkpoints: { path: "checkpoints", inventorySha256: "d".repeat(64), fileCount: 1 },
    },
    rpo0: {
      projectReleaseWorkItems: [{ id: "WI-1", state: "DONE" }],
      decisions: [{ id: "DEC-1", outcome: "approve" }],
      approvalRecords: [{ id: "APR-1", targetSha256: "e".repeat(64) }],
      auditEvents: [{ id: "AUD-1", operation: "approval-recorded" }],
      checkpoints: [{ id: "CKPT-1", sha256: "f".repeat(64) }],
      artifacts: [{ id: "ART-1", revision: 1, contentSha256: "1".repeat(64), metadataSha256: "2".repeat(64) }],
      sopRuns: [{ id: "RUN-1", state: "COMPLETED" }],
    },
  });

  assert.deepEqual(actual, {
    schema: "dopaios.kc16.recovery-manifest/v1",
    state: "prepared",
    backupId: "BACKUP-KC16-001",
    createdAt: "2026-08-04T05:00:00.000Z",
    source: {
      commit: "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc",
      postgresTimeline: "1",
      postgresLsn: "0/2000000",
      eventGlobalPosition: 42,
      migrationJournalSha256: "a".repeat(64),
    },
    components: {
      postgres: { path: "postgres/base.tar", sizeBytes: 11, sha256: "b".repeat(64) },
      artifacts: { path: "artifacts", inventorySha256: "c".repeat(64), fileCount: 2 },
      checkpoints: { path: "checkpoints", inventorySha256: "d".repeat(64), fileCount: 1 },
    },
    rpo0: {
      projectReleaseWorkItems: [{ id: "WI-1", state: "DONE" }],
      decisions: [{ id: "DEC-1", outcome: "approve" }],
      approvalRecords: [{ id: "APR-1", targetSha256: "e".repeat(64) }],
      auditEvents: [{ id: "AUD-1", operation: "approval-recorded" }],
      checkpoints: [{ id: "CKPT-1", sha256: "f".repeat(64) }],
      artifacts: [{ id: "ART-1", revision: 1, contentSha256: "1".repeat(64), metadataSha256: "2".repeat(64) }],
      sopRuns: [{ id: "RUN-1", state: "COMPLETED" }],
    },
  });
});

test("recovery manifest rejects a missing normative RPO-0 category", async () => {
  const { buildRecoveryManifest } = await import("../dopaios/kc16-recovery.ts");

  assert.throws(
    () => buildRecoveryManifest({
      backupId: "BACKUP-KC16-MISSING",
      createdAt: "2026-08-04T05:00:00.000Z",
      source: {
        commit: "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc",
        postgresTimeline: "1",
        postgresLsn: "0/2000000",
        eventGlobalPosition: 42,
        migrationJournalSha256: "a".repeat(64),
      },
      components: {
        postgres: { path: "postgres/base.tar", sizeBytes: 11, sha256: "b".repeat(64) },
        artifacts: { path: "artifacts", inventorySha256: "c".repeat(64), fileCount: 2 },
        checkpoints: { path: "checkpoints", inventorySha256: "d".repeat(64), fileCount: 1 },
      },
      rpo0: {
        projectReleaseWorkItems: [],
        decisions: [],
        approvalRecords: [],
        auditEvents: [],
        checkpoints: [],
        artifacts: [],
      },
    } as never),
    /RPO-0 category sopRuns is required/,
  );
});

test("artifact inventory is path-stable and hashes file bytes", async (t) => {
  const { inventoryDirectory } = await import("../dopaios/kc16-recovery.ts") as {
    inventoryDirectory?: (root: string) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "b.txt"), "beta", "utf8");
  await writeFile(join(root, "a.txt"), "alpha", "utf8");

  const actual = await inventoryDirectory?.(root);

  assert.deepEqual(actual, {
    entries: [
      {
        path: "a.txt",
        sha256: "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
        sizeBytes: 5,
      },
      {
        path: "nested/b.txt",
        sha256: "f44e64e75f3948e9f73f8dfa94721c4ce8cbb4f265c4790c702b2d41cfbf2753",
        sizeBytes: 4,
      },
    ],
    inventorySha256: "1d936142460f77ce1bd90b5fb556b196cff6f049c688119863c270db9a7d5e62",
    fileCount: 2,
    sizeBytes: 9,
  });
});

test("completion marker is written last and only for a checksum-valid manifest", async (t) => {
  const recovery = await import("../dopaios/kc16-recovery.ts") as {
    buildRecoveryManifest: (input: Record<string, unknown>) => Record<string, unknown>;
    writeRecoveryManifestAtomic?: (
      root: string,
      manifest: Record<string, unknown>,
      options?: { faultAt?: "before-complete" },
    ) => Promise<{ manifestSha256: string }>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = recovery.buildRecoveryManifest({
    backupId: "BACKUP-KC16-ATOMIC",
    createdAt: "2026-08-04T05:00:00.000Z",
    source: {
      commit: "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc",
      postgresTimeline: "1",
      postgresLsn: "0/2000000",
      eventGlobalPosition: 42,
      migrationJournalSha256: "a".repeat(64),
    },
    components: {
      postgres: { path: "postgres/base.tar", sizeBytes: 11, sha256: "b".repeat(64) },
      artifacts: { path: "artifacts", inventorySha256: "c".repeat(64), fileCount: 2 },
      checkpoints: { path: "checkpoints", inventorySha256: "d".repeat(64), fileCount: 1 },
    },
    rpo0: {
      projectReleaseWorkItems: [], decisions: [], approvalRecords: [], auditEvents: [],
      checkpoints: [], artifacts: [], sopRuns: [],
    },
  });

  await assert.rejects(
    () => recovery.writeRecoveryManifestAtomic?.(root, manifest, { faultAt: "before-complete" }) ?? Promise.resolve(),
    /Injected fault before completion marker/,
  );
  assert.equal((await readdir(root)).includes("COMPLETE"), false);

  const result = await recovery.writeRecoveryManifestAtomic?.(root, manifest);
  const manifestBytes = await readFile(join(root, "manifest.json"));
  const expectedSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  assert.equal(result?.manifestSha256, expectedSha256);
  assert.equal(await readFile(join(root, "manifest.sha256"), "utf8"), `${expectedSha256}\n`);
  assert.equal(await readFile(join(root, "COMPLETE"), "utf8"), `${expectedSha256}\n`);
  assert.equal(JSON.parse(manifestBytes.toString("utf8")).state, "complete");
});

test("manifest verification fails closed after manifest tampering", async (t) => {
  const recovery = await import("../dopaios/kc16-recovery.ts") as {
    buildRecoveryManifest: (input: Record<string, unknown>) => Record<string, unknown>;
    writeRecoveryManifestAtomic: (root: string, manifest: Record<string, unknown>) => Promise<unknown>;
    verifyRecoveryManifest?: (root: string) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = recovery.buildRecoveryManifest({
    backupId: "BACKUP-KC16-TAMPER",
    createdAt: "2026-08-04T05:00:00.000Z",
    source: {
      commit: "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc",
      postgresTimeline: "1",
      postgresLsn: "0/2000000",
      eventGlobalPosition: 42,
      migrationJournalSha256: "a".repeat(64),
    },
    components: {
      postgres: { path: "postgres/base.tar", sizeBytes: 11, sha256: "b".repeat(64) },
      artifacts: { path: "artifacts", inventorySha256: "c".repeat(64), fileCount: 2 },
      checkpoints: { path: "checkpoints", inventorySha256: "d".repeat(64), fileCount: 1 },
    },
    rpo0: {
      projectReleaseWorkItems: [], decisions: [], approvalRecords: [], auditEvents: [],
      checkpoints: [], artifacts: [], sopRuns: [],
    },
  });
  await recovery.writeRecoveryManifestAtomic(root, manifest);
  await writeFile(join(root, "manifest.json"), "{}\n", "utf8");

  assert.deepEqual(await recovery.verifyRecoveryManifest?.(root), {
    ok: false,
    reason: "manifest_checksum_mismatch",
  });
});

test("manifest verification reports an incomplete bundle instead of leaking ENOENT", async (t) => {
  const { verifyRecoveryManifest } = await import("../dopaios/kc16-recovery.ts");
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await verifyRecoveryManifest(root), {
    ok: false,
    reason: "manifest_incomplete",
  });
});

test("readiness stays closed when artifact health or reconciliation fails", async () => {
  const { evaluateRecoveryReadiness } = await import("../dopaios/kc16-recovery.ts") as {
    evaluateRecoveryReadiness?: (input: unknown) => unknown;
  };

  assert.deepEqual(evaluateRecoveryReadiness?.({
    application: { ok: true },
    postgres: { ok: true },
    artifact: { ok: false },
    worker: { ok: true, lastHeartbeatAgeSeconds: 10 },
    backup: { ok: true, ageSeconds: 30 },
    reconciliation: { ok: false },
  }), {
    status: "not-ready",
    blockers: ["artifact_unhealthy", "reconciliation_incomplete"],
  });
});

test("readiness rejects an unhealthy app or Postgres and stale worker or backup", async () => {
  const { evaluateRecoveryReadiness } = await import("../dopaios/kc16-recovery.ts");

  assert.deepEqual(evaluateRecoveryReadiness({
    application: { ok: false },
    postgres: { ok: false },
    artifact: { ok: true },
    worker: { ok: true, lastHeartbeatAgeSeconds: 61 },
    backup: { ok: true, ageSeconds: 301 },
    reconciliation: { ok: true },
    thresholds: { workerHeartbeatMaxAgeSeconds: 60, backupMaxAgeSeconds: 300 },
  }), {
    status: "not-ready",
    blockers: ["application_unhealthy", "postgres_unhealthy", "worker_stale", "backup_stale"],
  });
});

test("NFR-8 measurement accepts the exact detection and RTO boundaries with zero data loss", async () => {
  const { measureRecoveryObjective } = await import("../dopaios/kc16-recovery.ts") as {
    measureRecoveryObjective?: (input: unknown) => unknown;
  };

  assert.deepEqual(measureRecoveryObjective?.({
    faultAtMonotonicMs: 1_000,
    detectedAtMonotonicMs: 301_000,
    readyAtMonotonicMs: 14_401_000,
    missingConfirmedCount: 0,
    mismatchedConfirmedCount: 0,
  }), {
    detectionMs: 300_000,
    rtoMs: 14_400_000,
    rpoLossCount: 0,
    detectionPass: true,
    rtoPass: true,
    rpoPass: true,
    pass: true,
  });
});

test("migration recovery decision never restores from an unverified backup", async () => {
  const { decideMigrationRecovery } = await import("../dopaios/kc16-recovery.ts") as {
    decideMigrationRecovery?: (input: unknown) => unknown;
  };

  const cases = [
    {
      input: { phase: "before-commit", corruptionDetected: false, forwardFixVerified: false, backupVerified: true },
      expected: "rollback",
    },
    {
      input: { phase: "after-commit", corruptionDetected: false, forwardFixVerified: true, backupVerified: true },
      expected: "forward-fix",
    },
    {
      input: { phase: "after-commit", corruptionDetected: true, forwardFixVerified: false, backupVerified: true },
      expected: "restore",
    },
    {
      input: { phase: "after-commit", corruptionDetected: true, forwardFixVerified: false, backupVerified: false },
      expected: "stop",
    },
  ];

  assert.deepEqual(cases.map(({ input }) => decideMigrationRecovery?.(input)), cases.map(({ expected }) => expected));
});

test("restore journal cannot open readiness before replay and reconciliation", async () => {
  const { validateRestoreJournal } = await import("../dopaios/kc16-recovery.ts") as {
    validateRestoreJournal?: (steps: string[]) => unknown;
  };
  const valid = [
    "fence-writes",
    "verify-backup",
    "restore-postgres",
    "restore-artifacts",
    "restore-checkpoints",
    "run-migrations",
    "replay-projections",
    "reconcile",
    "open-readiness",
  ];

  assert.deepEqual(validateRestoreJournal?.(valid), { ok: true });
  assert.deepEqual(validateRestoreJournal?.([
    ...valid.slice(0, 7),
    "open-readiness",
    "reconcile",
  ]), {
    ok: false,
    reason: "step_out_of_order:open-readiness:expected:reconcile",
  });
  assert.deepEqual(validateRestoreJournal?.([...valid, "write-after-readiness"]), {
    ok: false,
    reason: "unexpected_step:write-after-readiness",
  });
});

test("confirmed file inventory rejects missing, mismatched, and orphaned bytes", async () => {
  const { compareConfirmedFileInventory } = await import("../dopaios/kc16-recovery.ts") as {
    compareConfirmedFileInventory?: (input: unknown) => unknown;
  };

  assert.deepEqual(compareConfirmedFileInventory?.({
    component: "artifacts",
    entries: [
      { path: "confirmed/expected.txt", sha256: "a".repeat(64), sizeBytes: 10 },
      { path: "confirmed/orphan.txt", sha256: "b".repeat(64), sizeBytes: 6 },
    ],
    confirmedRecords: [
      { ref: "artifacts/confirmed/expected.txt", sha256: "c".repeat(64), confirmed: true },
      { ref: "artifacts/confirmed/missing.txt", sha256: "d".repeat(64), confirmed: true },
    ],
  }), {
    ok: false,
    missing: ["confirmed/missing.txt"],
    mismatched: ["confirmed/expected.txt"],
    unexpected: ["confirmed/orphan.txt"],
  });

  assert.deepEqual(compareConfirmedFileInventory?.({
    component: "checkpoints",
    entries: [{ path: "confirmed/c.json", sha256: "e".repeat(64), sizeBytes: 3 }],
    confirmedRecords: [
      { ref: "checkpoints/confirmed/c.json", sha256: "e".repeat(64), confirmed: true },
    ],
  }), { ok: true, missing: [], mismatched: [], unexpected: [] });
});

test("RPO-0 reconciliation reports missing and hash-mismatched confirmed records", async () => {
  const { compareRpo0Snapshots } = await import("../dopaios/kc16-recovery.ts") as {
    compareRpo0Snapshots?: (expected: unknown, actual: unknown) => unknown;
  };
  const expected = {
    projectReleaseWorkItems: [], decisions: [], approvalRecords: [], auditEvents: [], checkpoints: [],
    artifacts: [{ id: "ART-1", revision: 1, contentSha256: "a".repeat(64), metadataSha256: "b".repeat(64) }],
    sopRuns: [{ id: "RUN-1", state: "COMPLETED" }],
  };
  const actual = {
    projectReleaseWorkItems: [], decisions: [], approvalRecords: [], auditEvents: [], checkpoints: [],
    artifacts: [{ id: "ART-1", revision: 1, contentSha256: "a".repeat(64), metadataSha256: "c".repeat(64) }],
    sopRuns: [],
  };

  assert.deepEqual(compareRpo0Snapshots?.(expected, actual), {
    ok: false,
    missing: ["sopRuns:RUN-1"],
    mismatched: ["artifacts:ART-1@1"],
    unexpected: [],
  });
});

test("confirmation callback runs only after live and mirror artifact bytes are durable", async (t) => {
  const { persistConfirmedFile } = await import("../dopaios/kc16-recovery.ts") as {
    persistConfirmedFile?: (input: unknown) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-confirm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const liveRoot = join(root, "live");
  const mirrorRoot = join(root, "mirror");
  let committed = false;

  const actual = await persistConfirmedFile?.({
    liveRoot,
    mirrorRoot,
    relativePath: "artifacts/ART-1/revision-1.json",
    content: Buffer.from("confirmed artifact", "utf8"),
    commitReference: async (reference: unknown) => {
      assert.equal(await readFile(join(liveRoot, "artifacts", "ART-1", "revision-1.json"), "utf8"), "confirmed artifact");
      assert.equal(await readFile(join(mirrorRoot, "artifacts", "ART-1", "revision-1.json"), "utf8"), "confirmed artifact");
      assert.deepEqual(reference, {
        path: "artifacts/ART-1/revision-1.json",
        sha256: "405f45d9465dcd3f1b8eb01787abb7ba7410764d2fa8807d1dbf8bf979d37f12",
        sizeBytes: 18,
      });
      committed = true;
    },
  });

  assert.equal(committed, true);
  assert.deepEqual(actual, {
    confirmed: true,
    reference: {
      path: "artifacts/ART-1/revision-1.json",
      sha256: "405f45d9465dcd3f1b8eb01787abb7ba7410764d2fa8807d1dbf8bf979d37f12",
      sizeBytes: 18,
    },
  });
});

test("fault after the live write never crosses the confirmation boundary", async (t) => {
  const { persistConfirmedFile } = await import("../dopaios/kc16-recovery.ts");
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-preconfirm-fault-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let committed = false;

  await assert.rejects(() => persistConfirmedFile({
    liveRoot: join(root, "live"),
    mirrorRoot: join(root, "mirror"),
    relativePath: "checkpoints/CKPT-1.json",
    content: "checkpoint",
    faultAt: "after-live",
    commitReference: async () => { committed = true; },
  }), /Injected fault after live write/);

  assert.equal(committed, false);
  assert.equal(await readFile(join(root, "live", "checkpoints", "CKPT-1.json"), "utf8"), "checkpoint");
  await assert.rejects(() => readFile(join(root, "mirror", "checkpoints", "CKPT-1.json")), /ENOENT/);
});

test("bundle verification detects artifact bytes changed after completion", async (t) => {
  const recovery = await import("../dopaios/kc16-recovery.ts") as {
    buildRecoveryManifest: (input: Record<string, unknown>) => Record<string, unknown>;
    writeRecoveryManifestAtomic: (root: string, manifest: Record<string, unknown>) => Promise<unknown>;
    verifyRecoveryBundle?: (root: string) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "postgres"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await mkdir(join(root, "checkpoints"), { recursive: true });
  await writeFile(join(root, "postgres", "base.tar"), "base", "utf8");
  await writeFile(join(root, "artifacts", "a.bin"), "artifact", "utf8");
  await writeFile(join(root, "checkpoints", "c.bin"), "checkpoint", "utf8");
  const manifest = recovery.buildRecoveryManifest({
    backupId: "BACKUP-KC16-COMPONENTS",
    createdAt: "2026-08-04T05:00:00.000Z",
    source: {
      commit: "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc",
      postgresTimeline: "1",
      postgresLsn: "0/2000000",
      eventGlobalPosition: 42,
      migrationJournalSha256: "a".repeat(64),
    },
    components: {
      postgres: {
        path: "postgres/base.tar",
        sizeBytes: 4,
        sha256: "cae662172fd450bb0cd710a769079c05bfc5d8e35efa6576edc7d0377afdd4a2",
      },
      artifacts: {
        path: "artifacts",
        inventorySha256: "6a40ea6326fd8f84a58edbf80e0eb22c5570195bd3972949dc4178b5ec4e3382",
        fileCount: 1,
      },
      checkpoints: {
        path: "checkpoints",
        inventorySha256: "ef0fa55f733466f4920afde2dbf85cd593cf42e6acf1b9a7037296c34816eac7",
        fileCount: 1,
      },
    },
    rpo0: {
      projectReleaseWorkItems: [], decisions: [], approvalRecords: [], auditEvents: [],
      checkpoints: [], artifacts: [], sopRuns: [],
    },
  });
  await recovery.writeRecoveryManifestAtomic(root, manifest);
  await writeFile(join(root, "artifacts", "a.bin"), "tampered", "utf8");

  assert.deepEqual(await recovery.verifyRecoveryBundle?.(root), {
    ok: false,
    reason: "artifact_inventory_mismatch",
  });
});
