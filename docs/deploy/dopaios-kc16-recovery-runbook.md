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
root differs from the expected repository-local path. The runtime image runs as uid 1000, gid 1000.
Compose therefore runs the narrowly scoped `runtime-init`
service as root before either filesystem writer starts. It creates only the
mutable KC-16 trees and assigns them to `1000:1000`; it does not change the bind
mount root, the PostgreSQL backup tree, or any recovery invariant.

```powershell
$kc16Root = (Resolve-Path .).Path
$kc16Runtime = [System.IO.Path]::Combine($kc16Root, '.kc16', 'runtime')
New-Item -ItemType Directory -Force -Path $kc16Runtime | Out-Null
$runtimeImage = 'dopaios-server@sha256:d7d12fee87d946612334e314203afdbd77d07e41460cdb618d1d2a607fcbcf29'

docker image inspect pgvector/pgvector@sha256:e437c9093a50af23597712f57d57e15c4f4db171e1504c68adfccd85433aa9b2 --format '{{.Id}}'
docker image inspect $runtimeImage --format '{{.Id}}'
$runtimeIds = docker run --rm --pull never --entrypoint sh $runtimeImage -ec 'printf "%s:%s" "$(id -u)" "$(id -g)"'
if ($LASTEXITCODE -ne 0 -or $runtimeIds -ne '1000:1000') {
  throw "Pinned runtime identity mismatch: $runtimeIds"
}
docker compose -f docker/docker-compose.kc16.yml config --quiet
docker compose -f docker/docker-compose.kc16.yml up -d --pull never --no-build
$initExitCode = docker inspect dopaios-kc16-runtime-init-1 --format '{{.State.ExitCode}}'
if ($initExitCode -ne '0') { throw "runtime-init failed with exit code $initExitCode" }
docker compose -f docker/docker-compose.kc16.yml exec -T artifact sh -ec '
  test "$(id -u):$(id -g)" = "1000:1000"
  for path in /kc16/artifacts /kc16/checkpoints /kc16/mirror/artifacts /kc16/mirror/checkpoints /kc16/worker /kc16/recovery; do
    test -d "$path" && test -w "$path"
  done
'
if ($LASTEXITCODE -ne 0) { throw 'Runtime ownership preflight failed' }
docker compose -f docker/docker-compose.kc16.yml ps --all
```

Expected: `runtime-init` is `exited (0)`; application, PostgreSQL, artifact, and
worker are all `healthy`; and the uid-1000 write preflight returns zero.
Application is loopback-only inside its container. PostgreSQL is published only
on `127.0.0.1:55416` for the local drill. Stop if any of these checks fail.

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

docker run --rm --pull never --user 1000:1000 --network dopaios-kc16_default --entrypoint node `
  -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
  @sourceMounts -w /app $runtimeImage `
  --import ./server/node_modules/tsx/dist/loader.mjs `
  ./server/src/dopaios/seed-kc14-drill.ts

docker run --rm --pull never --user 1000:1000 --network dopaios-kc16_default --entrypoint node `
  -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
  -e KC16_RUNTIME_ROOT=/kc16 @sourceMounts `
  -v "${kc16Runtime}:/kc16" -w /app $runtimeImage `
  --import ./server/node_modules/tsx/dist/loader.mjs `
  ./server/src/dopaios/seed-kc16-drill.ts
```

The KC-16 fixture must report the pre-confirmation fault as contained, two
durably mirrored content files, one checkpoint, and confirmed FakeConnector
evidence with the real GitHub oracle still deferred.

### KC-01 migration verification boundary

Migration-with-data rehearsal is not a branch of the KC-16 recovery drill. It
belongs to a separate KC-01 schema-evolution verification with its own pinned
commands, disposable database, acceptance criteria, and evidence. Do not
improvise that verification here and never run it against the KC-16 live
database. KC-16 applies the required migrations in §2 and preserves and verifies
that migrated state through §5 as part of the fixed restore order.

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
database, sync it, and hand ownership to the manifest writer. All bundle file
operations run inside pinned containers: the runtime copy and manifest writer
run explicitly as `1000:1000`; PostgreSQL stages its dump as `postgres`, then a
root exec installs that one file as `1000:1000`. The host uid never owns bundle
content.

