export type ThoughtRunListItem = {
  id: string;
  conversation_id: string;
  conversation_title: string;
  created_at: string;
};

export type ThoughtContextItem = {
  id: string;
  itemType: string;
  referenceId: string | null;
  title: string;
  content: string | null;
  metadata: Record<string, unknown>;
};

export type ThoughtContextSectionKey =
  | "available_tools"
  | "compression"
  | "history_messages"
  | "history_thoughts"
  | "recalled_memory"
  | "unread_messages"
  | "other";

export type ThoughtRunGroup<T extends ThoughtRunListItem = ThoughtRunListItem> = {
  conversationId: string;
  conversationTitle: string;
  latestAt: string;
  runs: T[];
};

export type SystemInstructionKind =
  | "agent_instruction"
  | "compiler_instruction"
  | "output_contract"
  | "system_instruction";

export type ThoughtCallStageInput = {
  purpose: string;
  status?: string;
  error_code?: string | null;
  response_json?: {
    content?: unknown;
    toolCalls?: unknown[];
  } | null;
};

export type ThoughtSystemInstructionCall = {
  purpose: string;
  request_context: Array<{
    role: string;
    content: string | null;
  }>;
};

export type ThoughtContextTurn = {
  thoughtRunId: string;
  turnOrdinal: number | null;
  messages: ThoughtContextItem[];
  thought: ThoughtContextItem | null;
};

export type ThoughtContextOutline = {
  tools: ThoughtContextItem[];
  compression: ThoughtContextItem[];
  initializationMessages: ThoughtContextItem[];
  previousTurns: ThoughtContextTurn[];
  unassignedHistoryMessages: ThoughtContextItem[];
  recalledMemories: ThoughtContextItem[];
  currentMessages: ThoughtContextItem[];
  other: ThoughtContextItem[];
};

export function groupThoughtRuns<T extends ThoughtRunListItem>(runs: T[]) {
  const groups = new Map<string, ThoughtRunGroup<T>>();
  for (const run of runs) {
    const current = groups.get(run.conversation_id);
    if (current) {
      current.runs.push(run);
      continue;
    }
    groups.set(run.conversation_id, {
      conversationId: run.conversation_id,
      conversationTitle: run.conversation_title,
      latestAt: run.created_at,
      runs: [run],
    });
  }
  return [...groups.values()];
}

export function contextSectionFor(item: ThoughtContextItem): ThoughtContextSectionKey {
  const section = String(item.metadata?.section ?? "");
  if (item.itemType === "tool_definition" || section === "tools") {
    return "available_tools";
  }
  if (item.itemType === "compression" || section === "compression") {
    return "compression";
  }
  if (section === "initialization_history") return "history_messages";
  if (section === "committed_turn") {
    return item.itemType === "thought_turn" ? "history_thoughts" : "history_messages";
  }
  if (item.itemType === "memory" || section === "recalled_memory") {
    return "recalled_memory";
  }
  if (section === "new_source") return "unread_messages";
  return "other";
}

