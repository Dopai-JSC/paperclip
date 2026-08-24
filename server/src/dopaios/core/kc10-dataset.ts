import { createHash } from "node:crypto";

const UUID_NAMESPACE = "5eb7d8f8-6f53-5d9c-9c4e-8f6fb5829431";

export interface Kc10DatasetInput {
  seed: string;
  anchorTime: string;
  sourceCommit: string;
}

interface IdentifiedEntity {
  id: string;
  stableId: string;
  ordinal: number;
  createdAt: string;
}

interface ProjectScopedEntity extends IdentifiedEntity {
  projectId: string;
}

export interface Kc10ProjectAclEntry {
  userId: string;
  projectId: string;
  decision: "allow" | "deny";
}

export interface Kc10GraphEdge {
  workItemId: string;
  dependsOnWorkItemId: string;
  projectId: string;
}

export interface Kc10Dataset {
  manifest: {
    schema: "dopaios.kc10.dataset-manifest/v1";
    seed: string;
    anchorTime: string;
    sourceCommit: string;
    windowStart: string;
    counts: Record<string, number>;
    distributions: {
      workItems: Record<string, number>;
      aiSessions: Record<string, number>;
      staff: Record<string, number>;
    };
    contentSha256: string;
    sha256: string;
  };
  projects: Array<IdentifiedEntity & { name: string; state: "P0" }>;
  staff: Array<IdentifiedEntity & { name: string; kind: "ai" | "human" }>;
  users: Array<{ id: string; email: string; ordinal: number }>;
  projectAclEntries: Kc10ProjectAclEntry[];
  sopDefinitions: Array<ProjectScopedEntity & { revision: number; state: "active" }>;
  openSopRuns: Array<ProjectScopedEntity & { definitionId: string; state: "open" }>;
  workItems: Array<ProjectScopedEntity & {
    runId: string;
    ownerId: string;
    state: "done" | "ready" | "blocked" | "recovery" | "running";
  }>;
  actionRequests: Array<ProjectScopedEntity & { runId: string; state: "open" | "decided" }>;
  decisionPackages: Array<ProjectScopedEntity & { revision: number; state: "open" | "decided" }>;
  aiSessions: Array<ProjectScopedEntity & {
    workItemId: string;
    agentId: string;
    state: "complete" | "interrupted" | "running";
  }>;
  sessionSignals: Array<IdentifiedEntity & { sessionId: string; kind: string }>;
  checkpoints: Array<IdentifiedEntity & { sessionId: string; sequence: number }>;
  outputVersions: Array<ProjectScopedEntity & { workItemId: string; revision: number }>;
  projectDocuments: Array<ProjectScopedEntity & { title: string }>;
  knowledgePackages: Array<ProjectScopedEntity & { title: string }>;
  incidentReports: Array<ProjectScopedEntity & { state: "received" }>;
  graphEdges: Kc10GraphEdge[];
}

const COUNTS = {
  projects: 20,
  staff: 50,
  users: 10,
  projectAclEntries: 200,
  sopDefinitions: 20,
  openSopRuns: 200,
  workItems: 5000,
  actionRequests: 400,
  decisionPackages: 200,
  aiSessions: 4210,
  sessionSignals: 33680,
  checkpoints: 8420,
  outputVersions: 4000,
  projectDocuments: 200,
  knowledgePackages: 100,
  incidentReports: 40,
  graphEdges: 6400,
} as const;

const DISTRIBUTIONS = {
  workItems: { done: 4000, ready: 590, blocked: 200, recovery: 200, running: 10 },
  aiSessions: { complete: 4000, interrupted: 200, running: 10 },
  staff: { ai: 40, human: 10 },
} as const;

