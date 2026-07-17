import assert from "node:assert/strict";
import test from "node:test";

import {
  canConfigureJob,
  nextRunAt,
  normalizeJobUpdate,
} from "../src/scheduler-config.mjs";

test("thought schedule updates preserve internal settings and recompute the next run", () => {
  const update = normalizeJobUpdate({
    job_type: "thought_tick",
    configurable: true,
    enabled: true,
    schedule_expression: "15m",
    config: { profile: "primary", maxMessages: 50, maxAttempts: 3 },
  }, {
    enabled: true,
    schedule: { intervalMinutes: 30 },
    limits: { maxBatchMessages: 80, maxAttempts: 4 },
  }, new Date("2026-07-17T00:00:00Z"));

  assert.equal(update.scheduleExpression, "30m");
  assert.equal(update.nextRunAt.toISOString(), "2026-07-17T00:30:00.000Z");
  assert.deepEqual(update.config, {
    profile: "primary",
    maxAttempts: 4,
    intervalSeconds: 1_800,
    maxBatchMessages: 80,
  });
});

test("daily schedule supports minute precision in Asia/Shanghai", () => {
  const update = normalizeJobUpdate({
    job_type: "memory_consolidation",
    configurable: true,
    enabled: true,
    schedule_expression: "0 3 * * *",
    config: { dailyHour: 3, maxBatchMessages: 100, maxAttempts: 3 },
  }, {
    schedule: { dailyTime: "03:45" },
  }, new Date("2026-07-17T18:00:00Z"));

  assert.equal(update.scheduleExpression, "45 3 * * *");
  assert.equal(update.nextRunAt.toISOString(), "2026-07-17T19:45:00.000Z");
  assert.equal(update.config.dailyMinute, 45);
});

test("disabled jobs clear their next run and system jobs reject edits", () => {
  const disabled = normalizeJobUpdate({
    job_type: "thought_tick",
    configurable: true,
    enabled: true,
    schedule_expression: "15m",
    config: { intervalSeconds: 900, maxBatchMessages: 50, maxAttempts: 3 },
  }, { enabled: false }, new Date("2026-07-17T00:00:00Z"));
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.nextRunAt, null);
  assert.equal(canConfigureJob({ job_type: "qq_ingress", configurable: false }), false);
  assert.throws(
    () => normalizeJobUpdate({ job_type: "qq_ingress", configurable: false }, {}),
    (error) => error.code === "job_not_configurable",
  );
});

test("invalid schedule and limits fail without silent fallback", () => {
  const job = {
    job_type: "thought_tick",
    configurable: true,
    enabled: true,
    schedule_expression: "15m",
    config: { intervalSeconds: 900, maxBatchMessages: 50, maxAttempts: 3 },
  };
  assert.throws(
    () => normalizeJobUpdate(job, { schedule: { intervalMinutes: 0 } }),
    (error) => error.code === "job_config_invalid",
  );
  assert.throws(
    () => normalizeJobUpdate(job, { limits: { maxAttempts: 20 } }),
    (error) => error.code === "job_config_invalid",
  );
});

test("nextRunAt advances overdue intervals and daily schedules deterministically", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  assert.equal(nextRunAt({
    job_type: "thought_tick",
    next_run_at: "2026-07-14T23:00:00Z",
    config: { intervalSeconds: 900 },
  }, now).toISOString(), "2026-07-15T00:15:00.000Z");
  assert.equal(nextRunAt({
    job_type: "memory_consolidation",
    config: { dailyHour: 3, dailyMinute: 30 },
  }, new Date("2026-07-14T20:00:00Z")).toISOString(), "2026-07-15T19:30:00.000Z");
});
