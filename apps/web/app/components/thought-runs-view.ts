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
  toolTrace: ThoughtContextItem[];
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
    if ((item.itemType === "tool_result" && sourceSection !== "committed_turn") ||
        sourceSection === "compiler_manifest" || item.itemType === "request_payload") return [];
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
      toolTrace: [],
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
    } else if (section === "committed_turn" &&
        ["assistant_tool_call", "tool_result"].includes(item.itemType)) {
      const runId = typeof item.metadata?.thoughtRunId === "string"
        ? item.metadata.thoughtRunId
        : null;
      const ordinal = Number(item.metadata?.turnOrdinal);
      if (runId) {
        ensureTurn(runId, Number.isFinite(ordinal) ? ordinal : null).toolTrace.push(item);
      } else {
        outline.other.push(item);
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

export function recordedRequestPayload(call: {
  request_context: unknown[];
  context_items: ThoughtContextItem[];
}) {
  const exact = call.context_items.find((item) => (
    item.itemType === "request_payload" && item.content?.trim()
  ))?.content?.trim();
  if (exact) return { exact: true, json: exact };

  const tools = call.context_items
    .filter((item) => item.itemType === "tool_definition" && item.referenceId)
    .map((item) => ({
      type: "function",
      function: {
        name: item.referenceId,
        description: item.content,
        parameters: item.metadata?.schema,
      },
    }));
  return {
    exact: false,
    json: JSON.stringify({
      messages: call.request_context,
      ...(tools.length ? { tools } : {}),
    }),
  };
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

export type ThoughtSurfaceState = "loading" | "error" | "empty" | "ready";

export function thoughtRunsSurfaceState({
  loading,
  error,
  runCount,
}: {
  loading: boolean;
  error: string | null;
  runCount: number;
}): ThoughtSurfaceState {
  if (loading && runCount === 0) return "loading";
  if (error && runCount === 0) return "error";
  return runCount === 0 ? "empty" : "ready";
}

export function thoughtDetailSurfaceState({
  selectedId,
  detailId,
  loading,
  error,
}: {
  selectedId: string | null;
  detailId: string | null;
  loading: boolean;
  error: string | null;
}): ThoughtSurfaceState {
  if (!selectedId) return "empty";
  if (loading || detailId !== selectedId) return error ? "error" : "loading";
  return error ? "error" : "ready";
}

export type ThoughtTimelineCall = ThoughtCallStageInput & {
  id: string;
  sequence_number: number;
  created_at: string;
  profile: string;
  model?: string | null;
  latency_ms?: number | null;
};

export type ThoughtTimelineEntry = {
  id: string;
  sequence: number;
  purpose: string;
  label: string;
  statusLabel: string;
  tone: "current" | "failure" | "persisted" | "execution";
  profile: string;
  model: string | null;
  createdAt: string;
  latencyMs: number | null;
};

function compilerResponseStatus(call: ThoughtTimelineCall) {
  const content = call.response_json?.content;
  if (typeof content !== "string") return null;
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    return typeof parsed?.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

export function buildThoughtTimeline(
  calls: ThoughtTimelineCall[],
  invalidCallIds: string[] = [],
): ThoughtTimelineEntry[] {
  const invalid = new Set(invalidCallIds);
  return [...calls].sort((left, right) => left.sequence_number - right.sequence_number)
    .map((call) => {
      const failed = call.status === "failed" || Boolean(call.error_code) || invalid.has(call.id);
      const compilerStatus = call.purpose === "compiler" ? compilerResponseStatus(call) : null;
      const running = call.status === "running";
      return {
        id: call.id,
        sequence: call.sequence_number,
        purpose: call.purpose,
        label: thoughtCallStageLabel(call),
        statusLabel: failed
          ? invalid.has(call.id) ? "校验失败" : "失败"
          : compilerStatus === "needs_revision" ? "要求修订"
            : running ? "运行中" : "成功",
        tone: failed ? "failure"
          : compilerStatus === "needs_revision" || running ? "current"
            : call.purpose === "compiler" ? "execution" : "persisted",
        profile: call.profile,
        model: call.model ?? null,
        createdAt: call.created_at,
        latencyMs: call.latency_ms ?? null,
      };
    });
}

export function thoughtOutcome({
  runStatus,
  compilerStatus,
  proposals,
  lastValidationError,
}: {
  runStatus: string;
  compilerStatus: string | null;
  proposals: Array<{ proposal_type: string }>;
  lastValidationError?: { code?: string; message?: string } | null;
}) {
  if (proposals.some((proposal) => proposal.proposal_type === "no_action")) {
    return {
      label: "已完成 · no_action",
      detail: "本轮明确选择不产生副作用，Turn 与 watermark 仍可正常提交。",
      tone: "persisted" as const,
    };
  }
  if (compilerStatus === "needs_revision") {
    return {
      label: "等待 Primary 修订",
      detail: "Compiler 发现动作所需信息不足，正在执行有界修订。",
      tone: "current" as const,
    };
  }
  if (compilerStatus === "retrying") {
    return {
      label: "Compiler 校验失败",
      detail: lastValidationError?.message ?? "无效编译结果不会进入 Proposal，系统将从 Compiler 阶段重试。",
      tone: "failure" as const,
    };
  }
  if (runStatus === "failed") {
    return {
      label: "Thought 运行失败",
      detail: lastValidationError?.message ?? "本轮没有形成可提交的最终结果。",
      tone: "failure" as const,
    };
  }
  if (proposals.length > 0) {
    return {
      label: `已形成 ${proposals.length} 个 Proposal`,
      detail: "Proposal 只是候选动作；是否产生副作用由后续 Policy 与 Executor 决定。",
      tone: "execution" as const,
    };
  }
  if (runStatus === "completed") {
    return {
      label: "已完成 · 无 Proposal",
      detail: "本轮已完成，但没有保存动作候选。",
      tone: "persisted" as const,
    };
  }
  return {
    label: "Thought 正在运行",
    detail: "阶段状态会随持久化检查点更新。",
    tone: "current" as const,
  };
}

export function proposalPrimaryMatch(primaryOutput: string | null, proposalContent: unknown) {
  if (typeof proposalContent !== "string" || !proposalContent) return null;
  const start = primaryOutput?.indexOf(proposalContent) ?? -1;
  return {
    matches: start >= 0,
    start,
    end: start >= 0 ? start + proposalContent.length : -1,
  };
}

export type ProposalEvidenceReference = { type: string; id: string };

export type ProposalEvidenceSource = ProposalEvidenceReference & {
  title: string;
  content: string | null;
  origin: "context" | "tool_result" | "unresolved";
  redacted: boolean;
};

function toolResultEvidence(
  item: ThoughtContextItem,
  reference: ProposalEvidenceReference,
): ProposalEvidenceSource | null {
  if (!item.content) return null;
  try {
    const payload = JSON.parse(item.content);
    const values = reference.type === "message" ? payload?.messages : payload?.memories;
    if (!Array.isArray(values)) return null;
    const source = values.find((value) => String(
      reference.type === "message"
        ? value?.message_id ?? value?.id
        : value?.memory_id ?? value?.id,
    ) === reference.id);
    if (!source) return null;
    return {
      ...reference,
      title: reference.type === "message"
        ? String(source.sender_display_name ?? source.sender_id ?? "消息证据")
        : String(source.title ?? `记忆 ${reference.id}`),
      content: String(source.content ?? source.claim ?? "") || null,
      origin: "tool_result",
      redacted: Boolean(source.redacted),
    };
  } catch {
    return null;
  }
}

export function resolveProposalEvidence(
  references: ProposalEvidenceReference[],
  calls: Array<{ context_items: ThoughtContextItem[] }>,
): ProposalEvidenceSource[] {
  const items = calls.flatMap((call) => call.context_items);
  return references.map((reference) => {
    const direct = items.find((item) => {
      if (item.referenceId !== reference.id) return false;
      if (reference.type === "source") {
        return ["external_source", "tool_result"].includes(item.itemType);
      }
      return item.itemType === reference.type;
    });
    if (direct) {
      return {
        ...reference,
        title: direct.title,
        content: direct.content,
        origin: "context" as const,
        redacted: direct.metadata?.redacted === true,
      };
    }
    for (const item of items.filter((candidate) => candidate.itemType === "tool_result")) {
      const resolved = toolResultEvidence(item, reference);
      if (resolved) return resolved;
    }
    return {
      ...reference,
      title: `${reference.type}:${reference.id}`,
      content: null,
      origin: "unresolved" as const,
      redacted: false,
    };
  });
}
