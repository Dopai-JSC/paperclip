import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type RecoveryManifestInput = {
  backupId: string;
  createdAt: string;
  source: {
    commit: string;
    postgresTimeline: string;
    postgresLsn: string;
    eventGlobalPosition: number;
    migrationJournalSha256: string;
  };
  components: {
    postgres: { path: string; sizeBytes: number; sha256: string };
    artifacts: { path: string; inventorySha256: string; fileCount: number };
    checkpoints: { path: string; inventorySha256: string; fileCount: number };
  };
  rpo0: {
    projectReleaseWorkItems: Array<Record<string, unknown>>;
    decisions: Array<Record<string, unknown>>;
    approvalRecords: Array<Record<string, unknown>>;
    auditEvents: Array<Record<string, unknown>>;
    checkpoints: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    sopRuns: Array<Record<string, unknown>>;
  };
};

const RPO0_CATEGORIES = [
  "projectReleaseWorkItems",
  "decisions",
  "approvalRecords",
  "auditEvents",
  "checkpoints",
  "artifacts",
  "sopRuns",
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function writeSyncedFile(path: string, content: string | Buffer): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") throw error;
  }
}

function resolveScopedPath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Recovery path escapes its root: ${relativePath}`);
  }
  return target;
}

async function writeAtomicFile(root: string, relativePath: string, content: Buffer): Promise<void> {
  const target = resolveScopedPath(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeSyncedFile(temporary, content);
  await rename(temporary, target);
  await syncDirectory(dirname(target));
}

export async function inventoryDirectory(root: string) {
  const entries: Array<{ path: string; sha256: string; sizeBytes: number }> = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        await visit(absolutePath);
      } else if (child.isFile()) {
        const content = await readFile(absolutePath);
        entries.push({
          path: relative(root, absolutePath).split(sep).join("/"),
          sha256: sha256(content),
          sizeBytes: content.length,
        });
      }
    }
  }

  await visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    entries,
    inventorySha256: sha256(JSON.stringify(entries)),
    fileCount: entries.length,
    sizeBytes: entries.reduce((total, entry) => total + entry.sizeBytes, 0),
  };
}

export function buildRecoveryManifest(input: RecoveryManifestInput) {
  for (const category of RPO0_CATEGORIES) {
    if (!Array.isArray(input.rpo0?.[category])) {
      throw new Error(`RPO-0 category ${category} is required`);
    }
  }
  return {
    schema: "dopaios.kc16.recovery-manifest/v1",
    state: "prepared",
    backupId: input.backupId,
    createdAt: input.createdAt,
    source: input.source,
    components: input.components,
    rpo0: input.rpo0,
  };
}

export async function writeRecoveryManifestAtomic(
  root: string,
  manifest: ReturnType<typeof buildRecoveryManifest>,
  options?: { faultAt?: "before-complete" },
): Promise<{ manifestSha256: string }> {
  await mkdir(root, { recursive: true });
  await rm(join(root, "COMPLETE"), { force: true });

  const completeManifest = { ...manifest, state: "complete" };
  const manifestBytes = Buffer.from(`${JSON.stringify(completeManifest, null, 2)}\n`, "utf8");
  const manifestSha256 = sha256(manifestBytes);

  await writeSyncedFile(join(root, "manifest.json.tmp"), manifestBytes);
  await rename(join(root, "manifest.json.tmp"), join(root, "manifest.json"));
  await syncDirectory(root);

  await writeSyncedFile(join(root, "manifest.sha256.tmp"), `${manifestSha256}\n`);
  await rename(join(root, "manifest.sha256.tmp"), join(root, "manifest.sha256"));
  await syncDirectory(root);

  if (options?.faultAt === "before-complete") {
    throw new Error("Injected fault before completion marker");
  }

  await writeSyncedFile(join(root, "COMPLETE.tmp"), `${manifestSha256}\n`);
  await rename(join(root, "COMPLETE.tmp"), join(root, "COMPLETE"));
  await syncDirectory(root);
  return { manifestSha256 };
}

export async function verifyRecoveryManifest(root: string): Promise<
  | { ok: true; manifestSha256: string; manifest: Record<string, unknown> }
  | { ok: false; reason: string }
> {
  try {
    const expectedSha256 = (await readFile(join(root, "manifest.sha256"), "utf8")).trim();
    const completionSha256 = (await readFile(join(root, "COMPLETE"), "utf8")).trim();
    if (completionSha256 !== expectedSha256) {
      return { ok: false, reason: "completion_marker_mismatch" };
    }

    const manifestBytes = await readFile(join(root, "manifest.json"));
    if (sha256(manifestBytes) !== expectedSha256) {
      return { ok: false, reason: "manifest_checksum_mismatch" };
    }

    return {
      ok: true,
      manifestSha256: expectedSha256,
      manifest: JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "manifest_incomplete" };
    }
    if (error instanceof SyntaxError) return { ok: false, reason: "manifest_invalid_json" };
    throw error;
  }
}

export async function verifyRecoveryBundle(root: string): Promise<
  | { ok: true; manifestSha256: string; manifest: Record<string, unknown> }
  | { ok: false; reason: string }
> {
  const verified = await verifyRecoveryManifest(root);
  if (!verified.ok) return verified;
  const components = verified.manifest.components as RecoveryManifestInput["components"];

  const postgresBytes = await readFile(resolveScopedPath(root, components.postgres.path));
  if (
    postgresBytes.length !== components.postgres.sizeBytes ||
    sha256(postgresBytes) !== components.postgres.sha256
  ) {
    return { ok: false, reason: "postgres_backup_mismatch" };
  }

  const artifactInventory = await inventoryDirectory(resolveScopedPath(root, components.artifacts.path));
  if (
    artifactInventory.fileCount !== components.artifacts.fileCount ||
    artifactInventory.inventorySha256 !== components.artifacts.inventorySha256
  ) {
    return { ok: false, reason: "artifact_inventory_mismatch" };
  }

  const checkpointInventory = await inventoryDirectory(resolveScopedPath(root, components.checkpoints.path));
  if (
    checkpointInventory.fileCount !== components.checkpoints.fileCount ||
    checkpointInventory.inventorySha256 !== components.checkpoints.inventorySha256
  ) {
    return { ok: false, reason: "checkpoint_inventory_mismatch" };
  }

  return verified;
}

export function evaluateRecoveryReadiness(input: {
  application: { ok: boolean };
  postgres: { ok: boolean };
  artifact: { ok: boolean };
  worker: { ok: boolean; lastHeartbeatAgeSeconds: number };
  backup: { ok: boolean; ageSeconds: number };
  reconciliation: { ok: boolean };
  thresholds?: { workerHeartbeatMaxAgeSeconds: number; backupMaxAgeSeconds: number };
}) {
  const blockers: string[] = [];
  if (!input.application.ok) blockers.push("application_unhealthy");
  if (!input.postgres.ok) blockers.push("postgres_unhealthy");
  if (!input.artifact.ok) blockers.push("artifact_unhealthy");
  if (!input.worker.ok) {
    blockers.push("worker_unhealthy");
  } else if (
    input.thresholds &&
    input.worker.lastHeartbeatAgeSeconds > input.thresholds.workerHeartbeatMaxAgeSeconds
  ) {
    blockers.push("worker_stale");
  }
  if (!input.backup.ok) {
    blockers.push("backup_unhealthy");
  } else if (
    input.thresholds &&
    input.backup.ageSeconds > input.thresholds.backupMaxAgeSeconds
  ) {
    blockers.push("backup_stale");
  }
  if (!input.reconciliation.ok) blockers.push("reconciliation_incomplete");
  return {
    status: blockers.length === 0 ? "ready" : "not-ready",
    blockers,
  };
}

export function measureRecoveryObjective(input: {
  faultAtMonotonicMs: number;
  detectedAtMonotonicMs: number;
  readyAtMonotonicMs: number;
  missingConfirmedCount: number;
  mismatchedConfirmedCount: number;
}) {
  const detectionMs = input.detectedAtMonotonicMs - input.faultAtMonotonicMs;
  const rtoMs = input.readyAtMonotonicMs - input.faultAtMonotonicMs;
  const rpoLossCount = input.missingConfirmedCount + input.mismatchedConfirmedCount;
  const detectionPass = detectionMs <= 5 * 60 * 1_000;
  const rtoPass = rtoMs <= 4 * 60 * 60 * 1_000;
  const rpoPass = rpoLossCount === 0;
  return {
    detectionMs,
    rtoMs,
    rpoLossCount,
    detectionPass,
    rtoPass,
    rpoPass,
    pass: detectionPass && rtoPass && rpoPass,
  };
}

export function decideMigrationRecovery(input: {
  phase: "before-commit" | "after-commit";
  corruptionDetected: boolean;
  forwardFixVerified: boolean;
  backupVerified: boolean;
}): "rollback" | "forward-fix" | "restore" | "stop" {
  if (input.phase === "before-commit") return "rollback";
  if (!input.corruptionDetected && input.forwardFixVerified) return "forward-fix";
  return input.backupVerified ? "restore" : "stop";
}

const RESTORE_STEPS = [
  "fence-writes",
  "verify-backup",
  "restore-postgres",
  "restore-artifacts",
  "restore-checkpoints",
  "run-migrations",
  "replay-projections",
  "reconcile",
  "open-readiness",
] as const;

export function validateRestoreJournal(steps: string[]): { ok: true } | { ok: false; reason: string } {
  for (let index = 0; index < RESTORE_STEPS.length; index += 1) {
    const expected = RESTORE_STEPS[index];
    const actual = steps[index];
    if (actual !== expected) {
      return { ok: false, reason: `step_out_of_order:${actual ?? "missing"}:expected:${expected}` };
    }
  }
  if (steps.length > RESTORE_STEPS.length) {
    return { ok: false, reason: `unexpected_step:${steps[RESTORE_STEPS.length]}` };
  }
  return { ok: true };
}

export function compareConfirmedFileInventory(input: {
  component: "artifacts" | "checkpoints";
  entries: Array<{ path: string; sha256: string; sizeBytes: number }>;
  confirmedRecords: Array<{ ref?: unknown; sha256?: unknown; confirmed?: unknown }>;
}) {
  const prefix = `${input.component}/`;
  const expected = new Map<string, string>();
  for (const record of input.confirmedRecords) {
    if (
      record.confirmed === true &&
      typeof record.ref === "string" &&
      record.ref.startsWith(prefix) &&
      typeof record.sha256 === "string"
    ) {
      expected.set(record.ref.slice(prefix.length), record.sha256);
    }
  }
  const actual = new Map(input.entries.map((entry) => [entry.path, entry.sha256]));
  const missing: string[] = [];
  const mismatched: string[] = [];
  const unexpected: string[] = [];
  for (const [path, expectedSha256] of expected) {
    const actualSha256 = actual.get(path);
    if (actualSha256 === undefined) missing.push(path);
    else if (actualSha256 !== expectedSha256) mismatched.push(path);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) unexpected.push(path);
  }
  missing.sort();
  mismatched.sort();
  unexpected.sort();
  return {
    ok: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0,
    missing,
    mismatched,
    unexpected,
  };
}

function rpoRecordKey(record: Record<string, unknown>): string {
  const id = String(record.id);
  return record.revision === undefined ? id : `${id}@${String(record.revision)}`;
}

export function compareRpo0Snapshots(
  expected: RecoveryManifestInput["rpo0"],
  actual: RecoveryManifestInput["rpo0"],
) {
  const missing: string[] = [];
  const mismatched: string[] = [];
  const unexpected: string[] = [];

  for (const category of RPO0_CATEGORIES) {
    const expectedRecords = new Map(expected[category].map((record) => [rpoRecordKey(record), record]));
    const actualRecords = new Map(actual[category].map((record) => [rpoRecordKey(record), record]));
    for (const [key, expectedRecord] of expectedRecords) {
      const actualRecord = actualRecords.get(key);
      if (!actualRecord) {
        missing.push(`${category}:${key}`);
      } else if (canonicalJson(actualRecord) !== canonicalJson(expectedRecord)) {
        mismatched.push(`${category}:${key}`);
      }
    }
    for (const key of actualRecords.keys()) {
      if (!expectedRecords.has(key)) unexpected.push(`${category}:${key}`);
    }
  }

  missing.sort();
  mismatched.sort();
  unexpected.sort();
  return {
    ok: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0,
    missing,
    mismatched,
    unexpected,
  };
}

export async function persistConfirmedFile(input: {
  liveRoot: string;
  mirrorRoot: string;
  relativePath: string;
  content: Buffer | string;
  faultAt?: "after-live";
  commitReference: (reference: { path: string; sha256: string; sizeBytes: number }) => Promise<void>;
}) {
  const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
  const normalizedPath = input.relativePath.split("\\").join("/");
  const reference = {
    path: normalizedPath,
    sha256: sha256(content),
    sizeBytes: content.length,
  };
  await writeAtomicFile(input.liveRoot, normalizedPath, content);
  if (input.faultAt === "after-live") throw new Error("Injected fault after live write");
  await writeAtomicFile(input.mirrorRoot, normalizedPath, content);
  await input.commitReference(reference);
  return { confirmed: true, reference };
}
