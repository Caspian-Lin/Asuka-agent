import assert from "node:assert/strict";
import test from "node:test";

import {
  canManuallyRunJob,
  formatJobMetrics,
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
