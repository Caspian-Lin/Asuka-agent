import assert from "node:assert/strict";
import test from "node:test";

import {
  actionCompilerRequest,
  actionProposalIdempotencyKey,
  buildCompilerInput,
  parseActionCompilerContent,
  primaryRevisionRequest,
  selectReusableCompilerCall,
  validateCompilerOutput,
} from "../src/action-compiler.mjs";

function inputFixture() {
  return buildCompilerInput({
    thoughtRunId: "thought-1",
    primaryOutput: [
      "我注意到 A 在确认露营天气，但 B 还没有回复。",
      "可以回复：周六天气看起来不错，B 方便的话也说下时间？",
      "A 说自己不吃辣，这可以作为待审记忆。",
    ].join("\n"),
    conversation: { id: "group:1", type: "group" },
    participants: [
      { id: "A", displayName: "小林" },
      { id: "B", displayName: "阿白" },
      { id: "agent-asuka", displayName: "Asuka" },
    ],
    references: [
      { type: "message", id: "m1", senderId: "A" },
      { type: "message", id: "m2", senderId: "B" },
      { type: "source", id: "tool-1" },
    ],
  });
}

function action(overrides = {}) {
  return {
    type: "reply",
    content: "周六天气看起来不错，B 方便的话也说下时间？",
    targetConversationId: "group:1",
    replyToMessageId: "m1",
    subjectId: null,
    sourceSpeakerId: null,
    evidenceReferences: [{ type: "message", id: "m1" }],
    sensitivity: "normal",
    ...overrides,
  };
}

test("compiler request is strict JSON on the fast profile", () => {
  const request = actionCompilerRequest(inputFixture());
  assert.equal(request.profile, "fast");
  assert.equal(request.purpose, "compiler");
  assert.equal(request.responseSchema.additionalProperties, false);
  assert.match(request.messages[0].content, /exact contiguous substring/);
});

test("accepted reply must copy primary text and stay inside manifest", () => {
  const result = validateCompilerOutput({
    status: "accepted",
    revisionReasons: [],
    actions: [action()],
  }, inputFixture());
  assert.equal(result.actions[0].type, "reply");
  assert.equal(result.actions[0].replyToMessageId, "m1");

  assert.throws(
    () => validateCompilerOutput({
      status: "accepted",
      revisionReasons: [],
      actions: [action({ content: "我替 primary 润色了一句" })],
    }, inputFixture()),
    (error) => error.code === "compiler_content_rewritten",
  );
  assert.throws(
    () => validateCompilerOutput({
      status: "accepted",
      revisionReasons: [],
      actions: [action({
        evidenceReferences: [{ type: "message", id: "outside" }],
      })],
    }, inputFixture()),
    (error) => error.code === "compiler_reference_outside_manifest",
  );
});

test("memory proposal validates source speaker against message evidence", () => {
  const valid = action({
    type: "memory",
    content: "A 说自己不吃辣，这可以作为待审记忆。",
    targetConversationId: null,
    replyToMessageId: null,
    subjectId: "A",
    sourceSpeakerId: "A",
  });
  assert.equal(validateCompilerOutput({
    status: "accepted",
    revisionReasons: [],
    actions: [valid],
  }, inputFixture()).actions[0].subjectId, "A");
  assert.throws(
    () => validateCompilerOutput({
      status: "accepted",
      revisionReasons: [],
      actions: [{ ...valid, sourceSpeakerId: "B" }],
    }, inputFixture()),
    (error) => error.code === "compiler_invalid_identity",
  );
});

test("needs_revision and no_action are distinct successful protocols", () => {
  assert.deepEqual(validateCompilerOutput({
    status: "needs_revision",
    revisionReasons: ["缺少可直接发送的回复原文"],
    actions: [],
  }, inputFixture()), {
    status: "needs_revision",
    revisionReasons: ["缺少可直接发送的回复原文"],
    actions: [],
  });
  const noAction = validateCompilerOutput({
    status: "accepted",
    revisionReasons: [],
    actions: [action({
      type: "no_action",
      content: "",
      targetConversationId: null,
      replyToMessageId: null,
      evidenceReferences: [],
    })],
  }, inputFixture());
  assert.equal(noAction.actions[0].type, "no_action");
});

test("invalid JSON fails without changing the primary output", () => {
  assert.throws(
    () => parseActionCompilerContent("not-json"),
    (error) => error.code === "compiler_invalid_json",
  );
  assert.deepEqual(parseActionCompilerContent("```json\n{\"status\":\"accepted\"}\n```"), {
    status: "accepted",
  });
});

test("revision feedback appends to the original primary context without JSON mode", () => {
  const request = primaryRevisionRequest({
    requestContext: [{ role: "system", content: "You are Asuka" }],
    currentOutput: "原思绪",
    revisionReasons: ["缺少证据 ID"],
  });
  assert.equal(request.profile, "primary");
  assert.equal(request.responseSchema, undefined);
  assert.equal(request.messages[1].content, "原思绪");
  assert.match(request.messages[2].content, /缺少证据 ID/);
});

test("proposal idempotency is stable across compiler retries", () => {
  const proposal = action();
  assert.equal(
    actionProposalIdempotencyKey("thought-1", 0, proposal),
    actionProposalIdempotencyKey("thought-1", 0, proposal),
  );
  assert.notEqual(
    actionProposalIdempotencyKey("thought-1", 0, proposal),
    actionProposalIdempotencyKey("thought-1", 1, proposal),
  );
});

test("restart resumes only a valid compiler call for the current primary revision", () => {
  const calls = [
    { id: "old", response_json: { metadata: { sourceOutputHash: "hash-old" } } },
    { id: "invalid", response_json: { metadata: { sourceOutputHash: "hash-new" } } },
    { id: "usable", response_json: { metadata: { sourceOutputHash: "hash-new" } } },
  ];
  assert.equal(
    selectReusableCompilerCall(calls, new Set(["invalid"]), "hash-new").id,
    "usable",
  );
  assert.equal(
    selectReusableCompilerCall(calls.slice(0, 2), new Set(["invalid"]), "hash-new"),
    null,
  );
});
