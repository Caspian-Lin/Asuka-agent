import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMemoryProposal,
  defaultDisclosurePolicy,
  enforceMemorySensitivity,
} from "../src/memory-proposal.mjs";

function proposal(overrides = {}) {
  return buildMemoryProposal({
    operation: "create",
    memoryType: "preference",
    subjectId: "user-a",
    sourceSpeakerId: "user-a",
    sourceConversationId: "private:a",
    thoughtRunId: "thought-a",
    claim: "user-a 喜欢爵士乐",
    evidenceMessageIds: ["message-a"],
    confidenceMillis: 900,
    attributionStatus: "resolved",
    sensitivity: "normal",
    promptVersion: "memory-v2",
    ...overrides,
  });
}

test("health facts are deterministically upgraded to restricted private disclosure", () => {
  assert.equal(enforceMemorySensitivity("小林对花生过敏", "normal"), "restricted");
  assert.deepEqual(defaultDisclosurePolicy("restricted"), {
    scope: "private",
    conversationIds: [],
    participantIds: [],
  });
  const result = proposal({ claim: "user-a 对花生过敏" });
  assert.equal(result.sensitivity, "restricted");
  assert.equal(result.disclosurePolicy.scope, "private");
});

test("unresolved subjects stay unresolved and cannot update another proposal", () => {
  const unresolved = proposal({
    subjectId: null,
    attributionStatus: "unresolved",
    sourceConversationId: "group:1",
    claim: "某人喜欢爵士乐",
  });
  assert.equal(unresolved.subjectId, null);
  assert.throws(
    () => proposal({
      operation: "update",
      subjectId: null,
      attributionStatus: "unresolved",
      targetCandidateId: "memory-a",
      existingCandidates: [{ id: "memory-a", subjectId: "user-a", claim: "旧事实" }],
    }),
    (error) => error.code === "memory_attribution_invalid",
  );
});

test("same subject proposals from different conversations can produce an auditable diff", () => {
  const existing = {
    id: "memory-a",
    conversationId: "group:first",
    subjectId: "user-a",
    claim: "user-a 喜欢爵士乐",
    memoryType: "preference",
    sensitivity: "normal",
    disclosurePolicy: {
      scope: "subject",
      conversationIds: [],
      participantIds: [],
    },
    validFrom: null,
    validTo: null,
  };
  const result = proposal({
    operation: "update",
    sourceConversationId: "private:second",
    claim: "user-a 现在更喜欢古典乐",
    targetCandidateId: existing.id,
    existingCandidates: [existing],
  });
  assert.equal(result.targetCandidateId, existing.id);
  assert.equal(result.diff.before.claim, "user-a 喜欢爵士乐");
  assert.equal(result.diff.after.claim, "user-a 现在更喜欢古典乐");
  assert.ok(result.diff.changedFields.includes("claim"));
  assert.equal(existing.claim, "user-a 喜欢爵士乐");
});

test("opposing facts for different subjects cannot be merged or marked as conflict", () => {
  assert.throws(
    () => proposal({
      operation: "conflict",
      subjectId: "user-b",
      sourceSpeakerId: "user-b",
      sourceConversationId: "group:second",
      claim: "user-b 不喜欢爵士乐",
      targetCandidateId: "memory-a",
      existingCandidates: [{
        id: "memory-a",
        subjectId: "user-a",
        claim: "user-a 喜欢爵士乐",
      }],
    }),
    (error) => error.code === "memory_subject_mismatch",
  );
});

test("validity windows must be ordered and are preserved in proposal diffs", () => {
  const result = proposal({
    validFrom: "2026-07-01T00:00:00Z",
    validTo: "2026-08-01T00:00:00Z",
  });
  assert.equal(result.diff.after.validFrom, "2026-07-01T00:00:00.000Z");
  assert.throws(
    () => proposal({
      validFrom: "2026-08-01T00:00:00Z",
      validTo: "2026-07-01T00:00:00Z",
    }),
    (error) => error.code === "memory_validity_invalid",
  );
});