```powershell
if (git status --porcelain) { throw 'Commit or remove local changes before final evidence backup' }
$sourceCommit = git rev-parse HEAD
$bundleId = 'kc16-' + (Get-Date -Format 'yyyyMMddHHmmss')

$bundleCopyScript = @'
set -eu
bundle="/kc16/recovery/$KC16_BUNDLE_ID"
test ! -e "$bundle"
mkdir -p "$bundle/artifacts" "$bundle/checkpoints"
cp -a /kc16/mirror/artifacts/. "$bundle/artifacts/"
cp -a /kc16/mirror/checkpoints/. "$bundle/checkpoints/"
sync "$bundle/artifacts" "$bundle/checkpoints"
'@
docker run --rm --pull never --user 1000:1000 --network none --read-only `
  --cap-drop ALL --security-opt no-new-privileges `
  -e "KC16_BUNDLE_ID=$bundleId" -v "${kc16Runtime}:/kc16" `
  --entrypoint sh $runtimeImage -ec $bundleCopyScript
if ($LASTEXITCODE -ne 0) { throw 'Confirmed mirror copy failed' }

$dumpStage = "/tmp/$bundleId.postgres.dump"
docker exec -u postgres dopaios-kc16-postgres-1 sh -ec "pg_dump -Fc -U paperclip -d dopaios_kc16 -f '$dumpStage'; sync '$dumpStage'"
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL dump failed' }
docker exec -u root dopaios-kc16-postgres-1 sh -ec "install -o 1000 -g 1000 -m 0600 '$dumpStage' '/kc16-runtime/recovery/$bundleId/postgres.dump'; sync '/kc16-runtime/recovery/$bundleId/postgres.dump'; rm -f '$dumpStage'"
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL dump install failed' }

docker run --rm --pull never --user 1000:1000 --network dopaios-kc16_default --entrypoint node `
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

Use the exact fixture-owned artifact and event below. The event selector is
stable by stream, type, and confirmed artifact reference; do not substitute a
host-specific `global_position`. Keep this PowerShell session open through §5
because the monotonic timestamps are inputs to the pinned metrics emitter.

```powershell
function Get-Kc16MonotonicMilliseconds {
  return [long][Math]::Floor(
    ([System.Diagnostics.Stopwatch]::GetTimestamp() * 1000.0) /
    [System.Diagnostics.Stopwatch]::Frequency
  )
}

$eventTargetOutput = docker exec dopaios-kc16-postgres-1 psql `
  -v ON_ERROR_STOP=1 -U paperclip -d dopaios_kc16 -Atc @'
SELECT CASE WHEN count(*) = 1
  THEN min(global_position)::text
  ELSE 'INVALID:' || count(*)::text
END
FROM message_store.messages
WHERE stream_name = 'dopaiosAiSession-KC16-DRILL-SESSION'
  AND type = 'AiSessionArtifactRecorded'
  AND data->>'ref' = 'artifacts/confirmed/kc16-output.txt';
'@
$eventTargetExit = $LASTEXITCODE
$eventTarget = ([string]$eventTargetOutput).Trim()
if ($eventTargetExit -ne 0 -or $eventTarget -notmatch '^[0-9]+$') {
  throw "KC-16 fault event selector is not unique: $eventTarget"
}

docker run --rm --pull never --user 1000:1000 --network none --read-only `
  --cap-drop ALL --security-opt no-new-privileges `
  -v "${kc16Runtime}:/kc16:ro" --entrypoint sh $runtimeImage -ec '
    sha256sum \
      /kc16/artifacts/confirmed/kc16-output.txt \
      /kc16/mirror/artifacts/confirmed/kc16-output.txt
  '
if ($LASTEXITCODE -ne 0) { throw 'Pre-fault artifact inventory failed' }

$faultUtc = [DateTimeOffset]::UtcNow.ToString('O')
$faultMonotonicMs = Get-Kc16MonotonicMilliseconds
docker run --rm --pull never --user 1000:1000 --network none `
  --cap-drop ALL --security-opt no-new-privileges `
  -v "${kc16Runtime}:/kc16" --entrypoint sh $runtimeImage -ec '
    printf "KC16-FAULT-INJECTION\n" >> /kc16/artifacts/confirmed/kc16-output.txt
    sync /kc16/artifacts/confirmed/kc16-output.txt
  '
if ($LASTEXITCODE -ne 0) { throw 'Live artifact fault injection failed' }

$deletedEvent = docker exec dopaios-kc16-postgres-1 psql `
  -v ON_ERROR_STOP=1 -U paperclip -d dopaios_kc16 -Atc `
  "DELETE FROM message_store.messages WHERE global_position = $eventTarget RETURNING global_position"
if ($LASTEXITCODE -ne 0 -or ([string]$deletedEvent).Trim() -ne $eventTarget) {
  throw "Live event fault injection failed for global_position $eventTarget"
}

$verifierOutput = @(
  docker run --rm --pull never --user 1000:1000 `
    --network dopaios-kc16_default --entrypoint node `
    -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
    -e "KC16_BUNDLE_ROOT=/kc16/recovery/$bundleId" `
    -e KC16_LIVE_ROOT=/kc16 @sourceMounts `
    -v "${kc16Runtime}:/kc16:ro" -w /app $runtimeImage `
    --import ./server/node_modules/tsx/dist/loader.mjs `
    ./server/src/dopaios/verify-kc16-recovery.ts 2>&1
)
$verifierExit = $LASTEXITCODE
$detectionUtc = [DateTimeOffset]::UtcNow.ToString('O')
$detectionMonotonicMs = Get-Kc16MonotonicMilliseconds
$verifierText = $verifierOutput -join [Environment]::NewLine
$verifierOutput | Write-Output
if ($verifierExit -eq 0) { throw 'Fault verifier unexpectedly passed' }
if ($verifierText -notmatch 'Recovered artifact inventory does not match the verified backup') {
  throw "Fault verifier failed for an unexpected reason (exit $verifierExit)"
}
$detectionMs = $detectionMonotonicMs - $faultMonotonicMs
Write-Output "fault_utc=$faultUtc"
Write-Output "detection_utc=$detectionUtc"
Write-Output "detection_ms=$detectionMs"
if ($detectionMs -gt 300000) { throw "Detection objective missed: ${detectionMs}ms" }
```

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
docker exec -u root dopaios-kc16-postgres-1 pg_restore --exit-on-error --no-owner `
  -U paperclip -d dopaios_kc16_restore "/kc16-runtime/recovery/$bundleId/postgres.dump"
```

