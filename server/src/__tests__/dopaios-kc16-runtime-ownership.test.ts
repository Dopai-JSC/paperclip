import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const compose = readFileSync(
  new URL("../../../docker/docker-compose.kc16.yml", import.meta.url),
  "utf8",
);
const runbook = readFileSync(
  new URL("../../../docs/deploy/dopaios-kc16-recovery-runbook.md", import.meta.url),
  "utf8",
);

test("KC-16 initializes Linux bind mounts for the pinned runtime uid before writers start", () => {
  expect(compose).toMatch(/runtime-init:\s+[\s\S]*?image: \*runtime-image/);
  expect(compose).toMatch(/runtime-init:\s+[\s\S]*?user: "0:0"/);
  expect(compose).toMatch(/runtime-init:\s+[\s\S]*?chown -R 1000:1000/);
  expect(compose).toMatch(
    /artifact:\s+[\s\S]*?runtime-init:\s+condition: service_completed_successfully/,
  );
  expect(compose).toMatch(
    /worker:\s+[\s\S]*?runtime-init:\s+condition: service_completed_successfully/,
  );
});

test("KC-16 runbook preserves uid 1000 ownership through seed, bundle, and restore", () => {
  expect(runbook).toMatch(/runtime image runs as uid 1000, gid 1000/i);
  expect(runbook).toMatch(/--user 1000:1000[\s\S]*?seed-kc16-drill\.ts/);
  expect(runbook).toMatch(/--user 1000:1000[\s\S]*?\/mirror\/artifacts/);
  expect(runbook).toMatch(/KC16_QUARANTINE_ID/);
  expect(runbook).toMatch(/chown -R 1000:1000[\s\S]*?\/kc16\/artifacts[\s\S]*?\/kc16\/checkpoints/);
  expect(runbook).toMatch(
    /chown -R 1000:1000[\s\S]*?docker compose[\s\S]*?up -d --pull never --no-build artifact worker application/,
  );
});