function uuidBytes(value: string): Buffer {
  const hex = value.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Invalid UUID namespace: ${value}`);
  return Buffer.from(hex, "hex");
}

function uuidV5(name: string): string {
  const bytes = createHash("sha1")
    .update(uuidBytes(UUID_NAMESPACE))
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pad(value: number, width = 4): string {
  return String(value).padStart(width, "0");
}

function stateAt<T extends string>(ordinal: number, distribution: Record<T, number>): T {
  let cursor = 0;
  for (const [state, count] of Object.entries(distribution) as Array<[T, number]>) {
    cursor += count;
    if (ordinal < cursor) return state;
  }
  throw new Error(`Ordinal ${ordinal} exceeds distribution`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildKc10Dataset(input: Kc10DatasetInput): Kc10Dataset {
  const anchor = new Date(input.anchorTime);
  if (!Number.isFinite(anchor.getTime())) throw new Error("anchorTime must be an ISO timestamp");
  if (!input.seed.trim()) throw new Error("seed must not be empty");
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommit)) throw new Error("sourceCommit must be a git SHA-1");

  const id = (kind: string, ordinal: number) => uuidV5(`${input.seed}:${kind}:${ordinal}`);
  const createdAt = (ordinal: number) => new Date(anchor.getTime() - (ordinal % 43_200) * 60_000).toISOString();
  const base = (kind: string, ordinal: number, stableId: string): IdentifiedEntity => ({
    id: id(kind, ordinal),
    stableId,
    ordinal,
    createdAt: createdAt(ordinal),
  });

  const projects = Array.from({ length: COUNTS.projects }, (_, ordinal) => ({
    ...base("project", ordinal, `PROJECT-KC10-${pad(ordinal + 1, 3)}`),
    name: `KC-10 Project ${pad(ordinal + 1, 2)}`,
    state: "P0" as const,
  }));
  const staff = Array.from({ length: COUNTS.staff }, (_, ordinal) => ({
    ...base("staff", ordinal, `STAFF-KC10-${pad(ordinal + 1, 3)}`),
    name: `KC-10 Staff ${pad(ordinal + 1, 2)}`,
    kind: ordinal < DISTRIBUTIONS.staff.ai ? "ai" as const : "human" as const,
  }));
  const users = Array.from({ length: COUNTS.users }, (_, ordinal) => ({
    id: `kc10-user-${pad(ordinal + 1, 2)}`,
    email: `kc10-user-${pad(ordinal + 1, 2)}@example.invalid`,
    ordinal,
  }));
  const projectAclEntries = users.flatMap((user) => projects.map((project, projectOrdinal) => ({
    userId: user.id,
    projectId: project.id,
    decision: ((projectOrdinal - user.ordinal + projects.length) % projects.length) < 12
      ? "allow" as const
      : "deny" as const,
  })));
  const sopDefinitions = projects.map((project, ordinal) => ({
    ...base("sop-definition", ordinal, `SOP-KC10-${pad(ordinal + 1, 3)}`),
    projectId: project.id,
    revision: 1,
    state: "active" as const,
  }));
  const openSopRuns = Array.from({ length: COUNTS.openSopRuns }, (_, ordinal) => {
    const project = projects[ordinal % projects.length]!;
    return {
      ...base("sop-run", ordinal, `RUN-KC10-${pad(ordinal + 1)}`),
      projectId: project.id,
      definitionId: sopDefinitions[ordinal % sopDefinitions.length]!.id,
      state: "open" as const,
    };
  });
  const workItems = Array.from({ length: COUNTS.workItems }, (_, ordinal) => {
    const project = projects[ordinal % projects.length]!;
    return {
      ...base("work-item", ordinal, `WI-KC10-${pad(ordinal + 1, 5)}`),
      projectId: project.id,
      runId: openSopRuns[ordinal % openSopRuns.length]!.id,
      ownerId: staff[ordinal % staff.length]!.id,
      state: stateAt(ordinal, DISTRIBUTIONS.workItems),
    };
  });
  const actionRequests = Array.from({ length: COUNTS.actionRequests }, (_, ordinal) => ({
    ...base("action-request", ordinal, `ACTION-KC10-${pad(ordinal + 1)}`),
    projectId: projects[ordinal % projects.length]!.id,
    runId: openSopRuns[ordinal % openSopRuns.length]!.id,
    state: ordinal < 200 ? "open" as const : "decided" as const,
  }));
  const decisionPackages = Array.from({ length: COUNTS.decisionPackages }, (_, ordinal) => ({
    ...base("decision-package", ordinal, `DECISION-KC10-${pad(ordinal + 1)}`),
    projectId: projects[ordinal % projects.length]!.id,
    revision: 1,
    state: ordinal < 100 ? "open" as const : "decided" as const,
  }));
  const aiSessions = Array.from({ length: COUNTS.aiSessions }, (_, ordinal) => {
    const workItem = workItems[ordinal % workItems.length]!;
    return {
      ...base("ai-session", ordinal, `SESSION-KC10-${pad(ordinal + 1, 5)}`),
      projectId: workItem.projectId,
      workItemId: workItem.id,
      agentId: staff[ordinal % DISTRIBUTIONS.staff.ai]!.id,
      state: stateAt(ordinal, DISTRIBUTIONS.aiSessions),
    };
  });
  const sessionSignals = aiSessions.flatMap((session, sessionOrdinal) => Array.from({ length: 8 }, (_, sequence) => {
    const ordinal = sessionOrdinal * 8 + sequence;
    return {
      ...base("session-signal", ordinal, `SIGNAL-KC10-${pad(ordinal + 1, 6)}`),
      sessionId: session.id,
      kind: ["started", "stdout", "tool", "checkpoint", "heartbeat", "usage", "artifact", "completed"][sequence]!,
    };
  }));
  const checkpoints = aiSessions.flatMap((session, sessionOrdinal) => Array.from({ length: 2 }, (_, sequence) => {
    const ordinal = sessionOrdinal * 2 + sequence;
    return {
      ...base("checkpoint", ordinal, `CHECKPOINT-KC10-${pad(ordinal + 1, 5)}`),
      sessionId: session.id,
      sequence: sequence + 1,
    };
  }));
  const outputVersions = workItems.slice(0, COUNTS.outputVersions).map((workItem, ordinal) => ({
    ...base("output-version", ordinal, `OUTPUT-KC10-${pad(ordinal + 1, 5)}`),
    projectId: workItem.projectId,
    workItemId: workItem.id,
    revision: 1,
  }));
  const projectDocuments = Array.from({ length: COUNTS.projectDocuments }, (_, ordinal) => ({
    ...base("project-document", ordinal, `DOC-KC10-${pad(ordinal + 1)}`),
    projectId: projects[ordinal % projects.length]!.id,
    title: `KC-10 Project Document ${pad(ordinal + 1)}`,
  }));
  const knowledgePackages = Array.from({ length: COUNTS.knowledgePackages }, (_, ordinal) => ({
    ...base("knowledge-package", ordinal, `DKP-KC10-${pad(ordinal + 1)}`),
    projectId: projects[ordinal % projects.length]!.id,
    title: `KC-10 Knowledge Package ${pad(ordinal + 1)}`,
  }));
  const incidentReports = Array.from({ length: COUNTS.incidentReports }, (_, ordinal) => ({
    ...base("incident-report", ordinal, `INCIDENT-KC10-${pad(ordinal + 1, 3)}`),
    projectId: projects[ordinal % projects.length]!.id,
    state: "received" as const,
  }));
  const graphEdges: Kc10GraphEdge[] = [];
  for (const project of projects) {
    const projectItems = workItems.filter((item) => item.projectId === project.id);
    for (let ordinal = 1; ordinal < projectItems.length; ordinal += 1) {
      graphEdges.push({
        workItemId: projectItems[ordinal]!.id,
        dependsOnWorkItemId: projectItems[ordinal - 1]!.id,
        projectId: project.id,
      });
    }
    for (let ordinal = 2; ordinal <= 72; ordinal += 1) {
      graphEdges.push({
        workItemId: projectItems[ordinal]!.id,
        dependsOnWorkItemId: projectItems[ordinal - 2]!.id,
        projectId: project.id,
      });
    }
  }

  const content = {
    projects,
    staff,
    users,
    projectAclEntries,
    sopDefinitions,
    openSopRuns,
    workItems,
    actionRequests,
    decisionPackages,
    aiSessions,
    sessionSignals,
    checkpoints,
    outputVersions,
    projectDocuments,
    knowledgePackages,
    incidentReports,
    graphEdges,
  };
  const contentSha256 = sha256(JSON.stringify(content));
  const manifestWithoutSha = {
    schema: "dopaios.kc10.dataset-manifest/v1" as const,
    seed: input.seed,
    anchorTime: anchor.toISOString(),
    sourceCommit: input.sourceCommit.toLowerCase(),
    windowStart: new Date(anchor.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    counts: { ...COUNTS },
    distributions: {
      workItems: { ...DISTRIBUTIONS.workItems },
      aiSessions: { ...DISTRIBUTIONS.aiSessions },
      staff: { ...DISTRIBUTIONS.staff },
    },
    contentSha256,
  };

  return {
    manifest: { ...manifestWithoutSha, sha256: sha256(JSON.stringify(manifestWithoutSha)) },
    ...content,
  };
}