Before replacing artifact/checkpoint directories, resolve and print all four
targets. Each must be a child of the exact `$kc16Runtime` root. Move the faulted
directories to timestamped quarantine names (recoverable), create empty targets,
then copy the verified bundle to both live and mirror paths. The root helper is
limited to the repository-local bind mount, has no network, uses only the
ownership/file capabilities needed for the move, and finishes by assigning all
restored writer trees to `1000:1000`.

```powershell
$runtimeFull = [System.IO.Path]::GetFullPath($kc16Runtime)
$runtimePrefix = $runtimeFull.TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
$restoreTargets = @(
  [System.IO.Path]::Combine($kc16Runtime, 'artifacts'),
  [System.IO.Path]::Combine($kc16Runtime, 'checkpoints'),
  [System.IO.Path]::Combine($kc16Runtime, 'mirror', 'artifacts'),
  [System.IO.Path]::Combine($kc16Runtime, 'mirror', 'checkpoints')
)
foreach ($target in $restoreTargets) {
  $targetFull = [System.IO.Path]::GetFullPath($target)
  Write-Output $targetFull
  if (-not $targetFull.StartsWith($runtimePrefix, [System.StringComparison]::Ordinal)) {
    throw "Restore target escapes KC-16 runtime root: $targetFull"
  }
}
if ($bundleId -notmatch '^kc16-[0-9]{14}$') { throw "Invalid bundle id: $bundleId" }
$quarantineId = 'faulted-' + (Get-Date -Format 'yyyyMMddHHmmss')

$restoreFilesScript = @'
set -eu
bundle="/kc16/recovery/$KC16_BUNDLE_ID"
quarantine="/kc16/quarantine/$KC16_QUARANTINE_ID"
test -f "$bundle/COMPLETE"
test -f "$bundle/manifest.sha256"
test -d "$bundle/artifacts"
test -d "$bundle/checkpoints"
test ! -e "$quarantine"
for path in \
  /kc16/artifacts \
  /kc16/checkpoints \
  /kc16/mirror/artifacts \
  /kc16/mirror/checkpoints; do
  test -d "$path"
done
mkdir -p "$quarantine/mirror"
mv /kc16/artifacts "$quarantine/artifacts"
mv /kc16/checkpoints "$quarantine/checkpoints"
mv /kc16/mirror/artifacts "$quarantine/mirror/artifacts"
mv /kc16/mirror/checkpoints "$quarantine/mirror/checkpoints"
mkdir -p /kc16/artifacts /kc16/checkpoints /kc16/mirror/artifacts /kc16/mirror/checkpoints
cp -a "$bundle/artifacts/." /kc16/artifacts/
cp -a "$bundle/artifacts/." /kc16/mirror/artifacts/
cp -a "$bundle/checkpoints/." /kc16/checkpoints/
cp -a "$bundle/checkpoints/." /kc16/mirror/checkpoints/
chown -R 1000:1000 \
  /kc16/artifacts \
  /kc16/checkpoints \
  /kc16/mirror
sync /kc16/artifacts /kc16/checkpoints /kc16/mirror
'@
docker run --rm --pull never --user 0:0 --network none --read-only `
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER `
  --security-opt no-new-privileges `
  -e "KC16_BUNDLE_ID=$bundleId" -e "KC16_QUARANTINE_ID=$quarantineId" `
  -v "${kc16Runtime}:/kc16" --entrypoint sh $runtimeImage -ec $restoreFilesScript
if ($LASTEXITCODE -ne 0) { throw 'Artifact/checkpoint restore failed' }

docker run --rm --pull never --user 1000:1000 --network none --read-only `
  --cap-drop ALL --security-opt no-new-privileges `
  -v "${kc16Runtime}:/kc16" --entrypoint sh $runtimeImage -ec '
    for path in /kc16/artifacts /kc16/checkpoints /kc16/mirror/artifacts /kc16/mirror/checkpoints; do
      test -d "$path" && test -w "$path"
    done
    probe=/kc16/artifacts/.ownership-preflight
    printf "kc16-uid-1000\n" > "$probe"
    rm -f "$probe"
  '
if ($LASTEXITCODE -ne 0) { throw 'Restored runtime ownership preflight failed' }
```

