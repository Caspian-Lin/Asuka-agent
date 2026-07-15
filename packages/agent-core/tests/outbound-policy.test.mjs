import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateSpeechPolicy,
  speechContentHash,
} from "../src/outbound-policy.mjs";

const now = new Date("2026-07-16T04:00:00Z");

function fixture(overrides = {}) {
  return {
    proposal: {
      type: "reply",
      conversationId: "group:1",
      targetConversationId: "group:1",
      draft: "大家周六方便吗？",
      evidenceReferences: [{ type: "message", id: "m1" }],
      createdAt: new Date(now.getTime() - 60_000),
    },
    agentMode: "active",
    policy: {
      enabled: true,
      timezone: "Asia/Shanghai",
      quietStartMinute: 0,
      quietEndMinute: 0,
      dailyBudget: 10,
      cooldownSeconds: 300,
      duplicateWindowSeconds: 86_400,
      freshnessSeconds: 1_800,
    },
    channelEnabled: true,
    allowlisted: true,
    now,
    sentToday: 0,
    lastSpokenAt: null,
    duplicateSeen: false,
    ...overrides,
  };
}

test("no_action is a successful silent decision", () => {
  assert.deepEqual(evaluateSpeechPolicy(fixture({
    proposal: { type: "no_action" },
  })), {
    outcome: "silent",
    reasonCode: "model_no_action",
    nextEvaluationAt: null,
  });
});

test("kill switch and allowlist fail closed", () => {
  assert.equal(evaluateSpeechPolicy(fixture({
    policy: { ...fixture().policy, enabled: false },
  })).reasonCode, "kill_switch");
  assert.equal(evaluateSpeechPolicy(fixture({ allowlisted: false })).outcome, "blocked");
});

test("target and evidence checks cannot be overridden by the model", () => {
  assert.equal(evaluateSpeechPolicy(fixture({
    proposal: { ...fixture().proposal, targetConversationId: "group:2" },
  })).reasonCode, "target_mismatch");
  assert.equal(evaluateSpeechPolicy(fixture({
    proposal: { ...fixture().proposal, evidenceReferences: [] },
  })).reasonCode, "evidence_missing");
  assert.equal(evaluateSpeechPolicy(fixture({ agentMode: "unknown" })).outcome, "blocked");
});

test("shadow and active modes split would-send from real send", () => {
  assert.equal(evaluateSpeechPolicy(fixture({ agentMode: "shadow" })).outcome, "shadow_speak");
  assert.equal(evaluateSpeechPolicy(fixture()).outcome, "speak");
});

test("quiet hours, daily budget, and cooldown defer with a next evaluation", () => {
  const quiet = evaluateSpeechPolicy(fixture({
    policy: {
      ...fixture().policy,
      quietStartMinute: 11 * 60,
      quietEndMinute: 13 * 60,
    },
  }));
  assert.equal(quiet.reasonCode, "quiet_hours");
  assert.ok(quiet.nextEvaluationAt > now);

  const budget = evaluateSpeechPolicy(fixture({ sentToday: 10 }));
  assert.equal(budget.reasonCode, "daily_budget");
  assert.ok(budget.nextEvaluationAt > now);

  const cooldown = evaluateSpeechPolicy(fixture({
    lastSpokenAt: new Date(now.getTime() - 60_000),
  }));
  assert.equal(cooldown.reasonCode, "channel_cooldown");
  assert.ok(cooldown.nextEvaluationAt > now);
});

test("stale and duplicate opportunities stay silent", () => {
  assert.equal(evaluateSpeechPolicy(fixture({
    proposal: { ...fixture().proposal, createdAt: new Date(now.getTime() - 3_600_000) },
  })).reasonCode, "opportunity_stale");
  assert.equal(evaluateSpeechPolicy(fixture({ duplicateSeen: true })).reasonCode, "duplicate_suppressed");
});

test("speech hashes normalize harmless whitespace and width drift", () => {
  assert.equal(speechContentHash("Ａ  B"), speechContentHash("a b"));
  assert.notEqual(speechContentHash("a b"), speechContentHash("a c"));
});
