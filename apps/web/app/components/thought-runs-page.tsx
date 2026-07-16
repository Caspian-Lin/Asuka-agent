"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IconType } from "react-icons";
import {
  LuArchive,
  LuBrainCircuit,
  LuChevronRight,
  LuCircle,
  LuFileInput,
  LuHistory,
  LuListTree,
  LuMessageSquareText,
  LuRefreshCw,
  LuShieldCheck,
  LuWrench,
} from "react-icons/lu";
import { controlRequest } from "./control-api";
import {
  collectContextSections,
  collectPrimarySystemInstructions,
  describeSystemInstruction,
  describeToolArguments,
  groupThoughtRuns,
  isPrimaryAgentPurpose,
  thoughtCallStageLabel,
  toolDescription,
  toolLabel,
  type ThoughtContextItem,
  type ThoughtContextSectionKey,
} from "./thought-runs-view";

type ThoughtRun = {
  id: string;
  conversation_id: string;
  conversation_title: string;
  job_run_id: string;
  correlation_id: string;
  trigger_type: string;
  trigger_reason: string;
  status: string;
  decision: string | null;
  summary: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  job_type: string;
  turn_ordinal: number;
  context_epoch_ordinal: number;
  new_message_start_id: string | null;
  new_message_end_id: string | null;
  stream_status: string;
  current_epoch_ordinal: number;
  committed_message_at: string | null;
  stream_updated_at: string;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  thought_count: number;
  candidate_count: number;
};

type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: string;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type LlmCall = {
  id: string;
  sequence_number: number;
  purpose: string;
  profile: string;
  provider: string;
  model: string | null;
  prompt_version: string;
  status: string;
  error_code: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  request_context: ChatMessage[];
  response_json: {
    content?: string;
    toolCalls?: ToolCall[];
  } | null;
  context_items: ThoughtContextItem[];
  created_at: string;
};

type ThoughtDetail = {
  run: ThoughtRun & {
    external_id: string | null;
    job_name: string;
  };
  calls: LlmCall[];
  outputs: Array<{
    id: string;
    intent: string;
    basis: string;
    evidence_message_ids: string[];
    confidence_millis: number;
    risk: string;
    decision: string;
  }>;
  candidates: Array<{
    id: string;
    claim: string;
    status: string;
    attribution_status: string;
  }>;
  participants: Array<{
    participant_id: string;
    display_name: string;
    aliases: string[];
  }>;
};

type ToolResultRecord = {
  ok?: boolean;
  notice?: string;
  query?: string;
  messages?: Array<{
    sender_display_name?: string | null;
    sender_id?: string | null;
    content?: string;
    sent_at?: string;
  }>;
  memories?: Array<{ title?: string; content?: string }>;
  error?: { message?: string };
};

const contextSectionCopy: Record<ThoughtContextSectionKey, {
  title: string;
  description: string;
  icon: IconType;
}> = {
  available_tools: {
    title: "可用只读工具",
    description: "提供给主 Agent 的能力清单；可用不代表本次运行实际调用过。",
    icon: LuWrench,
  },
  compression: {
    title: "上一段上下文摘要",
    description: "只在自动压缩后进入新上下文；手动重置不会携带这份摘要。",
    icon: LuArchive,
  },
  history_messages: {
    title: "前几轮消息",
    description: "本会话此前已提交的消息，以及首次建立思绪流时选取的少量历史。",
    icon: LuHistory,
  },
  history_thoughts: {
    title: "前几轮思绪",
    description: "同一会话、同一上下文段中已经完成的自然思绪。",
    icon: LuBrainCircuit,
  },
  recalled_memory: {
    title: "召回记忆",
    description: "经过权限与证据过滤后，本轮主动召回的长期信息。",
    icon: LuFileInput,
  },
  unread_messages: {
    title: "本次未读消息",
    description: "这条 Thought 新消费的消息；成功提交后会同步为已读。",
    icon: LuMessageSquareText,
  },
  other: {
    title: "其他输入来源",
    description: "无法归入常规会话来源的审计输入。",
    icon: LuFileInput,
  },
};

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function triggerLabel(value: string) {
  return value === "schedule" ? "定时触发" : value === "manual" ? "手动触发" : value;
}