Run the recovery verifier against the temporary database:

```powershell
docker run --rm --pull never --user 1000:1000 --network dopaios-kc16_default --entrypoint node `
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

Record RTO only through the pinned gate below. It requires all four services to
be healthy, application health to return `status=ok`, both container images to
match their pinned digests, PostgreSQL to be primary with server/pgvector
versions present, the worker heartbeat to be fresh, and the verifier to pass
against the reopened live database. The metrics CLI owns the fixed thresholds;
an operator cannot supply lower or higher PASS criteria.

```powershell
$healthContainers = @(
  'dopaios-kc16-postgres-1',
  'dopaios-kc16-artifact-1',
  'dopaios-kc16-worker-1',
  'dopaios-kc16-application-1'
)
$healthDeadline = [DateTimeOffset]::UtcNow.AddMinutes(5)
do {
  $unhealthy = @(
    foreach ($container in $healthContainers) {
      $status = docker inspect $container --format '{{.State.Health.Status}}' 2>$null
      if ($LASTEXITCODE -ne 0 -or $status -ne 'healthy') { $container }
    }
  )
  if ($unhealthy.Count -eq 0) { break }
  Start-Sleep -Seconds 5
} while ([DateTimeOffset]::UtcNow -lt $healthDeadline)
if ($unhealthy.Count -ne 0) {
  throw "Health gate failed: $($unhealthy -join ', ')"
}

$applicationHealth = docker exec dopaios-kc16-application-1 `
  sh -ec 'curl -fsS http://127.0.0.1:3100/api/health'
$applicationHealthExit = $LASTEXITCODE
try {
  $applicationHealthStatus = ($applicationHealth | ConvertFrom-Json).status
} catch {
  throw 'Application health response is not valid JSON'
}
if ($applicationHealthExit -ne 0 -or $applicationHealthStatus -ne 'ok') {
  throw 'Application health gate failed'
}
$expectedRuntimeImageId = docker image inspect $runtimeImage --format '{{.Id}}'
$applicationImageId = docker inspect dopaios-kc16-application-1 --format '{{.Image}}'
if ($LASTEXITCODE -ne 0 -or $applicationImageId -ne $expectedRuntimeImageId) {
  throw 'Application image digest gate failed'
}

$postgresImage = 'pgvector/pgvector@sha256:e437c9093a50af23597712f57d57e15c4f4db171e1504c68adfccd85433aa9b2'
$expectedPostgresImageId = docker image inspect $postgresImage --format '{{.Id}}'
$postgresImageId = docker inspect dopaios-kc16-postgres-1 --format '{{.Image}}'
$postgresPrimary = docker exec dopaios-kc16-postgres-1 psql `
  -v ON_ERROR_STOP=1 -U paperclip -d dopaios_kc16 -Atc 'SELECT pg_is_in_recovery()'
$postgresVersion = docker exec dopaios-kc16-postgres-1 psql `
  -v ON_ERROR_STOP=1 -U paperclip -d dopaios_kc16 -Atc 'SHOW server_version'
