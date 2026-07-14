export type SearchableMemory = {
  id: string;
  title: string;
  content: string;
  memoryType: string;
  importance: number;
  confidence: number;
};

export type RankedMemory<T extends SearchableMemory = SearchableMemory> = T & {
  score: number;
};

export type MemoryCandidate = {
  memoryType: "preference" | "goal" | "profile" | "prospective";
  title: string;
  content: string;
  confidence: number;
  importance: number;
};

function cjkBigrams(value: string) {
  const compact = value.replace(/[^\u3400-\u9fff]/g, "");
  const grams: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    grams.push(compact.slice(index, index + 2));
  }
  return grams;
}

export function tokenize(value: string) {
  const stopTokens = new Set([
    "用户",
    "我们",
    "你们",
    "我的",
    "你的",
    "这个",
    "那个",
    "什么",
    "怎么",
    "是否",
    "还是",
    "一个",
    "具体",
    "目前",
  ]);
  const latin = value
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const cjk = value.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  return new Set(
    [...latin, ...cjk, ...cjkBigrams(value)].filter(
      (token) => !stopTokens.has(token),
    ),
  );
}

export function rankMemories<T extends SearchableMemory>(
  query: string,
  memories: T[],
): RankedMemory<T>[] {
  const queryTokens = tokenize(query);
  return memories
    .map((memory) => {
      const memoryTokens = tokenize(`${memory.title} ${memory.content}`);
      let overlap = 0;
      queryTokens.forEach((token) => {
        if (memoryTokens.has(token)) overlap += token.length > 2 ? 1.5 : 1;
      });
      const phraseBoost = query.includes(memory.title) ? 2 : 0;
      const relevance = overlap + phraseBoost;
      if (relevance < 1) return null;
      const score =
        relevance + memory.importance * 0.12 + memory.confidence * 0.08;
      return { ...memory, score: Number(score.toFixed(3)) };
    })
    .filter((memory): memory is RankedMemory<T> => memory !== null)
    .sort((left, right) => right.score - left.score);
}

function cleanCaptured(value: string) {
  return value
    .replace(/[。！？!?][\s\S]*$/, "")
    .replace(/^(一下|一点|关于)/, "")
    .trim()
    .slice(0, 120);
}

export function extractMemoryCandidates(message: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const rules: Array<{
    pattern: RegExp;
    type: MemoryCandidate["memoryType"];
    title: string;
    confidence: number;
    importance: number;
    prefix?: string;
  }> = [
    {
      pattern: /我(?:很|最|比较)?喜欢[：:，, ]*([^。！？!?]{2,80})/,
      type: "preference",
      title: "用户偏好",
      confidence: 0.84,
      importance: 0.68,
      prefix: "用户喜欢",
    },
    {
      pattern: /我(?:不|不太|并不)喜欢[：:，, ]*([^。！？!?]{2,80})/,
      type: "preference",
      title: "用户负向偏好",
      confidence: 0.86,
      importance: 0.7,
      prefix: "用户不喜欢",
    },
    {
      pattern: /(?:我正在|我在做|我计划|我的目标是|我想要?)[：:，, ]*([^。！？!?]{3,100})/,
      type: "goal",
      title: "用户目标",
      confidence: 0.78,
      importance: 0.76,
    },
    {
      pattern: /(?:请)?记住[：:，, ]*([^。！？!?]{2,100})/,
      type: "profile",
      title: "用户明确要求记住",
      confidence: 0.95,
      importance: 0.82,
    },
    {
      pattern: /(?:以后|下次|到时候)[：:，, ]*([^。！？!?]{3,100})/,
      type: "prospective",
      title: "未来触发条件",
      confidence: 0.72,
      importance: 0.72,
    },
  ];

  for (const rule of rules) {
    const matched = message.match(rule.pattern);
    if (!matched?.[1]) continue;
    const captured = cleanCaptured(matched[1]);
    if (captured.length < 2) continue;
    candidates.push({
      memoryType: rule.type,
      title: rule.title,
      content: rule.prefix ? `${rule.prefix}${captured}` : captured,
      confidence: rule.confidence,
      importance: rule.importance,
    });
  }

  return candidates.filter(
    (candidate, index, list) =>
      list.findIndex((item) => item.content === candidate.content) === index,
  );
}

export function createShadowThought(
  message: string,
  candidates: MemoryCandidate[],
  retrieved: RankedMemory[],
) {
  if (candidates.length > 0) {
    return {
      kind: "memory_review",
      content: `刚刚识别出“${candidates[0].title}”，是否应在确认后纳入长期记忆？`,
      confidence: 0.8,
      novelty: 0.78,
      urgency: 0.34,
      expectedValue: 0.72,
      risk: 0.12,
    };
  }

  if (/评测|benchmark|测试/i.test(message)) {
    return {
      kind: "suggestion",
      content: "可以主动建议运行一次记忆回归评测，但当前处于 Shadow Mode。",
      confidence: 0.82,
      novelty: 0.62,
      urgency: 0.42,
      expectedValue: 0.76,
      risk: 0.08,
    };
  }

  if (retrieved.length > 0) {
    return {
      kind: "follow_up",
      content: `是否需要基于“${retrieved[0].title}”继续追问，补全上下文？`,
      confidence: 0.7,
      novelty: 0.55,
      urgency: 0.25,
      expectedValue: 0.58,
      risk: 0.1,
    };
  }

  return {
    kind: "follow_up",
    content: "当前信息不足以形成高价值主动消息，建议保持静默。",
    confidence: 0.76,
    novelty: 0.3,
    urgency: 0.12,
    expectedValue: 0.26,
    risk: 0.08,
  };
}

export function generateMvpReply(
  message: string,
  retrieved: RankedMemory[],
  candidateCount: number,
) {
  const memoryNote = retrieved.length
    ? `我同时召回了与“${retrieved[0].title}”有关的记忆，并保留了原始依据。`
    : "这次没有强行召回低相关记忆。";
  const candidateNote = candidateCount
    ? `另外生成了 ${candidateCount} 条记忆候选，等待你在记忆页确认后才会成为长期事实。`
    : "本轮没有发现需要写入长期记忆的新事实。";

  if (/评测|benchmark|测试/i.test(message)) {
    return `可以。第一阶段会把召回、拒答和候选写入都记录成可复现样本。${memoryNote}${candidateNote}`;
  }
  if (/记忆|回忆|remember/i.test(message)) {
    return `我会先检索有效记忆，再引用对应事件，而不是把自己的推断当成事实。${memoryNote}${candidateNote}`;
  }
  if (/主动|发言|独白|思绪/i.test(message)) {
    return `本轮已经生成一条内部思绪，但 Shadow Mode 会阻止它主动发出。你可以在“思绪”页标注它应该发送、延后还是静默。${memoryNote}`;
  }

  return `收到。这个 MVP 会把本轮对话依次写入事件日志、执行记忆检索、生成候选思绪，再由策略层决定是否表达。${memoryNote}${candidateNote}`;
}
