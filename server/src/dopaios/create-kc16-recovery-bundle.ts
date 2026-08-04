import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  buildRecoveryManifest,
  compareConfirmedFileInventory,
  inventoryDirectory,
  verifyRecoveryBundle,
  writeRecoveryManifestAtomic,
  type RecoveryManifestInput,
} from "./kc16-recovery.js";

const databaseUrl = process.env.DATABASE_URL;
const bundleRoot = process.env.KC16_BUNDLE_ROOT;
const sourceCommit = process.env.KC16_SOURCE_COMMIT;
const migrationRoot = process.env.KC16_MIGRATION_ROOT ?? "/kc16-migrations";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!bundleRoot) throw new Error("KC16_BUNDLE_ROOT is required");
if (!sourceCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
  throw new Error("KC16_SOURCE_COMMIT must be a full Git commit SHA");
}

const db = createDb(databaseUrl);
const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  await db.execute(query) as unknown as T[];

const projectReleaseWorkItems = await rows<Record<string, unknown>>(sql`
  SELECT 'project:' || id AS id, state, template_ref AS "templateRef",
         orchestrator, created_by AS "createdBy"
  FROM dopaios_projects
  UNION ALL
  SELECT 'work-item:' || id AS id, state,
         jsonb_build_object('runId', run_id, 'projectId', project_id) AS "templateRef",
         routed_to AS orchestrator, executor AS "createdBy"
  FROM dopaios_work_items
  ORDER BY id
`);
const decisions = await rows<Record<string, unknown>>(sql`
  SELECT id, revision, state, refs, target, fields
  FROM dopaios_decision_packages
  ORDER BY id, revision
`);
const approvalRecords = await rows<Record<string, unknown>>(sql`
  SELECT id, package_id AS "packageId", package_revision AS "packageRevision",
         outcome, pinned_refs AS "pinnedRefs", actor, target_id AS "targetId",
         target_revision AS "targetRevision", target_sha256 AS "targetSha256",
         requested_by AS "requestedBy", invalidated_at AS "invalidatedAt",
         invalidation_reason AS "invalidationReason"
  FROM dopaios_approval_records
  ORDER BY id
`);
const eventAudit = await rows<Record<string, unknown>>(sql`
  SELECT 'event:' || id::text AS id, global_position AS "globalPosition",
         position, time, stream_name AS "streamName", type, data, metadata
  FROM message_store.messages
  ORDER BY global_position
`);
const authorizationAudit = await rows<Record<string, unknown>>(sql`
  SELECT 'authorization:' || id::text AS id, actor_type AS "actorType",
         actor_id AS "actorId", company_id AS "companyId", project_id AS "projectId",
         action, decision, reason, created_at AS "createdAt"
  FROM dopaios_authorization_audit_events
  ORDER BY created_at, id
`);
const connectorAudit = await rows<Record<string, unknown>>(sql`
  SELECT 'connector:' || id AS id, project_id AS "projectId", actor_id AS "actorId",
         session_id AS "sessionId", connector_id AS "connectorId",
         connector_version AS "connectorVersion", purpose, action, direction,
         decision, reason_code AS "reasonCode", request_id AS "requestId",
         created_at AS "createdAt"
  FROM dopaios_connector_audit_events
  ORDER BY created_at, id
`);
const checkpoints = await rows<Record<string, unknown>>(sql`
  SELECT 'checkpoint:' || session_id || ':' || seq::text AS id,
         session_id AS "sessionId", seq, ref, sha256, confirmed
  FROM dopaios_session_artifacts
  WHERE kind = 'checkpoint'
  ORDER BY session_id, seq
`);
const ledgerArtifacts = await rows<Record<string, unknown>>(sql`
  SELECT 'ledger:' || id AS id, revision, sha256,
         artifact_state AS "artifactState", impact_status AS "impactStatus",
         artifact_type AS "artifactType", source_refs AS "sourceRefs",
         storage_ref AS "storageRef"
  FROM dopaios_artifacts
  ORDER BY id, revision
`);
const sessionArtifacts = await rows<Record<string, unknown>>(sql`
  SELECT 'session:' || session_id || ':' || seq::text AS id,
         session_id AS "sessionId", seq, kind, ref, sha256, confirmed
  FROM dopaios_session_artifacts
  WHERE kind <> 'checkpoint'
  ORDER BY session_id, seq
`);
const sopRuns = await rows<Record<string, unknown>>(sql`
  SELECT id, label, state, definition_ref AS "definitionRef", decider, pod,
         completed_at AS "completedAt"
  FROM dopaios_sop_runs
  ORDER BY id
`);
const source = (await rows<{
  postgresTimeline: string;
  postgresLsn: string;
  eventGlobalPosition: string;
}>(sql`
  SELECT (pg_control_checkpoint()).timeline_id::text AS "postgresTimeline",
         pg_current_wal_lsn()::text AS "postgresLsn",
         coalesce((SELECT max(global_position) FROM message_store.messages), -1)::text
           AS "eventGlobalPosition"
`))[0];
if (!source) throw new Error("Postgres source coordinates are unavailable");

