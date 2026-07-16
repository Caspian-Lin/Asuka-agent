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
