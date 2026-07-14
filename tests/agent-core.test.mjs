import assert from "node:assert/strict";
import test from "node:test";

import {
  createShadowThought,
  extractMemoryCandidates,
  rankMemories,
  tokenize,
} from "../lib/agent-core.ts";

const memories = [
  {
    id: "memory-interface",
    title: "界面偏好",
    content: "用户偏好可视化网页看板，不喜欢所有操作都依赖纯命令行。",
    memoryType: "preference",
    importance: 0.78,
    confidence: 0.93,
  },
  {
    id: "memory-project",
    title: "项目方向",
    content: "用户正在规划强调持续认知、自主行动和长期记忆的聊天 Agent 系统。",
    memoryType: "goal",
    importance: 0.92,
    confidence: 0.96,
  },
];

test("tokenizer removes generic Chinese stop tokens", () => {
  const tokens = tokenize("用户具体喜欢什么界面？");
  assert.equal(tokens.has("用户"), false);
  assert.equal(tokens.has("界面"), true);
});

test("retrieval ranks a matching memory and rejects an unknown fact", () => {
  const interfaceResults = rankMemories(
    "用户更喜欢可视化网页看板还是纯命令行？",
    memories,
  );
  assert.equal(interfaceResults[0]?.id, "memory-interface");

  const projectResults = rankMemories("正在规划什么 Agent 系统？", memories);
  assert.equal(projectResults[0]?.id, "memory-project");

  assert.deepEqual(rankMemories("用户的生日具体是哪一天？", memories), []);
});

test("explicit preferences and goals become reviewable candidates", () => {
  const candidates = extractMemoryCandidates(
    "我不喜欢所有操作都在命令行。我正在做一个长期记忆聊天 Agent。",
  );
  assert.ok(candidates.some((candidate) => candidate.memoryType === "preference"));
  assert.ok(candidates.some((candidate) => candidate.memoryType === "goal"));
  assert.ok(candidates.every((candidate) => candidate.confidence > 0.7));
});

test("a memory candidate produces a bounded shadow review thought", () => {
  const candidates = extractMemoryCandidates("请记住：我偏好简洁的网页看板。 ");
  const thought = createShadowThought("请记住：我偏好简洁的网页看板。", candidates, []);
  assert.equal(thought.kind, "memory_review");
  assert.match(thought.content, /长期记忆/);
  assert.ok(thought.risk >= 0 && thought.risk <= 1);
});

