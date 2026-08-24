import {
  probeApplicationHealth,
  probeArtifactStore,
  probePostgresHealth,
  probeWorkerHeartbeat,
} from "./kc16-probes.js";
import { evaluateRecoveryReadiness } from "./kc16-recovery.js";

type OperatorHealthInput = {
  applicationHealthUrl: string;
  expectedCommit: string;
  databaseUrl: string;
  expectedServerVersion: string;
  expectedPgvectorVersion: string;
  artifactRoot: string;
  workerHeartbeatPath: string;
  now: Date;
  workerHeartbeatMaxAgeSeconds: number;
  backup: { ok: boolean; ageSeconds: number };
  backupMaxAgeSeconds: number;
  reconciliation: { ok: boolean };
};

type OperatorDependencies = {
  runPostgres?: (
    file: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean },
  ) => Promise<{ stdout: string }>;
};

export async function collectOperatorHealth(
  input: OperatorHealthInput,
  dependencies: OperatorDependencies = {},
) {
  const [application, postgres, artifact, worker] = await Promise.all([
    probeApplicationHealth(input.applicationHealthUrl, input.expectedCommit),
    probePostgresHealth({
      databaseUrl: input.databaseUrl,
      expectedServerVersion: input.expectedServerVersion,
      expectedPgvectorVersion: input.expectedPgvectorVersion,
    }, dependencies.runPostgres),
    probeArtifactStore(input.artifactRoot),
    probeWorkerHeartbeat(input.workerHeartbeatPath, {
      now: input.now,
      maxAgeSeconds: input.workerHeartbeatMaxAgeSeconds,
    }),
  ]);

  const readiness = evaluateRecoveryReadiness({
    application,
    postgres,
    artifact,
    worker: {
      ok: worker.ok,
      lastHeartbeatAgeSeconds: worker.lastHeartbeatAgeSeconds ?? Number.POSITIVE_INFINITY,
    },
    backup: input.backup,
    reconciliation: input.reconciliation,
    thresholds: {
      workerHeartbeatMaxAgeSeconds: input.workerHeartbeatMaxAgeSeconds,
      backupMaxAgeSeconds: input.backupMaxAgeSeconds,
    },
  });

  return {
    ...readiness,
    components: {
      application,
      postgres,
      artifact,
      worker,
      backup: input.backup,
      reconciliation: input.reconciliation,
    },
  };
}