export function collectUniqueContextItems(
  calls: Array<{ context_items: ThoughtContextItem[] }>,
) {
  const seen = new Set<string>();
  return calls.flatMap((call) => call.context_items).flatMap((item) => {
    const sourceSection = String(item.metadata?.section ?? "");
    if (item.itemType === "tool_result" || sourceSection === "compiler_manifest") return [];
    const key = [
      item.itemType,
      item.referenceId ?? "",
      sourceSection,
      item.content ?? "",
    ].join("\u0000");
    if (seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
}

const sectionOrder: ThoughtContextSectionKey[] = [
  "available_tools",
  "compression",
  "history_messages",
  "history_thoughts",
  "recalled_memory",
  "unread_messages",
  "other",
];

export function collectContextSections(calls: Array<{ context_items: ThoughtContextItem[] }>) {
  const sections = new Map<ThoughtContextSectionKey, ThoughtContextItem[]>();
  for (const item of collectUniqueContextItems(calls)) {
    const section = contextSectionFor(item);
    const values = sections.get(section) ?? [];
    values.push(item);
    sections.set(section, values);
  }
  return sectionOrder.flatMap((key) => {
    const items = sections.get(key) ?? [];
    return items.length ? [{ key, items }] : [];
  });
}

export function buildThoughtContextOutline(
  calls: Array<{ context_items: ThoughtContextItem[] }>,
): ThoughtContextOutline {
  const outline: ThoughtContextOutline = {
    tools: [],
    compression: [],
    initializationMessages: [],
    previousTurns: [],
    unassignedHistoryMessages: [],
    recalledMemories: [],
    currentMessages: [],
    other: [],
  };
  const turns = new Map<string, ThoughtContextTurn>();
  let pendingHistory: ThoughtContextItem[] = [];
  const ensureTurn = (runId: string, ordinal: number | null) => {
    const existing = turns.get(runId);
    if (existing) {
      if (existing.turnOrdinal == null && ordinal != null) existing.turnOrdinal = ordinal;
      return existing;
    }
    const turn: ThoughtContextTurn = {
      thoughtRunId: runId,
      turnOrdinal: ordinal,
      messages: [],
      thought: null,
    };
    turns.set(runId, turn);
    outline.previousTurns.push(turn);
    return turn;
  };

  for (const item of collectUniqueContextItems(calls)) {
    const section = String(item.metadata?.section ?? "");
    if (item.itemType === "tool_definition" || section === "tools") {
      outline.tools.push(item);
    } else if (item.itemType === "compression" || section === "compression") {
      outline.compression.push(item);
    } else if (section === "initialization_history") {
      outline.initializationMessages.push(item);
    } else if (section === "committed_turn" && item.itemType === "message") {
      const runId = typeof item.metadata?.thoughtRunId === "string"
        ? item.metadata.thoughtRunId
        : null;
      const ordinal = Number(item.metadata?.turnOrdinal);
      if (runId) {
        ensureTurn(runId, Number.isFinite(ordinal) ? ordinal : null).messages.push(item);
      } else {
        pendingHistory.push(item);
      }
    } else if (section === "committed_turn" && item.itemType === "thought_turn") {
      const runId = item.referenceId ?? `unknown-turn-${outline.previousTurns.length + 1}`;
      const ordinal = Number(item.metadata?.turnOrdinal);
      const turn = ensureTurn(runId, Number.isFinite(ordinal) ? ordinal : null);
      if (pendingHistory.length) {
        turn.messages.unshift(...pendingHistory);
        pendingHistory = [];
      }
      turn.thought = item;
    } else if (item.itemType === "memory" || section === "recalled_memory") {
      outline.recalledMemories.push(item);
    } else if (section === "new_source") {
      outline.currentMessages.push(item);
    } else {
      outline.other.push(item);
    }
  }
  outline.unassignedHistoryMessages.push(...pendingHistory);
  outline.previousTurns.sort((left, right) => (
    (left.turnOrdinal ?? Number.MAX_SAFE_INTEGER) -
    (right.turnOrdinal ?? Number.MAX_SAFE_INTEGER)
  ));
  return outline;
}

export function callRetryIndex<T extends { id: string; input_hash?: string | null }>(
  calls: T[],
  call: T,
) {
  if (!call.input_hash) return 0;
  const index = calls.findIndex((candidate) => candidate.id === call.id);
  return calls.slice(0, Math.max(0, index)).filter((candidate) => (
    candidate.input_hash === call.input_hash
  )).length;
}

const toolLabels: Record<string, string> = {
  lookup_message_sources: "读取消息原文",
  recall_memories: "召回已审核记忆",
  search_conversation_messages: "检索会话历史",
};

const toolDescriptions: Record<string, string> = {
  lookup_message_sources: "按消息引用核对当前会话中的原始消息、说话人和时间。",
  recall_memories: "按主题召回当前会话允许读取、且带证据的已审核记忆。",
  search_conversation_messages: "按关键词检索当前会话的历史消息，不跨会话读取。",
};

export function toolLabel(name: string) {
  return toolLabels[name] ?? name;
}

export function toolDescription(name: string, fallback?: string | null) {
  return toolDescriptions[name] ?? fallback ?? "只读工具";
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function describeToolArguments(name: string, value: unknown) {
  const input = parseToolArguments(value);
  if (name === "lookup_message_sources") {
    const count = Array.isArray(input.messageIds) ? input.messageIds.length : 0;
    return `核对 ${count} 条已引用消息`;
  }
  const query = typeof input.query === "string" ? `“${input.query}”` : "当前主题";
  const limit = Number(input.limit);
  return Number.isFinite(limit) ? `${query} · 最多 ${limit} 条` : query;
}

export function describeSystemInstruction(content: string): {
  kind: SystemInstructionKind;
  label: string;
  description: string;
} {
  if (content.includes("Return only one valid JSON object.") && content.includes("JSON Schema")) {
    return {
      kind: "output_contract",
      label: "输出格式约束",
      description: "Provider 的 JSON Object 模式约束；只限定结构，不是 Agent 身份提示。",
    };
  }
  if (/deterministic action compiler/i.test(content)) {
    return {
      kind: "compiler_instruction",
      label: "动作编译指令",
      description: "把本次 Thought 编译为结构化动作候选，不参与自然思考。",
    };
  }
  if (/You are Asuka|你是 Asuka/i.test(content)) {
    return {
      kind: "agent_instruction",
      label: "Agent 行为指令",
      description: "定义 Asuka 的身份、行为边界、证据要求与工具规则。",
    };
  }
  return {
    kind: "system_instruction",
    label: "系统级指令",
    description: "这次模型请求所需的其他系统级约束。",
  };
}

export function isPrimaryAgentPurpose(purpose: string) {
  return ["primary", "tool_continuation", "revision"].includes(purpose);
}

export function collectPrimarySystemInstructions(calls: ThoughtSystemInstructionCall[]) {
  const seen = new Set<string>();
  return calls.filter((call) => isPrimaryAgentPurpose(call.purpose))
    .flatMap((call) => call.request_context)
    .filter((message) => message.role === "system" && message.content)
    .flatMap((message) => {
      const content = String(message.content);
      if (seen.has(content)) return [];
      seen.add(content);
      return [{ content, ...describeSystemInstruction(content) }];
    });
}

export function thoughtCallStageLabel(call: ThoughtCallStageInput) {
  const failed = call.status === "failed" || Boolean(call.error_code);
  if (failed) {
    if (call.purpose === "compiler") return "动作编译失败";
    if (call.purpose === "compression") return "上下文压缩失败";
    if (call.purpose === "revision") return "Thought 修订失败";
    if (call.purpose === "tool_continuation") return "工具后续调用失败";
    if (call.purpose === "primary") return "主模型调用失败";
    return "模型调用失败";
  }

  const requestedTools = Boolean(call.response_json?.toolCalls?.length);
  if (call.purpose === "primary") {
    return requestedTools ? "请求补充资料" : "形成本次 Thought";
  }
  if (call.purpose === "tool_continuation") {
    return requestedTools ? "继续补充资料" : "工具后形成本次 Thought";
  }
  if (call.purpose === "revision") return "修订本次 Thought";
  if (call.purpose === "compiler") return "编译动作候选";
  if (call.purpose === "compression") return "压缩上下文";
  return call.purpose;
}
