# Dopaios KC-16 local recovery runbook

This runbook operates only the local production-like KC-16 topology. It does not
create credentials, call a model, contact a production service, or treat GitHub
as a production oracle. Every image is addressed by the digest in
`docker/docker-compose.kc16.yml`; use `--pull never --no-build` for every start.

## Recovery contract

- Detection target: at most 5 minutes from the injected fault.
- RTO target: at most 4 hours from the fault until all health probes pass and
  reconciliation opens readiness.
- RPO target: zero missing or mismatched confirmed records in all seven groups:
  Project/Release/work-item state, decisions, Approval Records, audit events,
  checkpoints, artifacts, and SOP-run records.
- A file is confirmed only after durable live write, durable mirror write, and
  the database reference commit, in that order.
- `COMPLETE`, `manifest.sha256`, every component checksum/inventory, and every
  confirmed file/reference mapping must verify before restore.
- Reads remain `not-ready` until event replay and RPO-0 reconciliation succeed.

The exact restore order is:

1. fence writes;
2. verify backup;
3. restore PostgreSQL into a temporary database;
4. restore artifacts;
5. restore checkpoints;
6. run required migrations;
7. replay projections;
8. reconcile all seven RPO-0 groups and FakeConnector evidence;
9. open readiness.

## 1. Preflight and start

Run from the repository root in PowerShell 7 on Windows or Linux. The path
construction below is platform-native; do not replace it with literal `\` or `/`
separators. Stop if the image inspection, compose validation, or resolved runtime
root differs from the expected repository-local path.

```powershell
$kc16Root = (Resolve-Path .).Path
$kc16Runtime = [System.IO.Path]::Combine($kc16Root, '.kc16', 'runtime')
New-Item -ItemType Directory -Force -Path $kc16Runtime | Out-Null

docker image inspect pgvector/pgvector@sha256:e437c9093a50af23597712f57d57e15c4f4db171e1504c68adfccd85433aa9b2 --format '{{.Id}}'
docker image inspect dopaios-server@sha256:d7d12fee87d946612334e314203afdbd77d07e41460cdb618d1d2a607fcbcf29 --format '{{.Id}}'
docker compose -f docker/docker-compose.kc16.yml config --quiet
docker compose -f docker/docker-compose.kc16.yml up -d --pull never --no-build
docker compose -f docker/docker-compose.kc16.yml ps
```

Expected: application, PostgreSQL, artifact, and worker are all `healthy`.
Application is loopback-only inside its container. PostgreSQL is published only
on `127.0.0.1:55416` for the local drill.

## 2. Schema and fixture

The application image initializes its known upstream schema. Apply Dopai-owned
migrations in order; each command must return zero.

```powershell
foreach ($number in 500..522) {
  $prefix = $number.ToString('0000')
  $migration = docker exec dopaios-kc16-postgres-1 sh -ec "ls /kc16-migrations/${prefix}_*.sql"
  docker exec dopaios-kc16-postgres-1 psql -v ON_ERROR_STOP=1 -U paperclip -d dopaios_kc16 -f $migration
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $migration" }
}
```

Run the existing canonical KC-14 fixture first, then the KC-16 durability
fixture. The container uses the already-present runtime dependencies; the source
and fixture mounts are read-only.

```powershell
$runtimeImage = 'dopaios-server@sha256:d7d12fee87d946612334e314203afdbd77d07e41460cdb618d1d2a607fcbcf29'
$serverSource = [System.IO.Path]::Combine($kc16Root, 'server', 'src')
$databaseSource = [System.IO.Path]::Combine($kc16Root, 'packages', 'db', 'src')
$sharedSource = [System.IO.Path]::Combine($kc16Root, 'packages', 'shared', 'src')
$dopaiosSource = [System.IO.Path]::Combine($kc16Root, 'dopaios')
$migrationSource = [System.IO.Path]::Combine($databaseSource, 'migrations')
$sourceMounts = @(
  '-v', "${serverSource}:/app/server/src:ro",
  '-v', "${databaseSource}:/app/packages/db/src:ro",
  '-v', "${sharedSource}:/app/packages/shared/src:ro",
  '-v', "${dopaiosSource}:/app/dopaios:ro"
)

