import assert from "node:assert/strict";
import test from "node:test";

import {
  canEditJobConfig,
  canManuallyRunJob,
  formatJobMetrics,
  formatRunScope,
  jobConfigDraft,
} from "../app/components/jobs-view.ts";

test("jobs view summarizes cognition outputs without decorative metrics", () => {
  assert.equal(formatJobMetrics({
    conversationCount: 2,
    messageCount: 8,
    thoughtCount: 1,
    candidateCount: 3,
  }), "2 个会话 · 8 条消息 · 1 条思绪 · 3 条记忆候选");
  assert.equal(formatJobMetrics({
    conversationCount: 0,
    messageCount: 0,
    thoughtCount: 0,
    candidateCount: 0,
  }), "0 个会话 · 0 条消息 · 0 条思绪 · 0 条记忆候选");
});

test("job configuration drafts expose only editable scheduler fields", () => {
  assert.deepEqual(jobConfigDraft({
    job_type: "thought_tick",
    enabled: true,
    config: {
      profile: "primary",
      intervalSeconds: 1_800,
      maxBatchMessages: 80,
      maxAttempts: 4,
    },
  }), {
    enabled: true,
    intervalMinutes: 30,
    dailyTime: "03:00",
    maxBatchMessages: 80,
    maxAttempts: 4,
  });
});

test("run scope resolves the durable conversation parameter for audit copy", () => {
  const conversations = [{ id: "conversation-1", title: "产品讨论群" }];
  assert.equal(formatRunScope({}, conversations), "所有有新增消息的会话");
  assert.equal(
    formatRunScope({ conversationId: "conversation-1" }, conversations),
    "产品讨论群",
  );
  assert.equal(
    formatRunScope({ conversationId: "deleted" }, conversations),
    "会话 deleted",
  );
});

test("only active cognition jobs expose manual execution", () => {
  assert.equal(canManuallyRunJob({
    job_type: "thought_tick",
    enabled: true,
    status: "active",
  }), true);
  assert.equal(canManuallyRunJob({
    job_type: "qq_ingress",
    enabled: true,
    status: "active",
  }), false);
  assert.equal(canManuallyRunJob({
    job_type: "memory_consolidation",
    enabled: false,
    status: "planned",
  }), false);
});

test("only implemented cognition jobs expose configuration editing", () => {
  assert.equal(canEditJobConfig({
    job_type: "thought_tick",
    configurable: true,
  }), true);
  assert.equal(canEditJobConfig({
    job_type: "evaluation_regression",
    configurable: true,
  }), false);
  assert.equal(canEditJobConfig({
    job_type: "qq_ingress",
    configurable: false,
  }), false);
});