$pgvectorVersion = docker exec dopaios-kc16-postgres-1 psql `
  -v ON_ERROR_STOP=1 -U paperclip -d dopaios_kc16 -Atc `
  "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
if (
  $LASTEXITCODE -ne 0 -or
  $postgresImageId -ne $expectedPostgresImageId -or
  $postgresPrimary -ne 'f' -or
  [string]::IsNullOrWhiteSpace($postgresVersion) -or
  [string]::IsNullOrWhiteSpace($pgvectorVersion)
) {
  throw 'PostgreSQL primary/version/image gate failed'
}

$workerHeartbeatAgeMs = docker exec dopaios-kc16-worker-1 node -e '
  const heartbeat = JSON.parse(require("node:fs").readFileSync("/kc16/worker/heartbeat.json", "utf8"));
  const age = Date.now() - Date.parse(heartbeat.heartbeatAt);
  if (!Number.isFinite(age) || age < 0) process.exit(2);
  process.stdout.write(String(age));
'
if (
  $LASTEXITCODE -ne 0 -or
  [long]$workerHeartbeatAgeMs -gt 60000
) {
  throw "Worker heartbeat freshness gate failed: ${workerHeartbeatAgeMs}ms"
}

$liveVerifierOutput = @(
  docker run --rm --pull never --user 1000:1000 `
    --network dopaios-kc16_default --entrypoint node `
    -e DATABASE_URL=postgres://paperclip@postgres:5432/dopaios_kc16 `
    -e "KC16_BUNDLE_ROOT=/kc16/recovery/$bundleId" `
    -e KC16_LIVE_ROOT=/kc16 @sourceMounts `
    -v "${kc16Runtime}:/kc16:ro" -w /app $runtimeImage `
    --import ./server/node_modules/tsx/dist/loader.mjs `
    ./server/src/dopaios/verify-kc16-recovery.ts 2>&1
)
$liveVerifierExit = $LASTEXITCODE
$liveVerifierText = $liveVerifierOutput -join [Environment]::NewLine
$liveVerifierOutput | Write-Output
if (
  $liveVerifierExit -ne 0 -or
  $liveVerifierText -notmatch 'after replay: RPO-0 byte-identical across all seven categories'
) {
  throw 'Live RPO-0 reconciliation gate failed; readiness remains closed'
}

$readinessUtc = [DateTimeOffset]::UtcNow.ToString('O')
$readinessMonotonicMs = Get-Kc16MonotonicMilliseconds
$metricsOutput = @(
  docker run --rm --pull never --user 1000:1000 --network none --read-only `
    --cap-drop ALL --security-opt no-new-privileges `
    -e "KC16_FAULT_MONOTONIC_MS=$faultMonotonicMs" `
    -e "KC16_DETECTION_MONOTONIC_MS=$detectionMonotonicMs" `
    -e "KC16_READINESS_MONOTONIC_MS=$readinessMonotonicMs" `
    -e KC16_RPO_LOSS_COUNT=0 @sourceMounts -w /app $runtimeImage `
    --import ./server/node_modules/tsx/dist/loader.mjs `
    ./server/src/dopaios/emit-kc16-recovery-metrics.ts 2>&1
)
$metricsExit = $LASTEXITCODE
$metricsText = ($metricsOutput -join [Environment]::NewLine) + [Environment]::NewLine
$metricsDirectory = [System.IO.Path]::Combine($kc16Root, '.kc16', 'evidence')
$metricsPath = [System.IO.Path]::Combine($metricsDirectory, "$bundleId-metrics.prom")
New-Item -ItemType Directory -Force -Path $metricsDirectory | Out-Null
[System.IO.File]::WriteAllText(
  $metricsPath,
  $metricsText,
  [System.Text.UTF8Encoding]::new($false)
)
$metricsOutput | Write-Output
Write-Output "readiness_utc=$readinessUtc"
Write-Output "metrics_path=$metricsPath"
if ($metricsExit -ne 0) {
  throw "Recovery objective gate failed; metrics emitter exit code $metricsExit"
}
```

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
