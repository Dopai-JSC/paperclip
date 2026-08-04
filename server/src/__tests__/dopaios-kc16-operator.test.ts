import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeWorkerHeartbeatAtomic } from "../dopaios/kc16-probes.ts";

test("operator health snapshot is ready only after every recovery component passes", async (t) => {
  const operator = await import("../dopaios/kc16-operator.ts").catch(() => ({})) as {
    collectOperatorHealth?: (input: unknown, dependencies: unknown) => Promise<unknown>;
  };
  const expectedCommit = "e9a11b8c3fa1bcb8ebf8b2d42bb05486c1cfa7fc";
  const root = await mkdtemp(join(tmpdir(), "dopaios-kc16-operator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const heartbeatPath = join(root, "worker-heartbeat.json");
  const now = new Date("2026-08-04T05:00:00.000Z");
  await writeWorkerHeartbeatAtomic(heartbeatPath, now);

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

  const actual = await operator.collectOperatorHealth?.({
    applicationHealthUrl: `http://127.0.0.1:${address.port}/api/health`,
    expectedCommit,
    databaseUrl: "postgres://fixture@127.0.0.1:5434/dopaios_kc16",
    expectedServerVersion: "16.14",
    expectedPgvectorVersion: "0.8.6",
    artifactRoot: join(root, "artifacts"),
    workerHeartbeatPath: heartbeatPath,
    now,
    workerHeartbeatMaxAgeSeconds: 60,
    backup: { ok: true, ageSeconds: 30 },
    backupMaxAgeSeconds: 300,
    reconciliation: { ok: true },
  }, {
    runPostgres: async () => ({ stdout: "dopaios_kc16|16.14|0.8.6|f\n" }),
  });

  assert.deepEqual(actual, {
    status: "ready",
    blockers: [],
    components: {
      application: { ok: true, code: "application_ok" },
      postgres: {
        ok: true,
        code: "postgres_ok",
        database: "dopaios_kc16",
        serverVersion: "16.14",
        pgvectorVersion: "0.8.6",
      },
      artifact: { ok: true, code: "artifact_ok" },
      worker: { ok: true, code: "worker_ok", lastHeartbeatAgeSeconds: 0 },
      backup: { ok: true, ageSeconds: 30 },
      reconciliation: { ok: true },
    },
  });
});
