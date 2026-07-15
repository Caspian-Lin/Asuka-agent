import assert from "node:assert/strict";
import test from "node:test";

import { createJobsService } from "../src/jobs-service.mjs";

function repositoryFixture(job) {
  const enqueued = [];
  return {
    enqueued,
    async listJobs() {
      return job ? [job] : [];
    },
    async getJob() {
      return job;
    },
    async enqueue(input) {
      enqueued.push(input);
      return { id: input.id, job_id: input.jobId, status: "queued" };
    },
    async listRuns() {
      return [];
    },
    async getRun() {
      return null;
    },
  };
}

test("manual trigger enqueues an auditable cognition run", async () => {
  const repository = repositoryFixture({
    id: "job-thought-tick",
    job_type: "thought_tick",
    enabled: true,
    status: "active",
    config: { maxAttempts: 3 },
  });
  const service = createJobsService({
    repository,
    randomId: () => "run-1",
    clock: () => new Date("2026-07-15T00:00:00Z"),
  });
  const run = await service.trigger("job-thought-tick");
  assert.equal(run.status, "queued");
  assert.deepEqual(repository.enqueued[0], {
    id: "run-1",
    jobId: "job-thought-tick",
    correlationId: "job-run:run-1",
    idempotencyKey: "manual:job-thought-tick:run-1",
    maxAttempts: 3,
    now: new Date("2026-07-15T00:00:00Z"),
  });
});

test("gateway and disabled tasks cannot be manually triggered", async () => {
  const gateway = createJobsService({
    repository: repositoryFixture({
      id: "job-qq-ingress",
      job_type: "qq_ingress",
      enabled: true,
      status: "active",
      config: {},
    }),
    randomId: () => "run-1",
  });
  await assert.rejects(
    gateway.trigger("job-qq-ingress"),
    (error) => error.code === "job_not_runnable",
  );

  const disabled = createJobsService({
    repository: repositoryFixture({
      id: "job-memory-consolidation",
      job_type: "memory_consolidation",
      enabled: false,
      status: "planned",
      config: {},
    }),
    randomId: () => "run-2",
  });
  await assert.rejects(
    disabled.trigger("job-memory-consolidation"),
    (error) => error.code === "job_disabled",
  );
});