function stateLabel(value: string) {
  if (value === "completed") return "已完成";
  if (value === "running") return "运行中";
  if (value === "failed") return "失败";
  return value;
}

function roleLabel(message: ChatMessage) {
  if (message.role === "system") {
    return describeSystemInstruction(message.content ?? "").label;
  }
  if (message.role === "assistant") return "Asuka / 模型";
  if (message.role === "tool") return "工具结果";
  return "会话输入";
}

function contextItemTitle(item: ThoughtContextItem) {
  const sender = item.metadata?.sender_display_name;
  const sentAt = item.metadata?.sent_at;
  if (item.itemType === "message" && typeof sender === "string") {
    return `${sender} · ${formatDateTime(typeof sentAt === "string" ? sentAt : null)}`;
  }
  if (item.itemType === "thought_turn") {
    const turn = Number(item.metadata?.turnOrdinal);
    return Number.isFinite(turn) ? `历史 Thought · 第 ${turn} 轮` : "历史 Thought";
  }
  if (item.itemType === "tool_definition") {
    return toolLabel(item.referenceId ?? item.title);
  }
  return item.title;
}

function parseToolResult(value: string | null): ToolResultRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ToolResultRecord
      : null;
  } catch {
    return null;
  }
}

function ToolResultView({ item }: { item: ThoughtContextItem }) {
  const result = parseToolResult(item.content);
  if (!result) {
    return item.content ? <p className="tool-result-copy">{item.content}</p> : null;
  }
  if (result.error?.message) {
    return <p className="tool-result-error">{result.error.message}</p>;
  }
  if (result.messages?.length) {
    return (
      <div className="tool-message-results">
        {result.messages.map((message, index) => (
          <article key={`${item.id}-message-${index}`}>
            <header>
              <strong>{message.sender_display_name || "会话成员"}</strong>
              <time>{formatDateTime(message.sent_at)}</time>
            </header>
            <p>{message.content || "（空消息）"}</p>
          </article>
        ))}
      </div>
    );
  }
  if (result.memories?.length) {
    return (
      <div className="tool-message-results">
        {result.memories.map((memory, index) => (
          <article key={`${item.id}-memory-${index}`}>
            <strong>{memory.title || "记忆"}</strong>
            <p>{memory.content || "（空内容）"}</p>
          </article>
        ))}
      </div>
    );
  }
  return <p className="tool-result-copy">{result.notice || "工具已返回，未找到可展示的匹配内容。"}</p>;
}

function NaturalOutput({ call }: { call: LlmCall }) {
  const content = call.response_json?.content?.trim();
  const natural = ["primary", "tool_continuation", "revision"].includes(call.purpose);
  if (natural && content) {
    return <div className="natural-thought-output"><span>本次调用生成内容</span><p>{content}</p></div>;
  }
  if (call.error_code) {
    return <p className="tool-result-error">调用失败：{call.error_code}</p>;
  }
  if (call.response_json?.toolCalls?.length) {
    return <p className="round-transition-note">模型先请求补充资料，本轮未形成最终思绪文本。</p>;
  }
  return <p className="round-transition-note">本轮没有可展示的自然语言输出。</p>;
}

