import assert from "node:assert/strict";
import test from "node:test";
import { verifyMeasuredSamples } from "./verify-browser-run.mjs";

const journeys = ["project-list", "project-detail", "action-inbox", "work-item", "search"];

test("independent verifier excludes warmup and checks each journey without masking", () => {
  const samples = journeys.flatMap((journey) => [
    { phase: "warmup", runId: "RUN", user: 1, journey, elapsedMs: 9_999, ok: true },
    ...Array.from({ length: 200 }, (_, index) => ({
      phase: "measure",
      runId: "RUN",
      user: (index % 10) + 1,
      journey,
      elapsedMs: journey === "search" && index >= 189 ? 3_100 : 100 + index,
      ok: true,
    })),
  ]);

  const result = verifyMeasuredSamples(samples, { runId: "RUN" });

  assert.equal(result.journeys["project-list"].samples, 200);
  assert.equal(result.journeys["project-list"].pass, true);
  assert.equal(result.journeys.search.p95Ms, 3_100);
  assert.equal(result.journeys.search.pass, false);
  assert.equal(result.pass, false);
});

test("independent verifier fails a journey with any navigation failure", () => {
  const samples = journeys.flatMap((journey) => Array.from({ length: 200 }, (_, index) => ({
    phase: "measure",
    runId: "RUN",
    user: (index % 10) + 1,
    journey,
    elapsedMs: 100,
    ok: !(journey === "work-item" && index === 199),
  })));

  const result = verifyMeasuredSamples(samples, { runId: "RUN" });
  assert.equal(result.journeys["work-item"].failures, 1);
  assert.equal(result.journeys["work-item"].pass, false);
  assert.equal(result.pass, false);
});
