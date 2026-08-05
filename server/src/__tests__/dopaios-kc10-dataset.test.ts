import { describe, expect, it } from "vitest";
import { buildKc10Dataset } from "../dopaios/kc10-dataset.js";

const input = {
  seed: "KC10-20260805-v1",
  anchorTime: "2026-08-05T00:00:00.000Z",
  sourceCommit: "79c42d53aaef0d37532d35aa9565e0aaee346681",
};

describe("KC-10 deterministic dataset", () => {
  it("builds the approved v1 scale and state distributions", () => {
    const dataset = buildKc10Dataset(input);

    expect(dataset.manifest.counts).toEqual({
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
    });
    expect(dataset.manifest.distributions).toEqual({
      workItems: { done: 4000, ready: 590, blocked: 200, recovery: 200, running: 10 },
      aiSessions: { complete: 4000, interrupted: 200, running: 10 },
      staff: { ai: 40, human: 10 },
    });
  });

  it("assigns every user exactly twelve allowed and eight denied projects", () => {
    const dataset = buildKc10Dataset(input);

    for (const user of dataset.users) {
      const entries = dataset.projectAclEntries.filter((entry) => entry.userId === user.id);
      expect(entries).toHaveLength(20);
      expect(new Set(entries.map((entry) => entry.projectId)).size).toBe(20);
      expect(entries.filter((entry) => entry.decision === "allow")).toHaveLength(12);
      expect(entries.filter((entry) => entry.decision === "deny")).toHaveLength(8);
    }
  });

  it("keeps graph edges inside one project without self-dependencies", () => {
    const dataset = buildKc10Dataset(input);
    const workItemsById = new Map(dataset.workItems.map((item) => [item.id, item]));

    expect(new Set(dataset.graphEdges.map((edge) => `${edge.workItemId}:${edge.dependsOnWorkItemId}`)).size)
      .toBe(6400);
    for (const edge of dataset.graphEdges) {
      expect(edge.workItemId).not.toBe(edge.dependsOnWorkItemId);
      expect(workItemsById.get(edge.workItemId)?.projectId)
        .toBe(workItemsById.get(edge.dependsOnWorkItemId)?.projectId);
    }
  });

  it("is reproducible for one pin and changes identity when the seed changes", () => {
    const first = buildKc10Dataset(input);
    const second = buildKc10Dataset(input);
    const differentSeed = buildKc10Dataset({ ...input, seed: "KC10-20260805-v2" });

    expect(second.manifest.sha256).toBe(first.manifest.sha256);
    expect(second.projects).toEqual(first.projects);
    expect(first.projects[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(differentSeed.projects[0]?.id).not.toBe(first.projects[0]?.id);
    expect(differentSeed.manifest.sha256).not.toBe(first.manifest.sha256);
  });
});