const postgresBytes = await readFile(`${bundleRoot}/postgres.dump`);
const postgresSha256 = createHash("sha256").update(postgresBytes).digest("hex");
const artifacts = await inventoryDirectory(`${bundleRoot}/artifacts`);
const checkpointsInventory = await inventoryDirectory(`${bundleRoot}/checkpoints`);
const migrationInventory = await inventoryDirectory(migrationRoot);
const artifactReferences = compareConfirmedFileInventory({
  component: "artifacts",
  entries: artifacts.entries,
  confirmedRecords: sessionArtifacts,
});
const checkpointReferences = compareConfirmedFileInventory({
  component: "checkpoints",
  entries: checkpointsInventory.entries,
  confirmedRecords: checkpoints,
});
if (!artifactReferences.ok || !checkpointReferences.ok) {
  throw new Error(`Confirmed file/reference mismatch: ${JSON.stringify({
    artifacts: artifactReferences,
    checkpoints: checkpointReferences,
  })}`);
}

const rpo0: RecoveryManifestInput["rpo0"] = {
  projectReleaseWorkItems,
  decisions,
  approvalRecords,
  auditEvents: [...eventAudit, ...authorizationAudit, ...connectorAudit],
  checkpoints,
  artifacts: [...ledgerArtifacts, ...sessionArtifacts],
  sopRuns,
};
const manifest = buildRecoveryManifest({
  backupId: bundleRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? "kc16-backup",
  createdAt: new Date().toISOString(),
  source: {
    commit: sourceCommit,
    postgresTimeline: source.postgresTimeline,
    postgresLsn: source.postgresLsn,
    eventGlobalPosition: Number(source.eventGlobalPosition),
    migrationJournalSha256: migrationInventory.inventorySha256,
  },
  components: {
    postgres: {
      path: "postgres.dump",
      sizeBytes: postgresBytes.length,
      sha256: postgresSha256,
    },
    artifacts: {
      path: "artifacts",
      inventorySha256: artifacts.inventorySha256,
      fileCount: artifacts.fileCount,
    },
    checkpoints: {
      path: "checkpoints",
      inventorySha256: checkpointsInventory.inventorySha256,
      fileCount: checkpointsInventory.fileCount,
    },
  },
  rpo0,
});

const written = await writeRecoveryManifestAtomic(bundleRoot, manifest);
const verified = await verifyRecoveryBundle(bundleRoot);
if (!verified.ok) throw new Error(`Recovery bundle verification failed: ${verified.reason}`);

console.log(`bundle: ${bundleRoot}`);
console.log(`manifest sha256: ${written.manifestSha256}`);
console.log(`Postgres bytes: ${postgresBytes.length}`);
console.log(`artifact files: ${artifacts.fileCount}`);
console.log(`checkpoint files: ${checkpointsInventory.fileCount}`);
console.log(`RPO-0 records: ${Object.values(rpo0).reduce((total, records) => total + records.length, 0)}`);
process.exit(0);
