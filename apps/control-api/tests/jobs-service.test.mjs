import assert from "node:assert/strict";
import test from "node:test";

import { createJobsService } from "../src/jobs-service.mjs";

function repositoryFixture(job) {
  const enqueued = [];
  const updates = [];
  return {
    enqueued,
    updates,
    async listJobs() {
      return job ? [job] : [];
    },
    async getJob() {
      return job;
    },
    async getConversation(conversationId) {
      return conversationId === "conversation-1"
        ? { id: conversationId, title: "测试会话" }
        : null;
    },
    async listConversations() {
      return [{ id: "conversation-1", title: "测试会话" }];
    },
    async updateJob(jobId, input) {
      updates.push({ jobId, input });
      return { id: jobId, ...input };
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
    parameters: {},
    now: new Date("2026-07-15T00:00:00Z"),
  });
});

test("manual thought trigger validates and persists an optional conversation scope", async () => {
  const repository = repositoryFixture({
    id: "job-thought-tick",
    job_type: "thought_tick",
    enabled: true,
    status: "active",
    config: { maxAttempts: 3 },
  });
  const service = createJobsService({
    repository,
    randomId: () => "run-targeted",
    clock: () => new Date("2026-07-15T00:00:00Z"),
  });
  await service.trigger("job-thought-tick", { conversationId: "conversation-1" });
  assert.deepEqual(repository.enqueued[0].parameters, {
    conversationId: "conversation-1",
  });
  await assert.rejects(
    service.trigger("job-thought-tick", { conversationId: "missing" }),
    (error) => error.code === "conversation_not_found",
  );
  await assert.rejects(
    service.trigger("job-thought-tick", { conversationId: 123 }),
    (error) => error.code === "job_run_parameters_invalid",
  );
});

test("memory runs reject conversation scope", async () => {
  const service = createJobsService({
    repository: repositoryFixture({
      id: "job-memory-consolidation",
      job_type: "memory_consolidation",
      enabled: true,
      status: "active",
      config: { maxAttempts: 3 },
    }),
    randomId: () => "run-memory",
  });
  await assert.rejects(
    service.trigger("job-memory-consolidation", { conversationId: "conversation-1" }),
    (error) => error.code === "job_scope_unsupported",
  );
});

test("configurable cognition jobs update through the validated scheduler contract", async () => {
  const repository = repositoryFixture({
    id: "job-thought-tick",
    job_type: "thought_tick",
    configurable: true,
    enabled: true,
    status: "active",
    schedule_expression: "15m",
    config: { intervalSeconds: 900, maxBatchMessages: 50, maxAttempts: 3 },
  });
  const service = createJobsService({
    repository,
    randomId: () => "unused",
    clock: () => new Date("2026-07-15T00:00:00Z"),
  });
  const updated = await service.update("job-thought-tick", {
    enabled: true,
    schedule: { intervalMinutes: 45 },
    limits: { maxBatchMessages: 90, maxAttempts: 5 },
  });
  assert.equal(updated.scheduleExpression, "45m");
  assert.equal(repository.updates[0].input.config.maxBatchMessages, 90);
  assert.equal(repository.updates[0].input.nextRunAt.toISOString(), "2026-07-15T00:45:00.000Z");
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
