import assert from "node:assert/strict";
import test from "node:test";

import {
  projectThoughtContext,
  selectInitializationHistory,
  shouldUseInitializationHistory,
  sourceToChatMessage,
  ThoughtContextError,
} from "../src/thought-context.mjs";

function source(id, {
  authorKind = "user",
  senderId = "user-a",
  senderDisplayName = senderId,
  at = `2026-07-16T00:${String(Number(id.replace(/\D/g, "") || 0)).padStart(2, "0")}:00Z`,
  content = `message ${id}`,
  conversationType = "group",
  replyTo = null,
} = {}) {
  return {
    message_id: id,
    author_kind: authorKind,
    sender_id: senderId,
    sender_display_name: senderDisplayName,
    reply_to: replyTo,
    sent_at: at,
    conversation_type: conversationType,
    content,
  };
}

const systemMessages = [{ role: "system", content: "You are Asuka. Stable prompt." }];

test("initialization history is the deduplicated union of last N and recent minutes", () => {
  const messages = [
    source("m1", { at: "2026-07-16T00:00:00Z" }),
    source("m2", { at: "2026-07-16T00:40:00Z" }),
    source("m3", { at: "2026-07-16T00:50:00Z" }),
    source("m3", { at: "2026-07-16T00:50:00Z" }),
    source("m4", { at: "2026-07-16T00:59:00Z" }),
  ];
  assert.deepEqual(
    selectInitializationHistory({
      messages,
      maxCount: 2,
      recentMinutes: 20,
      anchorAt: "2026-07-16T01:00:00Z",
    }).map((message) => message.message_id),
    ["m2", "m3", "m4"],
  );
});

test("user messages prefer stable names while retaining auditable identity references", () => {
  const userMessage = sourceToChatMessage(source("m1", {
    conversationType: "private",
    senderDisplayName: "小林",
  }));
  const agentMessage = sourceToChatMessage(source("m2", {
    authorKind: "agent",
    senderId: "agent-asuka",
    conversationType: "private",
  }));
  assert.equal(userMessage.role, "user");
  assert.match(userMessage.content, /说话人=小林/);
  assert.match(userMessage.content, /身份引用=user-a/);
  assert.match(userMessage.content, /消息引用=m1/);
  assert.match(userMessage.content, /小林：message m1/);
  assert.doesNotMatch(userMessage.content, /\{"message_id"/);
  assert.equal(agentMessage.role, "assistant");
  assert.match(agentMessage.content, /Asuka 之前的消息/);
  assert.match(agentMessage.content, /Asuka：message m2/);
});

test("only the first epoch may bootstrap historical messages", () => {
  assert.equal(shouldUseInitializationHistory({
    epochOrdinal: 1,
    committedTurnCount: 0,
    hasCompression: false,
  }), true);
  assert.equal(shouldUseInitializationHistory({
    epochOrdinal: 2,
    committedTurnCount: 0,
    hasCompression: false,
  }), false);
  assert.equal(shouldUseInitializationHistory({
    epochOrdinal: 1,
    committedTurnCount: 1,
    hasCompression: false,
  }), false);
});

test("conversation projections never mix sources and retain reply targets", () => {
  const first = projectThoughtContext({
    systemMessages,
    newMessages: [source("group-a", { replyTo: "external-parent-a" })],
    contextWindow: 2_000,
    reservedOutputTokens: 200,
    reservedToolResultTokens: 100,
  }).chunks[0];
  const second = projectThoughtContext({
    systemMessages,
    newMessages: [source("private-b", {
      senderId: "user-b",
      conversationType: "private",
    })],
    contextWindow: 2_000,
    reservedOutputTokens: 200,
    reservedToolResultTokens: 100,
  }).chunks[0];
  assert.match(first.messages.at(-1).content, /external-parent-a/);
  assert.doesNotMatch(first.messages.at(-1).content, /private-b|user-b/);
  assert.doesNotMatch(second.messages.at(-1).content, /group-a|external-parent-a/);
});

test("projection keeps stable order and exact auditable context items", () => {
  const projection = projectThoughtContext({
    systemMessages,
    compression: {
      epochId: "epoch-1",
      ordinal: 1,
      output: "仍在讨论周末露营。",
      promptVersion: "compression-v1",
    },
    initializationHistory: [source("history-1")],
    committedTurns: [{
      thoughtRunId: "turn-1",
      turnOrdinal: 1,
      newMessages: [source("committed-1")],
      primaryOutput: "我还在等大家确认天气。",
      actionState: "no_action",
    }],
    recalledMemories: [{
      memoryId: "memory-1",
      content: "A 不吃辣。",
      subjectId: "user-a",
      evidenceIds: ["old-1"],
      relevance: 0.8,
    }],
    newMessages: [source("new-1")],
    contextWindow: 2_000,
    reservedOutputTokens: 200,
    reservedToolResultTokens: 100,
  }).chunks[0];

  assert.deepEqual(projection.messages.map((message) => message.role), [
    "system", "user", "user", "user", "assistant", "user", "user",
  ]);
  assert.deepEqual(projection.contextItems.map((item) => item.metadata.section), [
    "compression",
    "initialization_history",
    "committed_turn",
    "committed_turn",
    "recalled_memory",
    "new_source",
  ]);
  const committedMessage = projection.contextItems.find((item) => (
    item.itemType === "message" && item.metadata.section === "committed_turn"
  ));
  assert.equal(committedMessage.metadata.thoughtRunId, "turn-1");
  assert.equal(committedMessage.metadata.turnOrdinal, 1);
  assert.match(projection.messages[1].content, /上一上下文段摘要/);
  assert.equal(projection.newMessageStartId, "new-1");
  assert.equal(projection.newMessageEndId, "new-1");
});

test("large new-message batches split in order without omission or duplication", () => {
  const newMessages = Array.from({ length: 6 }, (_, index) => source(`m${index + 1}`, {
    content: "x".repeat(420),
  }));
  const result = projectThoughtContext({
    systemMessages,
    newMessages,
    contextWindow: 700,
    reservedOutputTokens: 200,
    reservedToolResultTokens: 100,
  });
  assert.ok(result.chunks.length > 1);
  assert.deepEqual(
    result.chunks.flatMap((chunk) => chunk.contextItems
      .filter((item) => item.metadata.section === "new_source")
      .map((item) => item.referenceId)),
    newMessages.map((message) => message.message_id),
  );
  assert.ok(result.chunks.every((chunk) => chunk.inputTokens <= result.softLimit));
});

test("optional history is pruned before mandatory new messages", () => {
  const result = projectThoughtContext({
    systemMessages,
    initializationHistory: Array.from({ length: 5 }, (_, index) => source(`h${index}`, {
      content: "history ".repeat(100),
    })),
    newMessages: [source("new", { content: "new message" })],
    contextWindow: 700,
    reservedOutputTokens: 200,
    reservedToolResultTokens: 100,
  }).chunks[0];
  assert.equal(result.newMessageEndId, "new");
  assert.ok(result.omittedHistoryCount > 0);
});

test("a single oversized required source fails without producing a skippable chunk", () => {
  assert.throws(
    () => projectThoughtContext({
      systemMessages,
      newMessages: [source("huge", { content: "太长".repeat(2_000) })],
      contextWindow: 700,
      reservedOutputTokens: 200,
      reservedToolResultTokens: 100,
    }),
    (error) => error instanceof ThoughtContextError && error.code === "source_too_large",
  );
});
