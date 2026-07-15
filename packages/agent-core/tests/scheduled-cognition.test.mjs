import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpeakerContext,
  cognitionRequest,
  outputIdempotencyKey,
  validateMemoryOutput,
} from "../src/scheduled-cognition.mjs";

function contextFixture() {
  return buildSpeakerContext({
    conversation: {
      id: "group:1",
      title: "测试群",
      channel: "napcat",
      externalId: "group:1",
    },
    participants: [
      { participantId: "A", displayName: "小林", aliases: ["Lin"] },
      { participantId: "B", displayName: "阿白", aliases: ["Bai"] },
    ],
    messages: [
      {
        id: "m1",
        senderId: "A",
        senderDisplayName: "小林",
        createdAt: "2026-07-15T00:00:00Z",
        content: "我喜欢爵士乐",
      },
      {
        id: "m2",
        senderId: "B",
        senderDisplayName: "阿白",
        replyTo: "external-m1",
        createdAt: "2026-07-15T00:01:00Z",
        content: "我不喜欢爵士乐",
      },
      {
        id: "m3",
        senderId: "A",
        senderDisplayName: "Lin",
        createdAt: "2026-07-15T00:02:00Z",
        content: "B 说他更喜欢古典乐",
      },
    ],
  });
}

test("speaker context keeps stable IDs while retaining nickname aliases", () => {
  const context = contextFixture();
  assert.deepEqual(context.participants[0], {
    participant_id: "A",
    display_name: "小林",
    aliases: ["小林", "Lin"],
  });
  assert.equal(context.messages[2].sender_id, "A");
  assert.equal(context.messages[2].sender_display_name, "Lin");
});

test("A and B preferences remain attributed to their own stable identities", () => {
  const context = contextFixture();
  const candidates = validateMemoryOutput({
    candidates: [
      {
        operation: "create",
        subjectId: "A",
        sourceSpeakerId: "A",
        claim: "A 喜欢爵士乐",
        evidenceMessageIds: ["m1"],
        confidence: 0.95,
        attributionStatus: "resolved",
        targetCandidateId: null,
      },
      {
        operation: "create",
        subjectId: "B",
        sourceSpeakerId: "B",
        claim: "B 不喜欢爵士乐",
        evidenceMessageIds: ["m2"],
        confidence: 0.94,
        attributionStatus: "resolved",
        targetCandidateId: null,
      },
    ],
  }, context);
  assert.deepEqual(candidates.map((candidate) => candidate.subjectId), ["A", "B"]);
});

test("reported speech distinguishes source speaker from explicit subject", () => {
  const [candidate] = validateMemoryOutput({
    candidates: [{
      operation: "create",
      subjectId: "B",
      sourceSpeakerId: "A",
      claim: "B 更喜欢古典乐",
      evidenceMessageIds: ["m3"],
      confidence: 0.7,
      attributionStatus: "resolved",
      targetCandidateId: null,
    }],
  }, contextFixture());
  assert.equal(candidate.sourceSpeakerId, "A");
  assert.equal(candidate.subjectId, "B");
});

test("a source speaker cannot cite only another participant's utterance", () => {
  assert.throws(
    () => validateMemoryOutput({
      candidates: [{
        operation: "create",
        subjectId: "B",
        sourceSpeakerId: "B",
        claim: "把 A 的证据错记给 B",
        evidenceMessageIds: ["m1"],
        confidence: 0.9,
        attributionStatus: "resolved",
        targetCandidateId: null,
      }],
    }, contextFixture()),
    (error) => error.code === "invalid_attribution",
  );
});

test("ambiguous pronouns stay unresolved instead of binding the current speaker", () => {
  const context = contextFixture();
  const [candidate] = validateMemoryOutput({
    candidates: [{
      operation: "create",
      subjectId: null,
      sourceSpeakerId: "A",
      claim: "某人喜欢爵士乐",
      evidenceMessageIds: ["m1"],
      confidence: 0.4,
      attributionStatus: "unresolved",
      targetCandidateId: null,
    }],
  }, context);
  assert.equal(candidate.subjectId, null);
  assert.throws(
    () => validateMemoryOutput({
      candidates: [{
        operation: "create",
        subjectId: "A",
        sourceSpeakerId: "A",
        claim: "猜测她是 A",
        evidenceMessageIds: ["m1"],
        confidence: 0.4,
        attributionStatus: "unresolved",
        targetCandidateId: null,
      }],
    }, context),
    (error) => error.code === "invalid_attribution",
  );
});

test("memory prompt sends structured identity-bearing context, never identity-free transcript", () => {
  const request = cognitionRequest("memory_consolidation", contextFixture());
  const body = JSON.parse(request.messages[1].content);
  assert.equal(request.profile, "primary");
  assert.equal(body.messages[0].sender_id, "A");
  assert.equal(body.messages[1].sender_id, "B");
  assert.match(request.messages[0].content, /sourceSpeakerId/);
  assert.match(request.messages[0].content, /subjectId/);
});

test("thought structured output reserves enough budget for compatible reasoning models", () => {
  assert.equal(cognitionRequest("thought_tick", contextFixture()).maxOutputTokens, 2_048);
});

test("the same message window keeps stable output idempotency despite model drift", () => {
  const first = outputIdempotencyKey("thought_tick", "group:1", "m3");
  const retried = outputIdempotencyKey("thought_tick", "group:1", "m3");
  const nextCandidate = outputIdempotencyKey("memory_consolidation", "group:1", "m3", 1);
  assert.equal(first, retried);
  assert.notEqual(
    outputIdempotencyKey("memory_consolidation", "group:1", "m3", 0),
    nextCandidate,
  );
});
