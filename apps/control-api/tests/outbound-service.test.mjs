import assert from "node:assert/strict";
import test from "node:test";

import {
  createOutboundService,
  OutboundRequestError,
  validateOutboundPolicy,
  validateSpeechFeedback,
} from "../src/outbound-service.mjs";

const policy = {
  enabled: false,
  mode: "shadow",
  timezone: "Asia/Shanghai",
  quietStartMinute: 0,
  quietEndMinute: 0,
  dailyBudget: 10,
  cooldownSeconds: 300,
  duplicateWindowSeconds: 86_400,
  freshnessSeconds: 1_800,
};

test("outbound policy accepts safe operator-controlled bounds", () => {
  assert.deepEqual(validateOutboundPolicy(policy), policy);
  assert.throws(
    () => validateOutboundPolicy({ ...policy, mode: "automatic" }),
    (error) => error instanceof OutboundRequestError && error.code === "outbound_policy_invalid",
  );
  assert.throws(() => validateOutboundPolicy({ ...policy, freshnessSeconds: 10 }));
});

test("feedback is training data only and has a bounded note", () => {
  assert.deepEqual(validateSpeechFeedback({ label: "defer", note: "时机不对" }), {
    label: "defer",
    note: "时机不对",
  });
  assert.throws(() => validateSpeechFeedback({ label: "send", note: "x".repeat(501) }));
});

test("service updates policy and feedback through the repository", async () => {
  const calls = [];
  const service = createOutboundService({
    repository: {
      getPolicy: async () => policy,
      listDecisions: async () => [{ id: "decision-1" }],
      savePolicy: async (agentId, input) => {
        calls.push(["policy", agentId, input]);
        return input;
      },
      saveFeedback: async (agentId, decisionId, input) => {
        calls.push(["feedback", agentId, decisionId, input]);
        return { id: decisionId, ...input };
      },
    },
  });
  assert.equal((await service.snapshot()).decisions.length, 1);
  assert.equal((await service.savePolicy(policy)).mode, "shadow");
  assert.equal((await service.saveFeedback("decision-1", { label: "silent" })).label, "silent");
  assert.equal(calls.length, 2);
});
