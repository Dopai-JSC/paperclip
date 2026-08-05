import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type { Kc10Dataset } from "./kc10-dataset.js";

export const KC10_COMPANY_ID = "2c3d90b5-2d57-58d4-a12c-0bb5ae7c2f10";

interface SeedObject {
  objectId: string;
  stableId: string;
  kind: string;
  projectId: string;
  title: string;
  state: string;
  ownerId: string | null;
  occurredAt: string;
  sourceHref: string;
  metadata: Record<string, unknown>;
}

function toOperationalObjects(dataset: Kc10Dataset): SeedObject[] {
  const projectForOrdinal = (ordinal: number) => dataset.projects[ordinal % dataset.projects.length]!.id;
  return [
    ...dataset.projects.map((project) => ({
      objectId: project.id,
      stableId: project.stableId,
      kind: "project",
      projectId: project.id,
      title: project.name,
      state: project.state,
      ownerId: null,
      occurredAt: project.createdAt,
      sourceHref: `/projects/${project.id}?kc10=1`,
      metadata: { ordinal: project.ordinal },
    })),
    ...dataset.staff.map((staff) => ({
      objectId: staff.id,
      stableId: staff.stableId,
      kind: "staff",
      projectId: projectForOrdinal(staff.ordinal),
      title: staff.name,
      state: "active",
      ownerId: staff.stableId,
      occurredAt: staff.createdAt,
      sourceHref: `/agents/${staff.id}?kc10=1`,
      metadata: { kind: staff.kind, ordinal: staff.ordinal },
    })),
    ...dataset.sopDefinitions.map((definition) => ({
      objectId: definition.id,
      stableId: definition.stableId,
      kind: "sop_definition",
      projectId: definition.projectId,
      title: `SOP definition ${definition.stableId}`,
      state: definition.state,
      ownerId: null,
      occurredAt: definition.createdAt,
      sourceHref: `/search?kc10=1&q=${definition.stableId}`,
      metadata: { revision: definition.revision },
    })),
    ...dataset.openSopRuns.map((run) => ({
      objectId: run.id,
      stableId: run.stableId,
      kind: "sop_run",
      projectId: run.projectId,
      title: `Open SOP run ${run.stableId}`,
      state: run.state,
      ownerId: null,
      occurredAt: run.createdAt,
      sourceHref: `/search?kc10=1&q=${run.stableId}`,
      metadata: { definitionId: run.definitionId },
    })),
    ...dataset.workItems.map((item) => ({
      objectId: item.id,
      stableId: item.stableId,
      kind: "work_item",
      projectId: item.projectId,
      title: `Work item ${item.stableId}`,
      state: item.state,
      ownerId: item.ownerId,
      occurredAt: item.createdAt,
      sourceHref: `/issues/${item.id}?kc10=1`,
      metadata: { runId: item.runId },
    })),
    ...dataset.actionRequests.map((request) => ({
      objectId: request.id,
      stableId: request.stableId,
      kind: "action_request",
      projectId: request.projectId,
      title: `Action request ${request.stableId}`,
      state: request.state,
      ownerId: null,
      occurredAt: request.createdAt,
      sourceHref: `/inbox/mine?kc10=1&object=${request.id}`,
      metadata: { runId: request.runId, risk: request.ordinal % 5 === 0 ? "high" : "normal" },
    })),
    ...dataset.decisionPackages.map((decision) => ({
      objectId: decision.id,
      stableId: decision.stableId,
      kind: "decision",
      projectId: decision.projectId,
      title: `Decision package ${decision.stableId}`,
      state: decision.state,
      ownerId: null,
      occurredAt: decision.createdAt,
      sourceHref: `/search?kc10=1&q=${decision.stableId}`,
      metadata: { revision: decision.revision },
    })),
    ...dataset.aiSessions.map((session) => ({
      objectId: session.id,
      stableId: session.stableId,
      kind: "ai_session",
      projectId: session.projectId,
      title: `AI session ${session.stableId}`,
      state: session.state,
      ownerId: session.agentId,
      occurredAt: session.createdAt,
      sourceHref: `/search?kc10=1&q=${session.stableId}`,
      metadata: { workItemId: session.workItemId },
    })),
    ...dataset.outputVersions.map((output) => ({
      objectId: output.id,
      stableId: output.stableId,
      kind: "output_version",
      projectId: output.projectId,
      title: `Output version ${output.stableId}`,
      state: "confirmed",
      ownerId: null,
      occurredAt: output.createdAt,
      sourceHref: `/issues/${output.workItemId}?kc10=1`,
      metadata: { workItemId: output.workItemId, revision: output.revision },
    })),
    ...dataset.projectDocuments.map((document) => ({
      objectId: document.id,
      stableId: document.stableId,
      kind: "project_document",
      projectId: document.projectId,
      title: document.title,
      state: "current",
      ownerId: null,
      occurredAt: document.createdAt,
      sourceHref: `/search?kc10=1&q=${document.stableId}`,
      metadata: {},
    })),
    ...dataset.knowledgePackages.map((knowledge) => ({
      objectId: knowledge.id,
      stableId: knowledge.stableId,
      kind: "knowledge_package",
      projectId: knowledge.projectId,
      title: knowledge.title,
      state: "current",
      ownerId: null,
      occurredAt: knowledge.createdAt,
      sourceHref: `/search?kc10=1&q=${knowledge.stableId}`,
      metadata: {},
    })),
    ...dataset.incidentReports.map((incident) => ({
      objectId: incident.id,
      stableId: incident.stableId,
      kind: "incident_report",
      projectId: incident.projectId,
      title: `Incident report ${incident.stableId}`,
      state: incident.state,
      ownerId: null,
      occurredAt: incident.createdAt,
      sourceHref: `/search?kc10=1&q=${incident.stableId}`,
      metadata: { risk: "high" },
    })),
  ];
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function issueState(state: Kc10Dataset["workItems"][number]["state"]): string {
  return {
    done: "done",
    ready: "todo",
    blocked: "blocked",
    recovery: "backlog",
    running: "in_progress",
  }[state];
}

export async function seedKc10ControlPlane(
  db: Db,
  dataset: Kc10Dataset,
): Promise<{
  companyId: string;
  users: number;
  agents: number;
  projects: number;
  issues: number;
  sopRuns: number;
  workItems: number;
  aiSessions: number;
  signals: number;
  checkpoints: number;
  graphEdges: number;
}> {
  const companyId = KC10_COMPANY_ID;
  const aiStaff = dataset.staff.filter((staff) => staff.kind === "ai");
  const runById = new Map(dataset.openSopRuns.map((run) => [run.id, run]));
  const itemById = new Map(dataset.workItems.map((item) => [item.id, item]));

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO companies (id, name, description, status, issue_prefix, issue_counter,
                             budget_monthly_cents, spent_monthly_cents, created_at, updated_at)
      VALUES (${companyId}::uuid, 'Dopaios KC-10', 'Deterministic KC-10 verification dataset',
              'active', 'KC10', ${dataset.workItems.length}, 0, 0,
              ${dataset.manifest.anchorTime}::timestamptz, ${dataset.manifest.anchorTime}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
        issue_prefix = EXCLUDED.issue_prefix, issue_counter = EXCLUDED.issue_counter,
        updated_at = EXCLUDED.updated_at
    `);

    for (const batch of chunks(dataset.users, 500)) {
      await tx.execute(sql`
        INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ${sql.join(batch.map((user) => sql`(
          ${user.id}, ${`KC-10 User ${String(user.ordinal + 1).padStart(2, "0")}`},
          ${user.email}, true, ${dataset.manifest.anchorTime}::timestamptz,
          ${dataset.manifest.anchorTime}::timestamptz
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email,
          email_verified = true, updated_at = EXCLUDED.updated_at
      `);
      await tx.execute(sql`
        INSERT INTO company_memberships
          (company_id, principal_type, principal_id, status, membership_role, created_at, updated_at)
        VALUES ${sql.join(batch.map((user) => sql`(
          ${companyId}::uuid, 'user', ${user.id}, 'active', 'member',
          ${dataset.manifest.anchorTime}::timestamptz, ${dataset.manifest.anchorTime}::timestamptz
        )`), sql`, `)}
        ON CONFLICT (company_id, principal_type, principal_id) DO UPDATE SET
          status = 'active', membership_role = 'member', updated_at = EXCLUDED.updated_at
      `);
    }

    for (const batch of chunks(aiStaff, 500)) {
      await tx.execute(sql`
        INSERT INTO agents
          (id, company_id, name, role, title, status, adapter_type, adapter_config,
           runtime_config, budget_monthly_cents, spent_monthly_cents, permissions,
           metadata, created_at, updated_at)
        VALUES ${sql.join(batch.map((staff) => sql`(
          ${staff.id}::uuid, ${companyId}::uuid, ${staff.name}, 'general', 'KC-10 AI Staff',
          'idle', 'process', ${JSON.stringify({ command: "true" })}::jsonb, '{}'::jsonb,
          0, 0, '{}'::jsonb, ${JSON.stringify({ kc10StableId: staff.stableId })}::jsonb,
          ${staff.createdAt}::timestamptz, ${staff.createdAt}::timestamptz
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name,
          status = EXCLUDED.status, adapter_config = EXCLUDED.adapter_config,
          metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at
      `);
    }

    for (const batch of chunks(dataset.projects, 500)) {
      await tx.execute(sql`
        INSERT INTO projects
          (id, company_id, name, description, status, created_at, updated_at)
        VALUES ${sql.join(batch.map((project) => sql`(
          ${project.id}::uuid, ${companyId}::uuid, ${project.name},
          ${`Deterministic source ${project.stableId}`}, 'in_progress',
          ${project.createdAt}::timestamptz, ${project.createdAt}::timestamptz
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, name = EXCLUDED.name,
          description = EXCLUDED.description, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
      `);
    }

    for (const batch of chunks(dataset.workItems, 500)) {
      await tx.execute(sql`
        INSERT INTO issues
          (id, company_id, project_id, title, description, status, priority,
           assignee_agent_id, assignee_user_id, issue_number, identifier,
           origin_kind, origin_id, created_at, updated_at)
        VALUES ${sql.join(batch.map((item) => {
          const ownerOrdinal = item.ordinal % dataset.staff.length;
          const humanUser = ownerOrdinal >= aiStaff.length
            ? dataset.users[ownerOrdinal - aiStaff.length]?.id ?? null
            : null;
          return sql`(
            ${item.id}::uuid, ${companyId}::uuid, ${item.projectId}::uuid,
            ${`Work item ${item.stableId}`}, ${`KC-10 source run ${item.runId}`},
            ${issueState(item.state)}, 'medium',
            ${ownerOrdinal < aiStaff.length ? item.ownerId : null}::uuid, ${humanUser},
            ${item.ordinal + 1}, ${`KC10-${item.ordinal + 1}`}, 'kc10_dataset',
            ${item.stableId}, ${item.createdAt}::timestamptz, ${item.createdAt}::timestamptz
          )`;
        }), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id,
          title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
          assignee_agent_id = EXCLUDED.assignee_agent_id,
          assignee_user_id = EXCLUDED.assignee_user_id, updated_at = EXCLUDED.updated_at
      `);
    }

    for (const batch of chunks(dataset.staff, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_actors (id, kind, active, capabilities)
        VALUES ${sql.join(batch.map((staff) => sql`(
          ${staff.id}, ${staff.kind}, true, ${JSON.stringify(["kc10.execute", "kc10.observe"])}::jsonb
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, active = true,
          capabilities = EXCLUDED.capabilities
      `);
    }

    for (const batch of chunks(dataset.projects, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_projects (id, state, template_ref, orchestrator, created_by)
        VALUES ${sql.join(batch.map((project) => sql`(
          ${project.id}, ${project.state},
          ${JSON.stringify({ id: "KC10-TEMPLATE", revision: 1, dataset: dataset.manifest.sha256 })}::jsonb,
          ${aiStaff[project.ordinal % aiStaff.length]!.id}, ${dataset.users[0]!.id}
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state,
          template_ref = EXCLUDED.template_ref, orchestrator = EXCLUDED.orchestrator,
          created_by = EXCLUDED.created_by
      `);
    }

    for (const batch of chunks(dataset.sopDefinitions, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_sop_definitions (id, revision, state, sop_pin, contract_suite_evidence)
        VALUES ${sql.join(batch.map((definition) => sql`(
          ${definition.id}, ${definition.revision}, ${definition.state},
          ${JSON.stringify({ projectId: definition.projectId, sha256: dataset.manifest.sha256 })}::jsonb,
          ${JSON.stringify({ dataset: dataset.manifest.sha256 })}::jsonb
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision, state = EXCLUDED.state,
          sop_pin = EXCLUDED.sop_pin, contract_suite_evidence = EXCLUDED.contract_suite_evidence
      `);
    }

    for (const batch of chunks(dataset.openSopRuns, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_sop_runs (id, label, state, definition_ref, decider, pod)
        VALUES ${sql.join(batch.map((run) => sql`(
          ${run.id}, ${run.stableId}, ${run.state},
          ${JSON.stringify({ id: run.definitionId, revision: 1 })}::jsonb,
          ${dataset.users[run.ordinal % dataset.users.length]!.id}, ${run.projectId}
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, state = EXCLUDED.state,
          definition_ref = EXCLUDED.definition_ref, decider = EXCLUDED.decider, pod = EXCLUDED.pod
      `);
    }

    for (const batch of chunks(dataset.workItems, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_work_items
          (id, run_id, state, executor, project_id, role, routed_to, routing_basis)
        VALUES ${sql.join(batch.map((item) => sql`(
          ${item.id}, ${item.runId}, ${item.state}, ${item.ownerId}, ${item.projectId},
          'worker', ${item.ownerId},
          ${JSON.stringify({ dataset: dataset.manifest.sha256, deterministic: true })}::jsonb
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, state = EXCLUDED.state,
          executor = EXCLUDED.executor, project_id = EXCLUDED.project_id,
          role = EXCLUDED.role, routed_to = EXCLUDED.routed_to,
          routing_basis = EXCLUDED.routing_basis
      `);
    }

    for (const batch of chunks(dataset.outputVersions, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_output_versions
          (id, revision, work_item_id, state, content_sha256, source_refs)
        VALUES ${sql.join(batch.map((output) => sql`(
          ${output.id}, ${output.revision}, ${output.workItemId}, 'confirmed',
          ${dataset.manifest.contentSha256},
          ${JSON.stringify([{ id: output.workItemId, dataset: dataset.manifest.sha256 }])}::jsonb
        )`), sql`, `)}
        ON CONFLICT (id, revision) DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
          state = EXCLUDED.state, content_sha256 = EXCLUDED.content_sha256,
          source_refs = EXCLUDED.source_refs
      `);
    }

    for (const batch of chunks(dataset.actionRequests, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_action_requests (id, kind, state, run_id, decided_by)
        VALUES ${sql.join(batch.map((request) => sql`(
          ${request.id}, 'approval', ${request.state}, ${request.runId},
          ${request.state === "decided" ? dataset.users[request.ordinal % dataset.users.length]!.id : null}
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, state = EXCLUDED.state,
          run_id = EXCLUDED.run_id, decided_by = EXCLUDED.decided_by
      `);
    }

    for (const batch of chunks(dataset.decisionPackages, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_decision_packages (id, revision, state, refs, target, fields)
        VALUES ${sql.join(batch.map((decision) => sql`(
          ${decision.id}, ${decision.revision}, ${decision.state},
          ${JSON.stringify({ dataset: dataset.manifest.sha256 })}::jsonb,
          ${JSON.stringify({ projectId: decision.projectId })}::jsonb, '{}'::jsonb
        )`), sql`, `)}
        ON CONFLICT (id, revision) DO UPDATE SET state = EXCLUDED.state,
          refs = EXCLUDED.refs, target = EXCLUDED.target, fields = EXCLUDED.fields
      `);
    }

    for (const batch of chunks(dataset.aiSessions, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_ai_sessions
          (id, work_item_id, agent_id, engine, state, last_signal_at, outcome)
        VALUES ${sql.join(batch.map((session) => sql`(
          ${session.id}, ${session.workItemId}, ${session.agentId}, 'kc10-fixture',
          ${session.state}, ${session.createdAt}::timestamptz,
          ${session.state === "complete" ? "success" : null}
        )`), sql`, `)}
        ON CONFLICT (id) DO UPDATE SET work_item_id = EXCLUDED.work_item_id,
          agent_id = EXCLUDED.agent_id, engine = EXCLUDED.engine, state = EXCLUDED.state,
          last_signal_at = EXCLUDED.last_signal_at, outcome = EXCLUDED.outcome
      `);
    }

    for (const batch of chunks(dataset.sessionSignals, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_kc10_session_signals
          (dataset_id, id, session_id, kind, occurred_at)
        VALUES ${sql.join(batch.map((signal) => sql`(
          ${dataset.manifest.sha256}, ${signal.id}::uuid, ${signal.sessionId}::uuid,
          ${signal.kind}, ${signal.createdAt}::timestamptz
        )`), sql`, `)}
        ON CONFLICT (dataset_id, id) DO UPDATE SET session_id = EXCLUDED.session_id,
          kind = EXCLUDED.kind, occurred_at = EXCLUDED.occurred_at
      `);
    }

    for (const batch of chunks(dataset.checkpoints, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_kc10_checkpoints
          (dataset_id, id, session_id, sequence, occurred_at)
        VALUES ${sql.join(batch.map((checkpoint) => sql`(
          ${dataset.manifest.sha256}, ${checkpoint.id}::uuid, ${checkpoint.sessionId}::uuid,
          ${checkpoint.sequence}, ${checkpoint.createdAt}::timestamptz
        )`), sql`, `)}
        ON CONFLICT (dataset_id, id) DO UPDATE SET session_id = EXCLUDED.session_id,
          sequence = EXCLUDED.sequence, occurred_at = EXCLUDED.occurred_at
      `);
    }

    for (const batch of chunks(dataset.graphEdges, 500)) {
      await tx.execute(sql`
        INSERT INTO dopaios_work_item_dependencies
          (work_item_id, depends_on_work_item_id, run_id, declared_by, basis)
        VALUES ${sql.join(batch.map((edge) => {
          const item = itemById.get(edge.workItemId)!;
          const run = runById.get(item.runId)!;
          return sql`(
            ${edge.workItemId}, ${edge.dependsOnWorkItemId}, ${run.id},
            ${dataset.manifest.sha256}, ${JSON.stringify({ projectId: edge.projectId })}::jsonb
          )`;
        }), sql`, `)}
        ON CONFLICT (work_item_id, depends_on_work_item_id) DO UPDATE SET
          run_id = EXCLUDED.run_id, declared_by = EXCLUDED.declared_by, basis = EXCLUDED.basis
      `);
    }
  });

  return {
    companyId,
    users: dataset.users.length,
    agents: aiStaff.length,
    projects: dataset.projects.length,
    issues: dataset.workItems.length,
    sopRuns: dataset.openSopRuns.length,
    workItems: dataset.workItems.length,
    aiSessions: dataset.aiSessions.length,
    signals: dataset.sessionSignals.length,
    checkpoints: dataset.checkpoints.length,
    graphEdges: dataset.graphEdges.length,
  };
}

export async function seedKc10OperationalProjection(
  db: Db,
  companyId: string,
  dataset: Kc10Dataset,
): Promise<{ objects: number; aclEntries: number; projectionState: "complete" }> {
  if (!companyId) throw new Error("companyId is required");
  const objects = toOperationalObjects(dataset);
  const datasetId = `${dataset.manifest.seed}:${companyId}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM dopaios_kc10_objects WHERE company_id = ${companyId}`);
    await tx.execute(sql`DELETE FROM dopaios_kc10_project_acl WHERE company_id = ${companyId}`);
    await tx.execute(sql`
      INSERT INTO dopaios_kc10_dataset_runs
        (dataset_id, company_id, manifest_sha256, projection_state, generated_at, metadata)
      VALUES
        (${datasetId}, ${companyId}, ${dataset.manifest.sha256}, 'partial',
         ${dataset.manifest.anchorTime}::timestamptz,
         ${JSON.stringify({ contentSha256: dataset.manifest.contentSha256 })}::jsonb)
      ON CONFLICT (dataset_id) DO UPDATE SET
        manifest_sha256 = EXCLUDED.manifest_sha256,
        projection_state = 'partial',
        generated_at = EXCLUDED.generated_at,
        metadata = EXCLUDED.metadata
    `);

    for (const batch of chunks(dataset.projectAclEntries, 500)) {
      const values = batch.map((entry) => sql`(
        ${companyId}, ${entry.userId}, ${entry.projectId}, ${entry.decision}
      )`);
      await tx.execute(sql`
        INSERT INTO dopaios_kc10_project_acl (company_id, user_id, project_id, decision)
        VALUES ${sql.join(values, sql`, `)}
      `);
    }
    for (const batch of chunks(objects, 500)) {
      const values = batch.map((object) => sql`(
        ${companyId}, ${object.objectId}, ${object.stableId}, ${object.kind}, ${object.projectId},
        ${object.title}, ${object.state}, ${object.ownerId}, ${object.occurredAt}::timestamptz,
        ${object.sourceHref}, ${JSON.stringify(object.metadata)}::jsonb
      )`);
      await tx.execute(sql`
        INSERT INTO dopaios_kc10_objects
          (company_id, object_id, stable_id, kind, project_id, title, state, owner_id,
           occurred_at, source_href, metadata)
        VALUES ${sql.join(values, sql`, `)}
      `);
    }

    const counts = await tx.execute(sql`
      SELECT
        (SELECT count(*)::int FROM dopaios_kc10_objects WHERE company_id = ${companyId}) AS objects,
        (SELECT count(*)::int FROM dopaios_kc10_project_acl WHERE company_id = ${companyId}) AS acl_entries
    `) as unknown as Array<{ objects: number; acl_entries: number }>;
    if (counts[0]?.objects !== objects.length || counts[0]?.acl_entries !== dataset.projectAclEntries.length) {
      throw new Error(`KC-10 projection count mismatch: ${JSON.stringify(counts[0] ?? null)}`);
    }
    await tx.execute(sql`
      UPDATE dopaios_kc10_dataset_runs
      SET projection_state = 'complete'
      WHERE dataset_id = ${datasetId}
    `);

    return { objects: objects.length, aclEntries: dataset.projectAclEntries.length, projectionState: "complete" };
  });
}