docker run --rm --network dopaios-kc16_default --entrypoint node `
  -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
  @sourceMounts -w /app $runtimeImage `
  --import ./server/node_modules/tsx/dist/loader.mjs `
  ./server/src/dopaios/seed-kc14-drill.ts

docker run --rm --network dopaios-kc16_default --entrypoint node `
  -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
  -e KC16_RUNTIME_ROOT=/kc16 @sourceMounts `
  -v "${kc16Runtime}:/kc16" -w /app $runtimeImage `
  --import ./server/node_modules/tsx/dist/loader.mjs `
  ./server/src/dopaios/seed-kc16-drill.ts
```

The KC-16 fixture must report the pre-confirmation fault as contained, two
durably mirrored content files, one checkpoint, and confirmed FakeConnector
evidence with the real GitHub oracle still deferred.

### Migration-with-data branch

Use a disposable database, never the live database, to rehearse KC-01 schema
evolution. Apply 0500-0502, insert a v0.1 SOP-run/event fixture, and take a
`pg_dump -Fc`. Run a transaction containing a temporary DDL statement followed
by `SELECT 1 / 0`; require non-zero exit and verify the temporary column is
absent. Then apply 0503 and verify `completed_at` exists while the fixture row is
unchanged. The decision is `rollback` before commit. After commit, choose a
verified forward-fix when safe; choose restore for corruption; stop if the backup
does not verify.

## 3. Create a verified backup bundle

First fence every writer and the artifact health writer.

```powershell
docker compose -f docker/docker-compose.kc16.yml stop application worker artifact
$running = docker compose -f docker/docker-compose.kc16.yml ps --status running --services
if ($running -contains 'application' -or $running -contains 'worker' -or $running -contains 'artifact') {
  throw 'Write fence failed'
}
```

Require a clean implementation commit because the manifest pins a full Git SHA.
Create a unique bundle directory, copy only the confirmed mirror, dump the
database, sync it, and hand ownership to the manifest writer.

```powershell
if (git status --porcelain) { throw 'Commit or remove local changes before final evidence backup' }
$sourceCommit = git rev-parse HEAD
$bundleId = 'kc16-' + (Get-Date -Format 'yyyyMMddHHmmss')

docker exec -u root dopaios-kc16-postgres-1 sh -ec "mkdir -p /kc16-runtime/recovery/$bundleId/artifacts /kc16-runtime/recovery/$bundleId/checkpoints; chown -R postgres:postgres /kc16-runtime/recovery/$bundleId"
$mirrorArtifacts = [System.IO.Path]::Combine($kc16Runtime, 'mirror', 'artifacts', '*')
$mirrorCheckpoints = [System.IO.Path]::Combine($kc16Runtime, 'mirror', 'checkpoints', '*')
$bundleArtifacts = [System.IO.Path]::Combine($kc16Runtime, 'recovery', $bundleId, 'artifacts')
$bundleCheckpoints = [System.IO.Path]::Combine($kc16Runtime, 'recovery', $bundleId, 'checkpoints')
Copy-Item -Recurse -Force $mirrorArtifacts $bundleArtifacts
Copy-Item -Recurse -Force $mirrorCheckpoints $bundleCheckpoints
docker exec -u postgres dopaios-kc16-postgres-1 sh -ec "pg_dump -Fc -U paperclip -d dopaios_kc16 -f /kc16-runtime/recovery/$bundleId/postgres.dump; sync /kc16-runtime/recovery/$bundleId/postgres.dump"
docker exec -u root dopaios-kc16-postgres-1 sh -ec "chown -R 1000:1000 /kc16-runtime/recovery/$bundleId"

docker run --rm --network dopaios-kc16_default --entrypoint node `
  -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
  -e "KC16_BUNDLE_ROOT=/kc16/recovery/$bundleId" `
  -e "KC16_SOURCE_COMMIT=$sourceCommit" -e KC16_MIGRATION_ROOT=/kc16-migrations `
  @sourceMounts -v "${migrationSource}:/kc16-migrations:ro" `
  -v "${kc16Runtime}:/kc16" -w /app $runtimeImage `
  --import ./server/node_modules/tsx/dist/loader.mjs `
  ./server/src/dopaios/create-kc16-recovery-bundle.ts
```

Do not proceed unless the command reports a verified manifest and the bundle has
`COMPLETE`, `manifest.json`, `manifest.sha256`, `postgres.dump`, `artifacts/`, and
`checkpoints/`.

## 4. Detect, diagnose, and decide

