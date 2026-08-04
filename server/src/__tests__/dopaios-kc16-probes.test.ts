import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("artifact probe verifies durable bytes and leaves no health-check file", async (t) => {
  const probes = await import("../dopaios/kc16-probes.ts").catch(() => ({})) as {
    probeArtifactStore?: (root: string) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-artifact-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await probes.probeArtifactStore?.(root), {
    ok: true,
    code: "artifact_ok",
  });
  assert.deepEqual(await readdir(root), []);
});

test("application probe pins the running server to the expected commit", async (t) => {
  const { probeApplicationHealth } = await import("../dopaios/kc16-probes.ts") as {
    probeApplicationHealth?: (url: string, expectedCommit: string) => Promise<unknown>;
  };
  const expectedCommit = "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc";
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      status: "ok",
      serverInfo: { git: { available: true, fullSha: expectedCommit } },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert(address && typeof address === "object");

  assert.deepEqual(
    await probeApplicationHealth?.(`http://127.0.0.1:${address.port}/api/health`, expectedCommit),
    { ok: true, code: "application_ok" },
  );
});

test("worker probe rejects a heartbeat older than the approved threshold", async (t) => {
  const { probeWorkerHeartbeat } = await import("../dopaios/kc16-probes.ts") as {
    probeWorkerHeartbeat?: (path: string, options: { now: Date; maxAgeSeconds: number }) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-worker-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeatPath = join(root, "worker-heartbeat.json");
  await writeFile(heartbeatPath, JSON.stringify({
    workerId: "dopaios-runner",
    heartbeatAt: "2026-08-04T05:00:00.000Z",
  }), "utf8");

  assert.deepEqual(await probeWorkerHeartbeat?.(heartbeatPath, {
    now: new Date("2026-08-04T05:01:01.000Z"),
    maxAgeSeconds: 60,
  }), {
    ok: false,
    code: "worker_stale",
    lastHeartbeatAgeSeconds: 61,
  });
});

test("Postgres probe reports pinned server and pgvector versions", async () => {
  const { probePostgresHealth } = await import("../dopaios/kc16-probes.ts") as {
    probePostgresHealth?: (input: unknown, run: unknown) => Promise<unknown>;
  };
  const run = async () => ({ stdout: "dopaios_kc16|16.14|0.8.6|f\n" });

  assert.deepEqual(await probePostgresHealth?.({
    databaseUrl: "postgres://fixture@127.0.0.1:5434/dopaios_kc16",
    expectedServerVersion: "16.14",
    expectedPgvectorVersion: "0.8.6",
  }, run), {
    ok: true,
    code: "postgres_ok",
    database: "dopaios_kc16",
    serverVersion: "16.14",
    pgvectorVersion: "0.8.6",
  });
});

test("worker heartbeat writer produces a fresh heartbeat consumable by the probe", async (t) => {
  const probes = await import("../dopaios/kc16-probes.ts") as {
    writeWorkerHeartbeatAtomic?: (path: string, now: Date) => Promise<void>;
    probeWorkerHeartbeat: (path: string, options: { now: Date; maxAgeSeconds: number }) => Promise<unknown>;
  };
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-worker-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeatPath = join(root, "worker-heartbeat.json");
  const now = new Date("2026-08-04T05:00:00.000Z");

  await probes.writeWorkerHeartbeatAtomic?.(heartbeatPath, now);

  assert.deepEqual(await probes.probeWorkerHeartbeat(heartbeatPath, { now, maxAgeSeconds: 60 }), {
    ok: true,
    code: "worker_ok",
    lastHeartbeatAgeSeconds: 0,
  });
});
