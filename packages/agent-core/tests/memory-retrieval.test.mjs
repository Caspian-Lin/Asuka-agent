import assert from "node:assert/strict";
import test from "node:test";

import {
  createGlobalMemoryRetrievalPort,
  retrieveGlobalMemories,
} from "../src/memory-retrieval.mjs";

function memory(overrides = {}) {
  return {
    id: "memory-a",
    agentId: "agent-asuka",
    status: "active",
    attributionStatus: "resolved",
    subjectId: "user-a",
    sourceSpeakerId: "user-a",
    sourceConversationId: "private:old",
    thoughtRunId: "thought-old",
    claim: "user-a 喜欢爵士乐",
    evidenceMessageIds: ["message-old"],
    sensitivity: "normal",
    disclosurePolicy: {
      scope: "subject",
      conversationIds: [],
      participantIds: [],
    },
    validFrom: null,
    validTo: null,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    agentId: "agent-asuka",
    conversationId: "group:new",
    conversationType: "group",
    participantIds: ["user-a", "user-b"],
    permissions: ["memory:normal:read"],
    ...overrides,
  };
}

test("retrieval is Agent-global and can return a subject fact from another conversation", () => {
  const result = retrieveGlobalMemories({
    query: "还记得 user-a 喜欢什么爵士乐吗",
    memories: [memory()],
    request: request(),
  });
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].sourceConversationId, "private:old");
  assert.equal(result.memories[0].thoughtRunId, "thought-old");
  assert.deepEqual(result.memories[0].evidenceIds, ["message-old"]);
});

test("restricted health memory is denied to a group unless explicitly allowlisted", () => {
  const restricted = memory({
    claim: "user-a 对花生过敏",
    sensitivity: "restricted",
    disclosurePolicy: {
      scope: "private",
      conversationIds: [],
      participantIds: [],
    },
  });
  const denied = retrieveGlobalMemories({
    query: "user-a 花生过敏",
    memories: [restricted],
    request: request({ permissions: ["memory:normal:read", "memory:restricted:read"] }),
  });
  assert.deepEqual(denied.memories, []);
  assert.equal(denied.audit.decisions[0].reason, "private_only");

  const allowed = retrieveGlobalMemories({
    query: "user-a 花生过敏",
    memories: [memory({
      ...restricted,
      disclosurePolicy: {
        scope: "allowlist",
        conversationIds: ["group:new"],
        participantIds: [],
      },
    })],
    request: request({ permissions: ["memory:normal:read", "memory:restricted:read"] }),
  });
  assert.equal(allowed.memories.length, 1);
});

test("subject and validity filters run before ranking", () => {
  const result = retrieveGlobalMemories({
    query: "爵士乐",
    memories: [
      memory({ id: "wrong-subject", subjectId: "user-c" }),
      memory({ id: "expired", validTo: "2026-07-01T00:00:00Z" }),
      memory({ id: "future", validFrom: "2026-08-01T00:00:00Z" }),
    ],
    request: request(),
    now: new Date("2026-07-17T00:00:00Z"),
  });
  assert.deepEqual(result.memories, []);
  assert.deepEqual(
    result.audit.decisions.map((decision) => decision.reason).sort(),
    ["expired", "not_yet_valid", "subject_absent"],
  );
});

test("irrelevant candidates produce an empty result instead of filling the limit", () => {
  const result = retrieveGlobalMemories({
    query: "周末露营天气",
    memories: [memory({ claim: "user-a 喜欢爵士乐" })],
    request: request(),
  });
  assert.deepEqual(result.memories, []);
  assert.equal(result.audit.returnedCount, 0);
  assert.equal(result.audit.decisions[0].reason, "no_lexical_match");
});

test("retrieval port records both empty results and policy decisions", async () => {
  const audits = [];
  const port = createGlobalMemoryRetrievalPort({
    loadActiveMemories: async () => [memory()],
    recordAudit: async (audit) => audits.push(audit),
    clock: () => new Date("2026-07-17T00:00:00Z"),
  });
  const result = await port.retrieve({
    requestId: "retrieval-1",
    thoughtRunId: "thought-new",
    mode: "tool",
    query: "完全无关的天气",
    request: request(),
    limit: 4,
  });
  assert.deepEqual(result.memories, []);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].returnedCount, 0);
  assert.equal(audits[0].thoughtRunId, "thought-new");
});
