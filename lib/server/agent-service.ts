import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ensureSchema } from "@/db/runtime";
import {
  agentSettings,
  agents,
  conversations,
  evaluationCases,
  evaluationResults,
  evaluationRuns,
  events,
  memories,
  memoryEvidence,
  messages,
  thoughts,
} from "@/db/schema";
import {
  createShadowThought,
  extractMemoryCandidates,
  generateMvpReply,
  rankMemories,
} from "@/lib/agent-core";

const AGENT_ID = "agent-asuka";
const CONVERSATION_ID = "conversation-main";
const SUITE_ID = "phase1-memory-smoke";

function nowIso() {
  return new Date().toISOString();
}

function addHours(value: string, hours: number) {
  const date = new Date(value);
  date.setHours(date.getHours() + hours);
  return date.toISOString();
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function ensureSeedData() {
  const db = await ensureSchema();
  const now = nowIso();
  const correlationId = "seed-phase1";

  await db.insert(agents).values({
    id: AGENT_ID,
    name: "Asuka Agent",
    description: "一个可追溯、可评测的长期聊天 Agent MVP",
    mode: "shadow",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  await db.insert(conversations).values({
    id: CONVERSATION_ID,
    agentId: AGENT_ID,
    channel: "web",
    title: "长期记忆系统",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
  await db.insert(agentSettings).values({
    agentId: AGENT_ID,
    shadowMode: true,
    quietHoursStart: "23:00",
    quietHoursEnd: "08:00",
    dailyProactiveBudget: 3,
    modelMode: "deterministic_mvp",
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(messages).values([
    {
      id: "message-seed-user",
      conversationId: CONVERSATION_ID,
      role: "user",
      content:
        "我们先从一个能验证记忆与主动性的 MVP 开始。我偏好可视化网页看板，不喜欢所有操作都依赖纯命令行。",
      citationsJson: "[]",
      correlationId,
      createdAt: now,
    },
    {
      id: "message-seed-agent",
      conversationId: CONVERSATION_ID,
      role: "assistant",
      content:
        "第一阶段已经启用事件日志、分层记忆候选和 Shadow 思绪。所有自动写入与主动发言判断都会留下可审查记录。",
      citationsJson: JSON.stringify(["memory-project", "memory-interface"]),
      correlationId,
      createdAt: addHours(now, 0.001),
    },
  ]).onConflictDoNothing();

  await db.insert(events).values([
    {
      id: "event-seed-message",
      conversationId: CONVERSATION_ID,
      eventType: "message_received",
      sourceType: "user",
      payloadJson: JSON.stringify({ messageId: "message-seed-user" }),
      correlationId,
      createdAt: now,
    },
    {
      id: "event-seed-retrieval",
      conversationId: CONVERSATION_ID,
      eventType: "memory_retrieved",
      sourceType: "system",
      payloadJson: JSON.stringify({
        memoryIds: ["memory-project", "memory-interface"],
        reason: "seed demonstration",
      }),
      correlationId,
      createdAt: addHours(now, 0.0005),
    },
  ]).onConflictDoNothing();

  await db.insert(memories).values([
    {
      id: "memory-project",
      agentId: AGENT_ID,
      memoryType: "goal",
      title: "项目方向",
      content:
        "用户正在规划一个强调持续认知、自主行动和长期记忆的聊天 Agent 系统。",
      status: "active",
      sourceType: "user_asserted",
      confidence: 0.96,
      importance: 0.92,
      accessScope: "private",
      sensitivity: "normal",
      validFrom: now,
      recordedAt: now,
      retrieveCount: 1,
      helpfulUseCount: 1,
      lastRetrievedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "memory-interface",
      agentId: AGENT_ID,
      memoryType: "preference",
      title: "界面偏好",
      content: "用户偏好可视化网页看板，不喜欢所有操作都依赖纯命令行。",
      status: "active",
      sourceType: "user_asserted",
      confidence: 0.93,
      importance: 0.78,
      accessScope: "private",
      sensitivity: "normal",
      validFrom: now,
      recordedAt: now,
      retrieveCount: 1,
      helpfulUseCount: 1,
      lastRetrievedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]).onConflictDoNothing();

  await db.insert(memoryEvidence).values([
    {
      memoryId: "memory-project",
      eventId: "event-seed-message",
      evidenceRole: "supports",
    },
    {
      memoryId: "memory-interface",
      eventId: "event-seed-message",
      evidenceRole: "supports",
    },
  ]).onConflictDoNothing();

  await db.insert(thoughts).values({
    id: "thought-seed",
    conversationId: CONVERSATION_ID,
    kind: "suggestion",
    content: "是否需要主动补充第一阶段的评测方案？",
    evidenceJson: JSON.stringify(["event-seed-message"]),
    confidence: 0.78,
    novelty: 0.62,
    urgency: 0.28,
    expectedValue: 0.7,
    risk: 0.08,
    decision: "shadow",
    expiresAt: addHours(now, 12),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(evaluationCases).values([
    {
      id: "case-interface-recall",
      suite: SUITE_ID,
      category: "single_fact_recall",
      prompt: "用户更喜欢可视化网页看板还是所有操作都使用纯命令行？",
      expectedJson: JSON.stringify({ expectedMemoryId: "memory-interface" }),
      tagsJson: JSON.stringify(["preference", "retrieval"]),
      createdAt: now,
    },
    {
      id: "case-project-recall",
      suite: SUITE_ID,
      category: "goal_recall",
      prompt: "用户正在规划什么类型的 Agent 系统？",
      expectedJson: JSON.stringify({ expectedMemoryId: "memory-project" }),
      tagsJson: JSON.stringify(["goal", "retrieval"]),
      createdAt: now,
    },
    {
      id: "case-abstention",
      suite: SUITE_ID,
      category: "abstention",
      prompt: "用户的生日具体是哪一天？",
      expectedJson: JSON.stringify({ abstain: true }),
      tagsJson: JSON.stringify(["unknown", "abstention"]),
      createdAt: now,
    },
  ]).onConflictDoNothing();

  return db;
}

export async function getSnapshot() {
  const db = await ensureSeedData();
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.id, AGENT_ID))
    .limit(1);
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, CONVERSATION_ID))
    .limit(1);
  const [settings] = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.agentId, AGENT_ID))
    .limit(1);
  const messageRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, CONVERSATION_ID))
    .orderBy(asc(messages.createdAt))
    .limit(80);
  const memoryRows = await db
    .select()
    .from(memories)
    .where(eq(memories.agentId, AGENT_ID))
    .orderBy(desc(memories.updatedAt))
    .limit(100);
  const thoughtRows = await db
    .select()
    .from(thoughts)
    .where(eq(thoughts.conversationId, CONVERSATION_ID))
    .orderBy(desc(thoughts.createdAt))
    .limit(60);
  const eventRows = await db
    .select()
    .from(events)
    .where(eq(events.conversationId, CONVERSATION_ID))
    .orderBy(desc(events.createdAt))
    .limit(30);
  const cases = await db
    .select()
    .from(evaluationCases)
    .where(eq(evaluationCases.suite, SUITE_ID))
    .orderBy(asc(evaluationCases.id));
  const [latestRun] = await db
    .select()
    .from(evaluationRuns)
    .where(eq(evaluationRuns.suite, SUITE_ID))
    .orderBy(desc(evaluationRuns.startedAt))
    .limit(1);
  const resultRows = latestRun
    ? await db
        .select()
        .from(evaluationResults)
        .where(eq(evaluationResults.runId, latestRun.id))
        .orderBy(asc(evaluationResults.caseId))
    : [];

  const parsedMessages = messageRows.map((row) => ({
    ...row,
    citations: safeJson<string[]>(row.citationsJson, []),
  }));
  const parsedThoughts = thoughtRows.map((row) => ({
    ...row,
    evidenceIds: safeJson<string[]>(row.evidenceJson, []),
  }));
  const parsedEvents = eventRows.map((row) => ({
    ...row,
    payload: safeJson<Record<string, unknown>>(row.payloadJson, {}),
  }));
  const parsedCases = cases.map((row) => ({
    ...row,
    expected: safeJson<Record<string, unknown>>(row.expectedJson, {}),
    tags: safeJson<string[]>(row.tagsJson, []),
  }));
  const parsedRun = latestRun
    ? {
        ...latestRun,
        summary: safeJson<Record<string, number>>(latestRun.summaryJson, {}),
        results: resultRows.map((row) => ({
          ...row,
          predicted: safeJson<Record<string, unknown>>(
            row.predictedJson,
            {},
          ),
          metrics: safeJson<Record<string, number>>(row.metricsJson, {}),
        })),
      }
    : null;

  const labeledThoughts = thoughtRows.filter((row) => row.humanLabel).length;
  const latestSummary = parsedRun?.summary ?? {};

  return {
    agent,
    conversation,
    settings,
    messages: parsedMessages,
    memories: memoryRows,
    thoughts: parsedThoughts,
    events: parsedEvents,
    evaluation: {
      suite: SUITE_ID,
      cases: parsedCases,
      latestRun: parsedRun,
    },
    metrics: {
      activeMemories: memoryRows.filter((row) => row.status === "active").length,
      candidateMemories: memoryRows.filter((row) => row.status === "candidate")
        .length,
      labeledThoughts,
      totalThoughts: thoughtRows.length,
      evaluationAccuracy: latestSummary.accuracy ?? null,
      eventCount: eventRows.length,
    },
  };
}

export async function sendMessage(content: string) {
  const db = await ensureSeedData();
  const trimmed = content.trim();
  if (!trimmed) throw new Error("消息不能为空");
  if (trimmed.length > 4000) throw new Error("消息不能超过 4000 个字符");

  const createdAt = nowIso();
  const correlationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const userEventId = crypto.randomUUID();

  await db.insert(messages).values({
    id: userMessageId,
    conversationId: CONVERSATION_ID,
    role: "user",
    content: trimmed,
    citationsJson: "[]",
    correlationId,
    createdAt,
  });
  await db.insert(events).values({
    id: userEventId,
    conversationId: CONVERSATION_ID,
    eventType: "message_received",
    sourceType: "user",
    payloadJson: JSON.stringify({ messageId: userMessageId, content: trimmed }),
    correlationId,
    createdAt,
  });

  const activeMemories = await db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, AGENT_ID), eq(memories.status, "active")))
    .limit(200);
  const ranked = rankMemories(trimmed, activeMemories).slice(0, 3);

  if (ranked.length > 0) {
    const retrievalTime = nowIso();
    for (const memory of ranked) {
      await db
        .update(memories)
        .set({
          retrieveCount: sql`${memories.retrieveCount} + 1`,
          lastRetrievedAt: retrievalTime,
          updatedAt: retrievalTime,
        })
        .where(eq(memories.id, memory.id));
    }
    await db.insert(events).values({
      id: crypto.randomUUID(),
      conversationId: CONVERSATION_ID,
      eventType: "memory_retrieved",
      sourceType: "system",
      payloadJson: JSON.stringify({
        memoryIds: ranked.map((memory) => memory.id),
        scores: ranked.map((memory) => memory.score),
      }),
      correlationId,
      createdAt: retrievalTime,
    });
  }

  const candidateRows = extractMemoryCandidates(trimmed);
  for (const candidate of candidateRows) {
    const memoryId = crypto.randomUUID();
    const timestamp = nowIso();
    await db.insert(memories).values({
      id: memoryId,
      agentId: AGENT_ID,
      memoryType: candidate.memoryType,
      title: candidate.title,
      content: candidate.content,
      status: "candidate",
      sourceType: "user_asserted",
      confidence: candidate.confidence,
      importance: candidate.importance,
      accessScope: "private",
      sensitivity: "normal",
      validFrom: timestamp,
      recordedAt: timestamp,
      retrieveCount: 0,
      helpfulUseCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db.insert(memoryEvidence).values({
      memoryId,
      eventId: userEventId,
      evidenceRole: "supports",
    });
    await db.insert(events).values({
      id: crypto.randomUUID(),
      conversationId: CONVERSATION_ID,
      eventType: "memory_candidate_created",
      sourceType: "system",
      payloadJson: JSON.stringify({ memoryId, candidate }),
      correlationId,
      createdAt: timestamp,
    });
  }

  const thought = createShadowThought(trimmed, candidateRows, ranked);
  const thoughtId = crypto.randomUUID();
  const thoughtTime = nowIso();
  await db.insert(thoughts).values({
    id: thoughtId,
    conversationId: CONVERSATION_ID,
    kind: thought.kind,
    content: thought.content,
    evidenceJson: JSON.stringify([
      userEventId,
      ...ranked.map((memory) => memory.id),
    ]),
    confidence: thought.confidence,
    novelty: thought.novelty,
    urgency: thought.urgency,
    expectedValue: thought.expectedValue,
    risk: thought.risk,
    decision: "shadow",
    expiresAt: addHours(thoughtTime, 12),
    createdAt: thoughtTime,
    updatedAt: thoughtTime,
  });
  await db.insert(events).values({
    id: crypto.randomUUID(),
    conversationId: CONVERSATION_ID,
    eventType: "shadow_thought_created",
    sourceType: "system",
    payloadJson: JSON.stringify({ thoughtId, decision: "shadow" }),
    correlationId,
    createdAt: thoughtTime,
  });

  const reply = generateMvpReply(trimmed, ranked, candidateRows.length);
  const assistantMessageId = crypto.randomUUID();
  const replyTime = nowIso();
  await db.insert(messages).values({
    id: assistantMessageId,
    conversationId: CONVERSATION_ID,
    role: "assistant",
    content: reply,
    citationsJson: JSON.stringify(ranked.map((memory) => memory.id)),
    correlationId,
    createdAt: replyTime,
  });
  await db.insert(events).values({
    id: crypto.randomUUID(),
    conversationId: CONVERSATION_ID,
    eventType: "agent_replied",
    sourceType: "agent",
    payloadJson: JSON.stringify({
      messageId: assistantMessageId,
      citedMemoryIds: ranked.map((memory) => memory.id),
    }),
    correlationId,
    createdAt: replyTime,
  });
  await db
    .update(conversations)
    .set({ updatedAt: replyTime })
    .where(eq(conversations.id, CONVERSATION_ID));

  return getSnapshot();
}

export async function reviewMemory(
  id: string,
  action: "accept" | "reject" | "archive",
) {
  const db = await ensureSeedData();
  const status =
    action === "accept" ? "active" : action === "reject" ? "rejected" : "archived";
  const timestamp = nowIso();
  const updated = await db
    .update(memories)
    .set({ status, updatedAt: timestamp })
    .where(eq(memories.id, id))
    .returning();
  if (updated.length === 0) throw new Error("没有找到这条记忆");
  await db.insert(events).values({
    id: crypto.randomUUID(),
    conversationId: CONVERSATION_ID,
    eventType: "memory_reviewed",
    sourceType: "user",
    payloadJson: JSON.stringify({ memoryId: id, action, status }),
    correlationId: crypto.randomUUID(),
    createdAt: timestamp,
  });
  return getSnapshot();
}

export async function labelThought(
  id: string,
  label: "send_now" | "defer" | "silent",
) {
  const db = await ensureSeedData();
  const timestamp = nowIso();
  const updated = await db
    .update(thoughts)
    .set({ humanLabel: label, updatedAt: timestamp })
    .where(eq(thoughts.id, id))
    .returning();
  if (updated.length === 0) throw new Error("没有找到这条思绪");
  await db.insert(events).values({
    id: crypto.randomUUID(),
    conversationId: CONVERSATION_ID,
    eventType: "thought_labeled",
    sourceType: "user",
    payloadJson: JSON.stringify({ thoughtId: id, label }),
    correlationId: crypto.randomUUID(),
    createdAt: timestamp,
  });
  return getSnapshot();
}

export async function updateSettings(input: {
  shadowMode?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  dailyProactiveBudget?: number;
}) {
  const db = await ensureSeedData();
  const [current] = await db
    .select()
    .from(agentSettings)
    .where(eq(agentSettings.agentId, AGENT_ID))
    .limit(1);
  const timestamp = nowIso();
  await db
    .update(agentSettings)
    .set({
      shadowMode: input.shadowMode ?? current.shadowMode,
      quietHoursStart: input.quietHoursStart ?? current.quietHoursStart,
      quietHoursEnd: input.quietHoursEnd ?? current.quietHoursEnd,
      dailyProactiveBudget:
        input.dailyProactiveBudget ?? current.dailyProactiveBudget,
      updatedAt: timestamp,
    })
    .where(eq(agentSettings.agentId, AGENT_ID));
  await db
    .update(agents)
    .set({
      mode: (input.shadowMode ?? current.shadowMode) ? "shadow" : "review",
      updatedAt: timestamp,
    })
    .where(eq(agents.id, AGENT_ID));
  return getSnapshot();
}

export async function runEvaluationSuite() {
  const db = await ensureSeedData();
  const cases = await db
    .select()
    .from(evaluationCases)
    .where(eq(evaluationCases.suite, SUITE_ID))
    .orderBy(asc(evaluationCases.id));
  const activeMemories = await db
    .select()
    .from(memories)
    .where(and(eq(memories.agentId, AGENT_ID), eq(memories.status, "active")))
    .limit(200);
  const runId = crypto.randomUUID();
  const startedAt = nowIso();
  await db.insert(evaluationRuns).values({
    id: runId,
    suite: SUITE_ID,
    status: "running",
    summaryJson: "{}",
    startedAt,
  });

  let passedCount = 0;
  for (const testCase of cases) {
    const expected = safeJson<{
      expectedMemoryId?: string;
      abstain?: boolean;
    }>(testCase.expectedJson, {});
    const ranked = rankMemories(testCase.prompt, activeMemories).slice(0, 3);
    const topScore = ranked[0]?.score ?? 0;
    const passed = expected.abstain
      ? topScore < 1.25
      : Boolean(
          expected.expectedMemoryId &&
            ranked.some((memory) => memory.id === expected.expectedMemoryId),
        );
    if (passed) passedCount += 1;
    await db.insert(evaluationResults).values({
      id: crypto.randomUUID(),
      runId,
      caseId: testCase.id,
      predictedJson: JSON.stringify({
        memoryIds: ranked.map((memory) => memory.id),
        scores: ranked.map((memory) => memory.score),
        abstained: ranked.length === 0 || topScore < 1.25,
      }),
      metricsJson: JSON.stringify({ topScore, hitAt3: passed ? 1 : 0 }),
      score: passed ? 1 : 0,
      passed,
      createdAt: nowIso(),
    });
  }

  const accuracy = cases.length ? passedCount / cases.length : 0;
  const completedAt = nowIso();
  await db
    .update(evaluationRuns)
    .set({
      status: "completed",
      summaryJson: JSON.stringify({
        total: cases.length,
        passed: passedCount,
        accuracy,
      }),
      completedAt,
    })
    .where(eq(evaluationRuns.id, runId));
  await db.insert(events).values({
    id: crypto.randomUUID(),
    conversationId: CONVERSATION_ID,
    eventType: "evaluation_completed",
    sourceType: "system",
    payloadJson: JSON.stringify({ runId, passedCount, total: cases.length }),
    correlationId: runId,
    createdAt: completedAt,
  });
  return getSnapshot();
}

export async function resetDemo() {
  const db = await ensureSchema();
  await db.delete(evaluationResults);
  await db.delete(evaluationRuns);
  await db.delete(evaluationCases);
  await db.delete(thoughts);
  await db.delete(memoryEvidence);
  await db.delete(memories);
  await db.delete(events);
  await db.delete(messages);
  await db.delete(agentSettings);
  await db.delete(conversations);
  await db.delete(agents);
  return getSnapshot();
}

export async function getMemoriesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  const db = await ensureSeedData();
  return db.select().from(memories).where(inArray(memories.id, ids));
}
