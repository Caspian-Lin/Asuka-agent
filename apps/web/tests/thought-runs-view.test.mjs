import assert from "node:assert/strict";
import test from "node:test";

import {
  collectContextSections,
  describeSystemInstruction,
  describeToolArguments,
  groupThoughtRuns,
  thoughtCallStageLabel,
} from "../app/components/thought-runs-view.ts";

test("thought runs stay grouped by conversation in latest-seen order", () => {
  const groups = groupThoughtRuns([
    { id: "a2", conversation_id: "a", conversation_title: "A 群", created_at: "2026-07-17T02:00:00Z" },
    { id: "b1", conversation_id: "b", conversation_title: "B 私聊", created_at: "2026-07-17T01:00:00Z" },
    { id: "a1", conversation_id: "a", conversation_title: "A 群", created_at: "2026-07-17T00:00:00Z" },
  ]);
  assert.deepEqual(groups.map((group) => group.conversationId), ["a", "b"]);
  assert.deepEqual(groups[0].runs.map((run) => run.id), ["a2", "a1"]);
});

test("context sources are deduplicated and separated by provenance", () => {
  const unread = {
    id: "item-1",
    itemType: "message",
    referenceId: "message-1",
    title: "小林",
    content: "今晚继续吗？",
    metadata: { section: "new_source" },
  };
  const sections = collectContextSections([
    { context_items: [
      { ...unread, id: "item-a" },
      { id: "item-2", itemType: "thought_turn", referenceId: "turn-1", title: "上一轮思绪", content: "等待确认", metadata: { section: "committed_turn" } },
    ] },
    { context_items: [{ ...unread, id: "item-b" }] },
  ]);
  assert.deepEqual(sections.map((section) => section.key), [
    "history_thoughts",
    "unread_messages",
  ]);
  assert.equal(sections[1].items.length, 1);
});

test("tool calls describe intent without exposing raw message IDs", () => {
  assert.equal(describeToolArguments(
    "lookup_message_sources",
    JSON.stringify({ messageIds: ["10001", "10002"] }),
  ), "核对 2 条已引用消息");
  assert.equal(describeToolArguments(
    "search_conversation_messages",
    JSON.stringify({ query: "露营", limit: 5 }),
  ), "“露营” · 最多 5 条");
});

test("system instructions are labeled by responsibility instead of sharing one generic label", () => {
  assert.equal(
    describeSystemInstruction("You are Asuka. Use evidence.").label,
    "Agent 行为指令",
  );
  assert.equal(
    describeSystemInstruction("You are a deterministic action compiler.").label,
    "动作编译指令",
  );
  assert.equal(
    describeSystemInstruction("Return only one valid JSON object.\nJSON Schema: {}").label,
    "输出格式约束",
  );
});

test("current run calls describe their stage instead of labeling every output as natural thought", () => {
  assert.equal(thoughtCallStageLabel({
    purpose: "primary",
    response_json: { toolCalls: [{}] },
  }), "请求补充资料");
  assert.equal(thoughtCallStageLabel({
    purpose: "tool_continuation",
    response_json: { content: "形成结论" },
  }), "工具后形成本次 Thought");
  assert.equal(thoughtCallStageLabel({
    purpose: "compiler",
    response_json: { content: "{}" },
  }), "编译动作候选");
  assert.equal(thoughtCallStageLabel({
    purpose: "primary",
    status: "failed",
    error_code: "timeout",
  }), "主模型调用失败");
});
