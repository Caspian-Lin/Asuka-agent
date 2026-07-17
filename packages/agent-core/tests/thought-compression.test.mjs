import assert from "node:assert/strict";
import test from "node:test";

import {
  THOUGHT_COMPRESSION_PROMPT_VERSION,
  thoughtCompressionRequest,
  validateThoughtCompressionResult,
} from "../src/thought-compression.mjs";

const sections = `## 正在继续
继续准备露营。
## 未决任务与承诺
Asuka 仍需整理清单。
## 参与者状态与身份归因
小林（user-1）负责饮食确认。
## Asuka 当前立场
等待成员补充需求。
## 动作状态与记忆引用
无。
## 需保留的工具结论
无。`;

test("compression uses primary without exposing any callable tool", () => {
  const request = thoughtCompressionRequest({
    sourceMessages: [{ role: "assistant", content: "旧思绪" }],
    participants: [{ participantId: "user-1", displayName: "小林" }],
    sourceEpochOrdinal: 2,
    coversThroughThoughtRunId: "thought-9",
  });
  assert.equal(request.profile, "primary");
  assert.equal(request.purpose, "compression");
  assert.equal(request.promptVersion, THOUGHT_COMPRESSION_PROMPT_VERSION);
  assert.equal(request.responseSchema, undefined);
  assert.deepEqual(request.tools, []);
  assert.equal(request.toolChoice, "none");
  assert.match(request.messages.at(-1).content, /小林（user-1）/);
  assert.match(request.messages.at(-1).content, /thought-9/);
});

test("compression rejects fabricated tool calls and incomplete attribution", () => {
  assert.throws(
    () => validateThoughtCompressionResult({
      content: sections,
      toolCalls: [{ id: "forged", function: { name: "send_message", arguments: "{}" } }],
    }),
    (error) => error.code === "compression_tool_call_rejected" && error.retryable,
  );
  assert.throws(
    () => validateThoughtCompressionResult({
      content: sections.replace("小林（user-1）", "小林"),
      toolCalls: [],
    }, {
      participants: [{ participantId: "user-1", displayName: "小林" }],
    }),
    (error) => error.code === "compression_identity_reference_missing",
  );
  assert.equal(validateThoughtCompressionResult({
    content: sections,
    toolCalls: [],
  }, {
    participants: [{ participantId: "user-1", displayName: "小林" }],
  }), sections);
});