export default function ThoughtRunsPage({
  requestedRunId,
}: {
  requestedRunId?: string | null;
}) {
  const [runs, setRuns] = useState<ThoughtRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(requestedRunId ?? null);
  const [detail, setDetail] = useState<ThoughtDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resettingConversationId, setResettingConversationId] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const payload = await controlRequest<{ thoughtRuns: ThoughtRun[] }>("/api/thought-runs");
      setRuns(payload.thoughtRuns);
      setSelectedId((current) => (
        current && payload.thoughtRuns.some((run) => run.id === current)
          ? current
          : payload.thoughtRuns[0]?.id ?? null
      ));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "思绪运行载入失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await controlRequest<ThoughtDetail>(`/api/thought-runs/${encodeURIComponent(id)}`));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "思绪详情载入失败");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadRuns(), 0);
    const timer = window.setInterval(() => void loadRuns(), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadRuns]);

  useEffect(() => {
    if (!requestedRunId) return;
    const timer = window.setTimeout(() => setSelectedId(requestedRunId), 0);
    return () => window.clearTimeout(timer);
  }, [requestedRunId]);

  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setTimeout(() => void loadDetail(selectedId), 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail, selectedId]);

  async function resetContext(conversationId: string, conversationTitle: string) {
    const confirmed = window.confirm(
      `确认重置“${conversationTitle}”的思绪上下文？\n\n下一条思绪会从空的短期上下文开始。历史消息、旧 Thought 和审计记录不会删除，已经消费的消息也不会重新读取。`,
    );
    if (!confirmed) return;
    setResettingConversationId(conversationId);
    setNotice(null);
    try {
      const payload = await controlRequest<{
        stream: { currentEpochOrdinal: number };
      }>(`/api/thought-streams/${encodeURIComponent(conversationId)}/reset`, {
        method: "POST",
      });
      setNotice(
        `${conversationTitle} 的短期上下文已清空；下一条思绪将从第 ${payload.stream.currentEpochOrdinal} 段重新开始。`,
      );
      await loadRuns();
      if (selectedId) await loadDetail(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "思绪上下文重置失败");
    } finally {
      setResettingConversationId(null);
    }
  }

  const totals = useMemo(() => runs.reduce(
    (summary, run) => ({
      calls: summary.calls + run.call_count,
      tokens: summary.tokens + run.input_tokens + run.output_tokens,
    }),
    { calls: 0, tokens: 0 },
  ), [runs]);
  const groups = useMemo(() => groupThoughtRuns(runs), [runs]);
  const primaryContextCalls = useMemo(
    () => (detail?.calls ?? []).filter((call) => isPrimaryAgentPurpose(call.purpose)),
    [detail],
  );
  const contextSections = useMemo(
    () => collectContextSections(primaryContextCalls),
    [primaryContextCalls],
  );
  const systemInstructions = useMemo(() => {
    return collectPrimarySystemInstructions(detail?.calls ?? []);
  }, [detail]);

  return (
    <section className="page-panel thought-runs-page">
      <div className="page-hero">
        <div><span className="page-context">Cognition trace</span><h1>思绪运行</h1><p>每个会话拥有独立的短期思绪流。这里按会话查看触发、未读消息、历史上下文、自然思绪与工具轮次，也可以让指定会话从空上下文重新开始。</p></div>
        <div className="dual-stat"><span><strong>{runs.length}</strong>次运行</span><i /><span><strong>{totals.tokens}</strong>tokens</span></div>
      </div>

      {notice && <div className="inline-success" role="status">{notice}</div>}
      {error && <div className="inline-error">{error} <button onClick={() => void loadRuns()}>重试</button></div>}
      {loading ? (
        <div className="jobs-skeleton" aria-label="正在载入思绪"><i /><i /><i /></div>
      ) : runs.length === 0 ? (
        <div className="empty-state"><LuBrainCircuit className="empty-icon" aria-hidden /><h3>还没有真实思绪运行</h3><p>定时任务处理到新的 QQ 消息后，会在对应会话下留下模型轮次、上下文与引用记录。</p></div>
      ) : (
        <div className="thought-workspace">
          <div className="thought-run-list" aria-label="按会话分组的思绪运行列表">
            {groups.map((group) => {
              const latest = group.runs[0];
              return (
                <section className="thought-conversation-group" key={group.conversationId}>
                  <header>
                    <div>
                      <strong>{group.conversationTitle}</strong>
                      <span>上下文第 {latest.current_epoch_ordinal} 段 · {group.runs.length} 次运行</span>
                    </div>
                    <button
                      className="context-reset-icon"
                      disabled={resettingConversationId === group.conversationId}
                      onClick={() => void resetContext(group.conversationId, group.conversationTitle)}
                      aria-label={`重置 ${group.conversationTitle} 的思绪上下文`}
                      title="清空这个会话的短期上下文"
                    >
                      <LuRefreshCw aria-hidden />
                    </button>
                  </header>
                  <div className="thought-conversation-runs">
                    {group.runs.map((run) => {
                      const selected = run.id === selectedId;
                      return (
                        <button
                          className={selected ? "selected" : ""}
                          key={run.id}
                          onClick={() => setSelectedId(run.id)}
                          aria-current={selected ? "true" : undefined}
                        >
                          <LuCircle className={`run-dot state-${run.status}`} aria-hidden />
                          <span className="run-summary">
                            <strong>{run.summary ?? "运行未产生结论"}</strong>
                            <small>{triggerLabel(run.trigger_type)} · 第 {run.turn_ordinal} 轮</small>
                          </span>
                          {selected ? (
                            <span className="selected-run-marker"><LuChevronRight aria-hidden />正在查看</span>
                          ) : (
                            <span className="run-usage"><strong>{run.call_count} 轮调用</strong><small>{run.input_tokens + run.output_tokens} tokens</small></span>
                          )}
                          <time>{formatDateTime(run.started_at)}</time>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          <aside className="thought-inspector" aria-live="polite">
            {!detail || detail.run.id !== selectedId ? (
              <div className="run-loading"><i /><i /><i /></div>
            ) : (
              <>
                <header>
                  <div className="inspector-heading">
                    <span>{detail.run.conversation_title} · {triggerLabel(detail.run.trigger_type)}</span>
                    <h2>{detail.run.summary ?? "无结论"}</h2>
                  </div>
                  <div className="inspector-actions">
                    <span className={`run-state state-${detail.run.status}`}>{stateLabel(detail.run.status)}</span>
                    <button
                      className="context-reset-button"
                      disabled={resettingConversationId === detail.run.conversation_id}
                      onClick={() => void resetContext(
                        detail.run.conversation_id,
                        detail.run.conversation_title,
                      )}
                    >
                      <LuRefreshCw aria-hidden />
                      {resettingConversationId === detail.run.conversation_id ? "正在重置" : "重置上下文"}
                    </button>
                  </div>
                </header>
                <div className="thought-inspector-body">
                  <div className="thought-inspector-content">
                    <div className="context-epoch-note">
                      <LuShieldCheck aria-hidden />
                      <div>
                        <strong>会话隔离 · 当前上下文第 {detail.run.current_epoch_ordinal} 段</strong>
                        <p>
                          这条 Thought 属于第 {detail.run.context_epoch_ordinal} 段。
                          {detail.run.context_epoch_ordinal < detail.run.current_epoch_ordinal
                            ? " 它是重置前的历史记录，不会再进入后续上下文。"
                            : " 同一段内的已提交消息与思绪会传给下一轮。"}
                        </p>
                      </div>
                    </div>

                    <dl className="thought-facts">
                      <div><dt>触发原因</dt><dd>{detail.run.trigger_reason}</dd></div>
                      <div><dt>开始时间</dt><dd>{formatDateTime(detail.run.started_at)}</dd></div>
                      <div><dt>结束时间</dt><dd>{formatDateTime(detail.run.completed_at)}</dd></div>
                      <div><dt>模型调用</dt><dd>{detail.calls.length} 轮</dd></div>
                      <div><dt>新消息范围</dt><dd>{detail.run.new_message_start_id ? "本轮已记录" : "没有新消息"}</dd></div>
                      <div><dt>最终决策</dt><dd>{detail.run.decision ?? "—"}</dd></div>
                    </dl>

                    <section className="thought-context-map">
                    <header>
                      <div><LuListTree aria-hidden /><h3>主 Agent 上下文构成</h3></div>
                      <p>这里只汇总主 Agent 实际读取的内容；fast compiler 的结构化约束留在对应调用中。</p>
                    </header>

                    {systemInstructions.length > 0 && (
                      <section className="context-source-section system-source">
                        <header>
                          <LuShieldCheck aria-hidden />
                          <div>
                            <h4>主 Agent 行为指令</h4>
                            <p>每次主 Agent 请求携带一次；工具续轮复用同一份，不会累积副本。</p>
                          </div>
                          <span>{systemInstructions.length} 类</span>
                        </header>
                        {systemInstructions.map((instruction) => (
                          <details
                            className={`instruction-${instruction.kind}`}
                            key={`${instruction.kind}-${instruction.content}`}
                          >
                            <summary>
                              <span>{instruction.label}</span>
                              <small>{instruction.description}</small>
                            </summary>
                            <p>{instruction.content}</p>
                          </details>
                        ))}
                      </section>
                    )}

                    {contextSections.map((section) => {
                      const copy = contextSectionCopy[section.key];
                      const Icon = copy.icon;
                      return (
                        <section className={`context-source-section source-${section.key}`} key={section.key}>
                          <header>
                            <Icon aria-hidden />
                            <div><h4>{copy.title}</h4><p>{copy.description}</p></div>
                            <span>{section.items.length} 项</span>
                          </header>
                          <div className="context-source-items">
                            {section.items.map((item) => (
                              <article key={item.id}>
                                <strong>{contextItemTitle(item)}</strong>
                                {item.itemType === "tool_definition" ? (
                                  <>
                                    <p>{toolDescription(item.referenceId ?? "", item.content)}</p>
                                    {item.metadata?.schema && (
                                      <details className="tool-schema">
                                        <summary>查看参数约束</summary>
                                        <pre>{JSON.stringify(item.metadata.schema, null, 2)}</pre>
                                      </details>
                                    )}
                                  </>
                                ) : item.content && <p>{item.content}</p>}
                              </article>
                            ))}
                          </div>
                        </section>
                      );
                    })}
                    </section>

                    <section className="thought-process">
                    <header>
                      <div><LuBrainCircuit aria-hidden /><h3>本次 Thought 的模型调用</h3></div>
                      <p>以下只属于本次运行：主模型、只读工具续轮与动作编译按实际请求顺序展开。</p>
                    </header>

                    {detail.calls.map((call) => {
                      const toolCalls = call.response_json?.toolCalls ?? [];
                      const toolResults = call.context_items.filter((item) => item.itemType === "tool_result");
                      return (
                        <section className="thought-round" key={call.id}>
                          <header>
                            <div>
                              <span className="round-number">{call.sequence_number}</span>
                              <strong>{thoughtCallStageLabel(call)}</strong>
                              <small>{call.profile} · {call.model ?? call.provider}</small>
                            </div>
                            <span>{call.input_tokens ?? 0} in / {call.output_tokens ?? 0} out · {call.latency_ms ?? 0} ms</span>
                          </header>

                          <NaturalOutput call={call} />

                          {toolCalls.length > 0 && (
                            <div className="tool-call-list">
                              {toolCalls.map((toolCall) => {
                                const result = toolResults.find((item) => item.referenceId === toolCall.id);
                                return (
                                  <article key={toolCall.id}>
                                    <header>
                                      <LuWrench aria-hidden />
                                      <div>
                                        <strong>{toolLabel(toolCall.function.name)}</strong>
                                        <span>{describeToolArguments(toolCall.function.name, toolCall.function.arguments)}</span>
                                      </div>
                                      <em>{result?.metadata?.ok === false ? "失败" : "只读"}</em>
                                    </header>
                                    {result && <ToolResultView item={result} />}
                                  </article>
                                );
                              })}
                            </div>
                          )}

                          {!(["primary", "tool_continuation", "revision"].includes(call.purpose)) && call.response_json?.content && (
                            <details className="model-output">
                              <summary><LuMessageSquareText aria-hidden />查看本轮结构化输出</summary>
                              <pre>{call.response_json.content}</pre>
                            </details>
                          )}

                          <details className="model-context">
                            <summary><LuListTree aria-hidden />查看本轮完整模型载荷</summary>
                            <p className="model-payload-note">
                              {call.purpose === "compiler"
                                ? "这是 fast compiler 的独立请求；JSON 输出格式约束只服务于动作编译，不属于主 Agent 上下文。"
                                : "这是主 Agent 的一次独立请求；工具续轮会重发同一行为指令，不会逐轮追加副本。"}
                            </p>
                            {call.request_context.map((message, index) => (
                              <article key={`${call.id}-message-${index}`}>
                                <span>{roleLabel(message)}</span>
                                <pre>{message.content || (message.tool_calls?.length ? "模型请求调用只读工具" : "（空内容）")}</pre>
                              </article>
                            ))}
                          </details>
                        </section>
                      );
                    })}
                    </section>
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
