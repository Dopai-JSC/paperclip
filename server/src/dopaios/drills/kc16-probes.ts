import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function probeArtifactStore(root: string): Promise<
  | { ok: true; code: "artifact_ok" }
  | { ok: false; code: "artifact_probe_failed"; detail: string }
> {
  await mkdir(root, { recursive: true });
  const probePath = join(root, `.kc16-health-${randomUUID()}`);
  const expected = Buffer.from("dopaios-kc16-artifact-health\n", "utf8");
  try {
    const handle = await open(probePath, "wx");
    try {
      await handle.writeFile(expected);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = await readFile(probePath);
    if (!actual.equals(expected)) throw new Error("artifact probe bytes changed after durable write");
    return { ok: true, code: "artifact_ok" };
  } catch (error) {
    return {
      ok: false,
      code: "artifact_probe_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(probePath, { force: true });
  }
}

export async function probeApplicationHealth(
  url: string,
  expectedCommit: string,
): Promise<
  | { ok: true; code: "application_ok" }
  | { ok: false; code: "application_probe_failed"; detail: string }
> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`health endpoint returned HTTP ${response.status}`);
    const body = await response.json() as {
      status?: string;
      serverInfo?: { git?: { available?: boolean; fullSha?: string } };
    };
    if (body.status !== "ok") throw new Error(`application status is ${body.status ?? "missing"}`);
    if (body.serverInfo?.git?.available !== true || body.serverInfo.git.fullSha !== expectedCommit) {
      throw new Error("running application commit does not match the recovery manifest");
    }
    return { ok: true, code: "application_ok" };
  } catch (error) {
    return {
      ok: false,
      code: "application_probe_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeWorkerHeartbeat(
  heartbeatPath: string,
  options: { now: Date; maxAgeSeconds: number },
): Promise<
  | { ok: true; code: "worker_ok"; lastHeartbeatAgeSeconds: number }
  | { ok: false; code: "worker_stale" | "worker_probe_failed"; lastHeartbeatAgeSeconds?: number; detail?: string }
> {
  try {
    const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf8")) as {
      workerId?: string;
      heartbeatAt?: string;
    };
    const heartbeatMs = Date.parse(heartbeat.heartbeatAt ?? "");
    if (heartbeat.workerId !== "dopaios-runner" || Number.isNaN(heartbeatMs)) {
      throw new Error("worker heartbeat is malformed");
    }
    const lastHeartbeatAgeSeconds = Math.floor((options.now.getTime() - heartbeatMs) / 1_000);
    if (lastHeartbeatAgeSeconds > options.maxAgeSeconds) {
      return { ok: false, code: "worker_stale", lastHeartbeatAgeSeconds };
    }
    return { ok: true, code: "worker_ok", lastHeartbeatAgeSeconds };
  } catch (error) {
    return {
      ok: false,
      code: "worker_probe_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function writeWorkerHeartbeatAtomic(heartbeatPath: string, now: Date): Promise<void> {
  await mkdir(dirname(heartbeatPath), { recursive: true });
  const temporaryPath = `${heartbeatPath}.tmp`;
  const handle = await open(temporaryPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify({
      workerId: "dopaios-runner",
      heartbeatAt: now.toISOString(),
    })}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, heartbeatPath);
}

type CommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

export async function probePostgresHealth(
  input: {
    databaseUrl: string;
    expectedServerVersion: string;
    expectedPgvectorVersion: string;
  },
  run: CommandRunner = execFileAsync as CommandRunner,
): Promise<
  | {
    ok: true;
    code: "postgres_ok";
    database: string;
    serverVersion: string;
    pgvectorVersion: string;
  }
  | { ok: false; code: "postgres_probe_failed"; detail: string }
> {
  try {
    const query = [
      "SELECT current_database(), current_setting('server_version'),",
      "COALESCE((SELECT extversion FROM pg_extension WHERE extname='vector'), ''),",
      "pg_is_in_recovery()",
    ].join(" ");
    const { stdout } = await run(
      "psql",
      [input.databaseUrl, "--no-psqlrc", "-At", "-F", "|", "-c", query],
      { timeout: 5_000, windowsHide: true },
    );
    const [database, serverVersion, pgvectorVersion, inRecovery] = stdout.trim().split("|");
    if (serverVersion !== input.expectedServerVersion) {
      throw new Error(`Postgres version ${serverVersion} does not match ${input.expectedServerVersion}`);
    }
    if (pgvectorVersion !== input.expectedPgvectorVersion) {
      throw new Error(`pgvector version ${pgvectorVersion} does not match ${input.expectedPgvectorVersion}`);
    }
    if (inRecovery !== "f") throw new Error("Postgres primary probe unexpectedly reports recovery mode");
    return { ok: true, code: "postgres_ok", database, serverVersion, pgvectorVersion };
  } catch (error) {
    return {
      ok: false,
      code: "postgres_probe_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
