import assert from "node:assert/strict";
import test from "node:test";

import { LlmConfigurationError } from "@asuka-agent/llm/runtime";
import {
  committedToolTraceMessages,
  cognitionError,
  cognitionTriggerReason,
  nextRunAt,
  retryDelayMs,
  thoughtEpochIdFor,
  thoughtRunIdFor,
  thoughtStreamIdFor,
} from "../src/cognition-worker.mjs";

test("thought schedules advance from the later of due time and current time", () => {
  const now = new Date("2026-07-15T00:00:00Z");
  const next = nextRunAt({
    job_type: "thought_tick",
    next_run_at: "2026-07-14T23:00:00Z",
    config: { intervalSeconds: 900 },
  }, now);
  assert.equal(next.toISOString(), "2026-07-15T00:15:00.000Z");
});

test("daily consolidation resolves the next 03:00 Asia/Shanghai boundary", () => {
  const before = nextRunAt({
    job_type: "memory_consolidation",
    config: { dailyHour: 3 },
  }, new Date("2026-07-14T18:00:00Z"));
  const after = nextRunAt({
    job_type: "memory_consolidation",
    config: { dailyHour: 3 },
  }, new Date("2026-07-14T20:00:00Z"));
  assert.equal(before.toISOString(), "2026-07-14T19:00:00.000Z");
  assert.equal(after.toISOString(), "2026-07-15T19:00:00.000Z");
});

test("only transient provider failures retry with bounded backoff", () => {
  assert.equal(cognitionError(
    new LlmConfigurationError("provider_timeout", "timeout", 502),
  ).retryable, true);
  assert.equal(cognitionError(
    new LlmConfigurationError("api_key_missing", "missing", 503),
  ).retryable, false);
  assert.equal(cognitionError(
    new LlmConfigurationError("provider_output_exhausted", "budget", 502),
  ).retryable, false);
  assert.deepEqual([1, 2, 9].map(retryDelayMs), [15_000, 30_000, 300_000]);
});

test("thought runs keep stable identity and explicit trigger provenance", () => {
  assert.equal(
    thoughtRunIdFor("job-run-1", "conversation-1"),
    thoughtRunIdFor("job-run-1", "conversation-1"),
  );
  assert.notEqual(
    thoughtRunIdFor("job-run-1", "conversation-1"),
    thoughtRunIdFor("job-run-1", "conversation-2"),
  );
  assert.match(cognitionTriggerReason({
    trigger_type: "schedule",
    job_type: "thought_tick",
  }), /定时计划到期/);
  assert.match(cognitionTriggerReason({
    trigger_type: "manual",
    job_type: "memory_consolidation",
  }), /手动触发.*记忆候选/);
});

test("thought streams and epochs have stable conversation-scoped identities", () => {
  const stream = thoughtStreamIdFor("agent-asuka", "conversation-1");
  assert.equal(stream, thoughtStreamIdFor("agent-asuka", "conversation-1"));
  assert.notEqual(stream, thoughtStreamIdFor("agent-asuka", "conversation-2"));
  assert.equal(
    thoughtEpochIdFor(stream, 1),
    thoughtEpochIdFor(stream, 1),
  );
  assert.notEqual(thoughtEpochIdFor(stream, 1), thoughtEpochIdFor(stream, 2));
});

test("committed tool calls rebuild exact assistant and tool messages for later Thoughts", () => {
  const toolCalls = [{
    id: "call-1",
    type: "function",
    function: { name: "recall_memories", arguments: "{\"query\":\"猫\"}" },
  }];
  assert.deepEqual(committedToolTraceMessages([{
    id: "llm-call-1",
    sequence_number: 3,
    response_json: { content: "我先查一下。", toolCalls },
    tool_results: [{
      referenceId: "call-1",
      content: "{\"ok\":true,\"memories\":[]}",
      metadata: { toolName: "recall_memories" },
    }],
  }]), [{
    callId: "llm-call-1",
    sequenceNumber: 3,
    message: { role: "assistant", content: "我先查一下。", tool_calls: toolCalls },
  }, {
    callId: "llm-call-1",
    sequenceNumber: 3,
    message: {
      role: "tool",
      tool_call_id: "call-1",
      name: "recall_memories",
      content: "{\"ok\":true,\"memories\":[]}",
    },
  }]);
  assert.throws(() => committedToolTraceMessages([{
    id: "llm-call-broken",
    sequence_number: 4,
    response_json: { toolCalls },
    tool_results: [],
  }]), /缺少工具 call-1 的返回记录/);
});
