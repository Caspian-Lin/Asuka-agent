import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePrimaryToolCall,
  PRIMARY_THOUGHT_PROMPT_VERSION,
  PRIMARY_THOUGHT_SYSTEM_PROMPT,
  PRIMARY_THOUGHT_TOOLS,
  primaryThoughtRequest,
  primaryToolCallKey,
  runPrimaryToolLoop,
} from "../src/primary-thought.mjs";

test("primary prompt fixes Asuka identity and multi-party attribution without JSON mode", () => {
  const request = primaryThoughtRequest([
    { role: "system", content: PRIMARY_THOUGHT_SYSTEM_PROMPT },
    { role: "user", content: "new message" },
  ]);
  assert.equal(request.profile, "primary");
  assert.equal(request.promptVersion, PRIMARY_THOUGHT_PROMPT_VERSION);
  assert.equal(request.responseSchema, undefined);
  assert.match(PRIMARY_THOUGHT_SYSTEM_PROMPT, /You are Asuka/);
  assert.match(PRIMARY_THOUGHT_SYSTEM_PROMPT, /sender_id/);
  assert.match(PRIMARY_THOUGHT_SYSTEM_PROMPT, /stable display name/);
  assert.match(PRIMARY_THOUGHT_SYSTEM_PROMPT, /author_kind=agent/);
  assert.match(PRIMARY_THOUGHT_SYSTEM_PROMPT, /natural Markdown, not JSON/);
});

test("tool surface is stable, sorted, and read-only", () => {
  const names = PRIMARY_THOUGHT_TOOLS.map((tool) => tool.function.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(names, [
    "lookup_message_sources",
    "recall_memories",
    "search_conversation_messages",
  ]);
  assert.ok(names.every((name) => !/(send|write|delete|activate)/i.test(name)));
});

test("tool calls validate arguments and keep a stable idempotency key", () => {
  const call = {
    id: "call-1",
    type: "function",
    function: {
      name: "search_conversation_messages",
      arguments: JSON.stringify({ query: "露营", limit: 5 }),
    },
  };
  assert.deepEqual(parsePrimaryToolCall(call), {
    name: "search_conversation_messages",
    arguments: { query: "露营", limit: 5 },
  });
  assert.equal(primaryToolCallKey("thought-1", call), primaryToolCallKey("thought-1", call));
  assert.throws(
    () => parsePrimaryToolCall({
      ...call,
      function: { name: "send_message", arguments: "{}" },
    }),
    (error) => error.code === "tool_not_allowed",
  );
  assert.throws(
    () => parsePrimaryToolCall({
      ...call,
      function: { ...call.function, arguments: "not-json" },
    }),
    (error) => error.code === "invalid_tool_arguments",
  );
});

test("message source lookup rejects duplicated or empty identities", () => {
  assert.throws(
    () => parsePrimaryToolCall({
      id: "call-2",
      function: {
        name: "lookup_message_sources",
        arguments: JSON.stringify({ messageIds: ["m1", "m1"] }),
      },
    }),
    (error) => error.code === "invalid_tool_arguments",
  );
});

test("primary loop completes without tools in one natural-text round", async () => {
  let rounds = 0;
  const result = await runPrimaryToolLoop({
    initialMessages: [{ role: "user", content: "hello" }],
    limits: { maxRounds: 3, maxTokens: 1_000, maxToolCalls: 3, maxActiveMs: 5_000 },
    readUsage: async () => ({ rounds, tokens: 0, toolCalls: 0 }),
    invokeModel: async () => {
      rounds += 1;
      return {
        llmCallId: `call-${rounds}`,
        result: { content: "自然思绪", toolCalls: [] },
      };
    },
    executeTools: async () => assert.fail("tools should not run"),
  });
  assert.deepEqual(result, { output: "自然思绪", callsCreated: 1 });
});

test("primary loop appends auditable tool results before continuation", async () => {
  let rounds = 0;
  let toolCalls = 0;
  let continuationMessages;
  const result = await runPrimaryToolLoop({
    initialMessages: [{ role: "user", content: "查找露营" }],
    limits: { maxRounds: 3, maxTokens: 1_000, maxToolCalls: 3, maxActiveMs: 5_000 },
    readUsage: async () => ({ rounds, tokens: 0, toolCalls }),
    invokeModel: async ({ messages, purpose }) => {
      rounds += 1;
      if (rounds === 1) {
        assert.equal(purpose, "primary");
        return {
          llmCallId: "call-1",
          result: {
            content: "",
            toolCalls: [{
              id: "tool-1",
              function: {
                name: "search_conversation_messages",
                arguments: "{\"query\":\"露营\",\"limit\":3}",
              },
            }],
          },
        };
      }
      continuationMessages = messages;
      assert.equal(purpose, "tool_continuation");
      return {
        llmCallId: "call-2",
        result: { content: "基于旧消息形成的自然思绪", toolCalls: [] },
      };
    },
    executeTools: async ({ llmCallId, toolCalls: requested }) => {
      assert.equal(llmCallId, "call-1");
      toolCalls += requested.length;
      return [{
        role: "tool",
        tool_call_id: "tool-1",
        name: "search_conversation_messages",
        content: "{\"ok\":true}",
      }];
    },
  });
  assert.equal(result.callsCreated, 2);
  assert.equal(continuationMessages.at(-2).role, "assistant");
  assert.equal(continuationMessages.at(-1).role, "tool");
});

test("primary loop fails closed at tool budget", async () => {
  await assert.rejects(
    runPrimaryToolLoop({
      initialMessages: [{ role: "user", content: "loop" }],
      limits: { maxRounds: 3, maxTokens: 1_000, maxToolCalls: 0, maxActiveMs: 5_000 },
      readUsage: async () => ({ rounds: 0, tokens: 0, toolCalls: 0 }),
      invokeModel: async () => ({
        llmCallId: "call-1",
        result: {
          content: "",
          toolCalls: [{ id: "tool-1", function: { name: "x", arguments: "{}" } }],
        },
      }),
      executeTools: async () => [],
    }),
    (error) => error.code === "primary_tool_budget",
  );
});
