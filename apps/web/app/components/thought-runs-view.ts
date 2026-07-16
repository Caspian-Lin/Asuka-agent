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

const sectionOrder: ThoughtContextSectionKey[] = [
  "compression",
  "history_messages",
  "history_thoughts",
  "recalled_memory",
  "unread_messages",
  "other",
];

export function collectContextSections(calls: Array<{ context_items: ThoughtContextItem[] }>) {
  const seen = new Set<string>();
  const sections = new Map<ThoughtContextSectionKey, ThoughtContextItem[]>();
  for (const call of calls) {
    for (const item of call.context_items) {
      const sourceSection = String(item.metadata?.section ?? "");
      if (item.itemType === "tool_result" || item.itemType === "tool_definition" ||
          sourceSection === "compiler_manifest") continue;
      const key = [
        item.itemType,
        item.referenceId ?? "",
        sourceSection,
        item.content ?? "",
      ].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      const section = contextSectionFor(item);
      const values = sections.get(section) ?? [];
      values.push(item);
      sections.set(section, values);
    }
  }
  return sectionOrder.flatMap((key) => {
    const items = sections.get(key) ?? [];
    return items.length ? [{ key, items }] : [];
  });
}

const toolLabels: Record<string, string> = {
  lookup_message_sources: "读取消息原文",
  recall_memories: "召回已审核记忆",
  search_conversation_messages: "检索会话历史",
};

export function toolLabel(name: string) {
  return toolLabels[name] ?? name;
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
  if (/You are Asuka/i.test(content)) {
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