Poll component health at no more than 60-second intervals. A failed artifact
inventory, stale worker heartbeat, unhealthy application/PostgreSQL probe,
invalid backup, or incomplete reconciliation closes readiness immediately.

For the approved drill, mutate one confirmed live artifact and remove one event
from the disposable local database after recording the fault timestamp. Run the
verifier. It must fail non-zero and identify the first failed component. Record
the detection timestamp. Never mutate the backup bundle.

Decision table:

| State | Action |
| --- | --- |
| Failure before transaction commit | Roll back; verify the pre-state. |
| Committed, source intact, verified additive repair | Forward-fix; replay and reconcile. |
| Committed corruption or missing source/content | Restore only from a verified bundle. |
| Backup incomplete, stale, or checksum-invalid | Stop; keep readiness closed. |

Structured trace details must redact keys containing `password`, `token`,
`secret`, `databaseUrl`, or `credential`. Metrics are emitted as
`dopaios_kc16_detection_seconds`, `dopaios_kc16_rto_seconds`,
`dopaios_kc16_rpo_loss_records`, and `dopaios_kc16_objective_pass`.

## 5. Restore and reconcile

Keep all writers fenced. Verify the bundle again. Restore PostgreSQL into
`dopaios_kc16_restore`, not over the live database.

```powershell
docker exec dopaios-kc16-postgres-1 psql -v ON_ERROR_STOP=1 -U paperclip -d postgres `
  -c "DROP DATABASE IF EXISTS dopaios_kc16_restore WITH (FORCE)" `
  -c "CREATE DATABASE dopaios_kc16_restore OWNER paperclip"
docker exec -u postgres dopaios-kc16-postgres-1 pg_restore --exit-on-error --no-owner `
  -U paperclip -d dopaios_kc16_restore "/kc16-runtime/recovery/$bundleId/postgres.dump"
```

Before replacing artifact/checkpoint directories, resolve and print all four
targets. Each must be a child of the exact `$kc16Runtime` root. Move the faulted
directories to timestamped quarantine names (recoverable), create empty targets,
then copy the verified bundle to both live and mirror paths.

Run the recovery verifier against the temporary database:

```powershell
docker run --rm --network dopaios-kc16_default --entrypoint node `
  -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16_restore `
  -e "KC16_BUNDLE_ROOT=/kc16/recovery/$bundleId" -e KC16_LIVE_ROOT=/kc16 `
  @sourceMounts -v "${kc16Runtime}:/kc16" -w /app $runtimeImage `
  --import ./server/node_modules/tsx/dist/loader.mjs `
  ./server/src/dopaios/verify-kc16-recovery.ts
```

It must report byte-identical RPO-0 data after replay, exact artifact/checkpoint
inventories, no orphaned confirmed files, and valid FakeConnector evidence. Only
then swap the databases and reopen services:

```powershell
docker exec dopaios-kc16-postgres-1 psql -v ON_ERROR_STOP=1 -U paperclip -d postgres `
  -c "DROP DATABASE dopaios_kc16 WITH (FORCE)" `
  -c "ALTER DATABASE dopaios_kc16_restore RENAME TO dopaios_kc16"
docker compose -f docker/docker-compose.kc16.yml up -d --pull never --no-build artifact worker application
docker compose -f docker/docker-compose.kc16.yml ps
```

Record RTO only after all four services are healthy, application health returns
`status=ok`, the application container image ID equals the pinned digest,
PostgreSQL reports primary mode with the pinned server/pgvector versions, the
worker heartbeat is fresh, and reconciliation is still exact.

## 6. Independent-operator acceptance

The independent operator must not have authored the implementation. They must
execute this runbook without shell improvisation or author assistance, preserve
their transcript, identify the injected root cause from health/log/metric/trace,
choose the correct decision-table branch, and reach all thresholds. Until that
exercise and an off-workstation host/backup target are supplied, KC-16 remains a
local production-like result rather than production readiness.

The production GitHub reconciliation oracle remains deferred. Only the local
FakeConnector fixture is in scope; do not create a token, actor, ruleset, PR, or
merge from this runbook.

## 7. Stop and reset

Normal stop preserves the database volumes and recovery bundles:

```powershell
docker compose -f docker/docker-compose.kc16.yml stop
```

A destructive reset is allowed only after the operator names the exact
`dopaios-kc16` compose project, confirms any required bundle is copied out, and
issues a separate reset command. Never point a recursive remove at the repository
root, `$HOME`, or an unresolved variable.
