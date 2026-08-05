import { readFile } from "node:fs/promises";
import { createDb } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { replayProjections } from "./event-store.js";
import {
  compareRpo0Snapshots,
  compareConfirmedFileInventory,
  inventoryDirectory,
  verifyRecoveryBundle,
  type RecoveryManifestInput,
} from "./kc16-recovery.js";

const databaseUrl = process.env.DATABASE_URL;
const bundleRoot = process.env.KC16_BUNDLE_ROOT;
const liveRoot = process.env.KC16_LIVE_ROOT ?? "/kc16";
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!bundleRoot) throw new Error("KC16_BUNDLE_ROOT is required");

const db = createDb(databaseUrl);
const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  await db.execute(query) as unknown as T[];

async function collectRpo0Snapshot(): Promise<RecoveryManifestInput["rpo0"]> {
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
  return {
    projectReleaseWorkItems,
    decisions,
    approvalRecords,
    auditEvents: [...eventAudit, ...authorizationAudit, ...connectorAudit],
    checkpoints,
    artifacts: [...ledgerArtifacts, ...sessionArtifacts],
    sopRuns,
  };
}

const verified = await verifyRecoveryBundle(bundleRoot);
if (!verified.ok) throw new Error(`Recovery bundle verification failed: ${verified.reason}`);
const manifest = verified.manifest as unknown as {
  components: RecoveryManifestInput["components"];
  rpo0: RecoveryManifestInput["rpo0"];
};

const liveArtifacts = await inventoryDirectory(`${liveRoot}/artifacts`);
const liveCheckpoints = await inventoryDirectory(`${liveRoot}/checkpoints`);
if (
  liveArtifacts.fileCount !== manifest.components.artifacts.fileCount ||
  liveArtifacts.inventorySha256 !== manifest.components.artifacts.inventorySha256
) {
  throw new Error("Recovered artifact inventory does not match the verified backup");
}
if (
  liveCheckpoints.fileCount !== manifest.components.checkpoints.fileCount ||
  liveCheckpoints.inventorySha256 !== manifest.components.checkpoints.inventorySha256
) {
  throw new Error("Recovered checkpoint inventory does not match the verified backup");
}
const artifactReferences = compareConfirmedFileInventory({
  component: "artifacts",
  entries: liveArtifacts.entries,
  confirmedRecords: manifest.rpo0.artifacts,
});
const checkpointReferences = compareConfirmedFileInventory({
  component: "checkpoints",
  entries: liveCheckpoints.entries,
  confirmedRecords: manifest.rpo0.checkpoints,
});
if (!artifactReferences.ok || !checkpointReferences.ok) {
  throw new Error(`Recovered file/reference mismatch: ${JSON.stringify({
    artifacts: artifactReferences,
    checkpoints: checkpointReferences,
  })}`);
}

const beforeReplay = compareRpo0Snapshots(manifest.rpo0, await collectRpo0Snapshot());
await replayProjections(db);
const afterReplay = compareRpo0Snapshots(manifest.rpo0, await collectRpo0Snapshot());
if (!afterReplay.ok) {
  throw new Error(`RPO-0 reconciliation failed: ${JSON.stringify(afterReplay)}`);
}

const fakeConnectorRecord = manifest.rpo0.artifacts.find(
  (record) => record.kind === "reconciliation-evidence",
);
if (!fakeConnectorRecord || typeof fakeConnectorRecord.ref !== "string") {
  throw new Error("FakeConnector reconciliation evidence is missing from the RPO-0 set");
}
const fakeConnectorEvidence = JSON.parse(
  await readFile(`${liveRoot}/${fakeConnectorRecord.ref}`, "utf8"),
) as { connector?: string; status?: string; productionOracle?: string };
if (
  fakeConnectorEvidence.connector !== "FakeConnector" ||
  fakeConnectorEvidence.status !== "reconciled" ||
  fakeConnectorEvidence.productionOracle !== "deferred"
) {
  throw new Error("FakeConnector reconciliation evidence is invalid");
}

console.log(`bundle manifest: ${verified.manifestSha256}`);
console.log(`before replay: ${beforeReplay.ok ? "identical" : "repaired from event source"}`);
console.log("after replay: RPO-0 byte-identical across all seven categories");
console.log(`artifact inventory: ${liveArtifacts.fileCount} files`);
console.log(`checkpoint inventory: ${liveCheckpoints.fileCount} files`);
console.log("FakeConnector: reconciled; production GitHub oracle: deferred");
process.exit(0);
