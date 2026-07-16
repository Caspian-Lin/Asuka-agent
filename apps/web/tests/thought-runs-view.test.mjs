import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThoughtContextOutline,
  callRetryIndex,
  collectContextSections,
  collectPrimarySystemInstructions,
  describeSystemInstruction,
  describeToolArguments,
  groupThoughtRuns,
  recordedRequestPayload,
  thoughtCallStageLabel,
  toolDescription,
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

test("provided read-only tools stay visible while compiler manifests stay hidden", () => {
  const sections = collectContextSections([{ context_items: [
    {
      id: "tool-1",
      itemType: "tool_definition",
      referenceId: "search_conversation_messages",
      title: "Read-only tool",
      content: "Search messages",
      metadata: { section: "tools", schema: { type: "object" } },
    },
    {
      id: "manifest-1",
      itemType: "compiler_manifest",
      referenceId: null,
      title: "Compiler manifest",
      content: "{}",
      metadata: { section: "compiler_manifest" },
    },
  ] }]);

  assert.deepEqual(sections.map((section) => section.key), ["available_tools"]);
  assert.equal(
    toolDescription("search_conversation_messages"),
    "按关键词检索当前会话的历史消息，不跨会话读取。",
  );
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

test("primary context summary excludes compiler JSON constraints and deduplicates continuations", () => {
  const agentInstruction = { role: "system", content: "You are Asuka. Use evidence." };
  const instructions = collectPrimarySystemInstructions([
    { purpose: "primary", request_context: [agentInstruction] },
    { purpose: "tool_continuation", request_context: [agentInstruction] },
    { purpose: "compiler", request_context: [
      { role: "system", content: "Return only one valid JSON object.\nJSON Schema: {}" },
      { role: "system", content: "You are a deterministic action compiler." },
    ] },
  ]);

  assert.deepEqual(instructions.map((instruction) => instruction.label), [
    "Agent 行为指令",
  ]);
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

test("audit outline groups original messages under their persisted Thought turn", () => {
  const outline = buildThoughtContextOutline([{ context_items: [
    {
      id: "history-message",
      itemType: "message",
      referenceId: "message-1",
      title: "小林",
      content: "周六去露营",
      metadata: { section: "committed_turn", thoughtRunId: "thought-1", turnOrdinal: 1 },
    },
    {
      id: "history-thought",
      itemType: "thought_turn",
      referenceId: "thought-1",
      title: "Thought 1",
      content: "需要继续确认天气。",
      metadata: { section: "committed_turn", turnOrdinal: 1 },
    },
    {
      id: "current-message",
      itemType: "message",
      referenceId: "message-2",
      title: "阿遥",
      content: "我来订营地",
      metadata: { section: "new_source" },
    },
  ] }]);

  assert.equal(outline.previousTurns.length, 1);
  assert.equal(outline.previousTurns[0].messages[0].content, "周六去露营");
  assert.equal(outline.previousTurns[0].thought?.content, "需要继续确认天气。");
  assert.equal(outline.currentMessages[0].content, "我来订营地");
});

test("identical persisted request hashes expose an actual retry index", () => {
  const calls = [
    { id: "call-1", input_hash: "same" },
    { id: "call-2", input_hash: "other" },
    { id: "call-3", input_hash: "same" },
  ];
  assert.equal(callRetryIndex(calls, calls[0]), 0);
  assert.equal(callRetryIndex(calls, calls[2]), 1);
});

test("full call payload prefers the exact provider JSON and keeps tools in legacy records", () => {
  const exactJson = "{\"model\":\"primary\",\"messages\":[],\"tools\":[{\"type\":\"function\"}]}";
  assert.deepEqual(recordedRequestPayload({
    request_context: [],
    context_items: [{
      id: "payload",
      itemType: "request_payload",
      referenceId: "prompt-v1",
      title: "Provider request JSON",
      content: exactJson,
      metadata: { section: "provider_request" },
    }],
  }), { exact: true, json: exactJson });

  const legacy = recordedRequestPayload({
    request_context: [{ role: "user", content: "查一下" }],
    context_items: [{
      id: "tool",
      itemType: "tool_definition",
      referenceId: "search_conversation_messages",
      title: "Read-only tool",
      content: "Search messages",
      metadata: { section: "tools", schema: { type: "object" } },
    }],
  });
  assert.equal(legacy.exact, false);
  assert.deepEqual(JSON.parse(legacy.json).tools, [{
    type: "function",
    function: {
      name: "search_conversation_messages",
      description: "Search messages",
      parameters: { type: "object" },
    },
  }]);
});
