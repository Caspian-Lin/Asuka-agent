"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuBrainCircuit,
  LuChevronRight,
  LuCircle,
  LuListTree,
  LuMessageSquareText,
  LuRefreshCw,
  LuShieldCheck,
  LuWrench,
} from "react-icons/lu";
import { controlRequest } from "./control-api";
import {
  buildThoughtContextOutline,
  callRetryIndex,
  collectPrimarySystemInstructions,
  describeSystemInstruction,
  describeToolArguments,
  groupThoughtRuns,
  isPrimaryAgentPurpose,
  recordedRequestPayload,
  thoughtCallStageLabel,
  toolDescription,
  toolLabel,
  type ThoughtContextItem,
  type ThoughtContextTurn,
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
  input_hash: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  request_context: ChatMessage[];
  response_json: {
    content?: string;
    toolCalls?: ToolCall[];
    metadata?: Record<string, unknown>;
  } | null;
  context_items: ThoughtContextItem[];
  created_at: string;
};

type ContextRunCall = Omit<LlmCall, "request_context" | "context_items" | "prompt_version"> & {
  thought_run_id: string;
  tool_results: ThoughtContextItem[];
};

type ContextRun = {
  id: string;
  turn_ordinal: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  calls: ContextRunCall[];
};

type ActionProposal = {
  id: string;
  compiler_llm_call_id: string | null;
  ordinal: number;
  proposal_type: string;
  status: string;
  payload: Record<string, unknown>;
  evidence_references: Array<Record<string, unknown>>;
  policy_reasons: unknown[];
  decision_id: string | null;
  decision_outcome: string | null;
  decision_reason_code: string | null;
  next_evaluation_at: string | null;
  evaluation_count: number | null;
  delivery_id: string | null;
  delivery_status: string | null;
  external_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  sent_at: string | null;
};

type ThoughtDetail = {
  run: ThoughtRun & {
    external_id: string | null;
    job_name: string;
    job_attempt_count: number;
    job_max_attempts: number;
    primary_output: string | null;
    compiler_status: string | null;
    compiler_state: {
      invalidCallIds?: string[];
      lastValidationError?: { code?: string; message?: string };
    };
    compiler_attempt_count: number;
    revision_count: number;
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
  proposals: ActionProposal[];
  participants: Array<{
    participant_id: string;
    display_name: string;
    aliases: string[];
  }>;
  contextRuns: ContextRun[];
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
  error?: { code?: string; message?: string };
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

function AuditBadge({
  tone,
  children,
}: {
  tone: "persisted" | "execution" | "current" | "failure" | "fixed";
  children: ReactNode;
}) {
  return <span className={`audit-badge audit-badge-tone-${tone}`}>{children}</span>;
}

function CallStats({ call }: { call: Pick<
  LlmCall,
  "created_at" | "model" | "provider" | "input_tokens" | "output_tokens" | "latency_ms"
> }) {
  return (
    <div className="audit-call-stats" aria-label="模型调用统计">
      <span>{formatDateTime(call.created_at)}</span>
      <span>{call.model ?? call.provider}</span>
      <span>{call.input_tokens ?? 0} 输入 / {call.output_tokens ?? 0} 输出 tokens</span>
      <span>{call.latency_ms ?? 0} ms</span>
    </div>
  );
}

function OriginalMessageList({ items }: { items: ThoughtContextItem[] }) {
  if (!items.length) return <p className="audit-empty">没有消息。</p>;
  return (
    <div className="audit-original-list">
      {items.map((item) => (
        <article key={item.id}>
          <header>
            <strong>{contextItemTitle(item)}</strong>
            <AuditBadge tone="fixed">原文</AuditBadge>
          </header>
          <p>{item.content || "（空消息）"}</p>
        </article>
      ))}
    </div>
  );
}

function RawCallPayload({ call }: { call: LlmCall }) {
  const payload = recordedRequestPayload(call);
  return (
    <details className="audit-subnode audit-payload">
      <summary>
        <span>{payload.exact ? "完整调用载荷" : "已保存的调用载荷"}</span>
        <span className="audit-summary-badges">
          <AuditBadge tone={payload.exact ? "fixed" : "failure"}>
            {payload.exact ? "原始 JSON 请求体" : "旧记录字段不完整"}
          </AuditBadge>
          <AuditBadge tone="execution">仅执行记录</AuditBadge>
        </span>
      </summary>
      <div className="audit-subnode-body">
        {!payload.exact && (
          <p className="audit-payload-notice">
            这条历史调用尚未保存完整 Provider 请求体；下方只原样合并当时已保存的 messages 与 tools，不推断缺失参数。
          </p>
        )}
        <pre className="audit-request-json">{payload.json}</pre>
      </div>
    </details>
  );
}

function toolFailureKind(item?: ThoughtContextItem) {
  if (item?.metadata?.ok !== false) return null;
  const result = parseToolResult(item.content);
  const code = String(result?.error?.code ?? "");
  return ["invalid_tool_call", "invalid_tool_arguments", "tool_not_allowed"].includes(code)
    ? "主观失败"
    : "客观失败";
}

function ToolInvocation({
  toolCall,
  result,
}: {
  toolCall: ToolCall;
  result?: ThoughtContextItem;
}) {
  const failure = toolFailureKind(result);
  return (
    <details className={`audit-subnode audit-tool${failure ? " failed" : ""}`} open>
      <summary>
        <span>{toolLabel(toolCall.function.name)}</span>
        <span className="audit-summary-badges">
          <AuditBadge tone="persisted">进入本段后续调用上下文</AuditBadge>
          {failure && <AuditBadge tone="failure">{failure}</AuditBadge>}
        </span>
      </summary>
      <div className="audit-subnode-body">
        <div className="audit-command">
          <strong>调用命令</strong>
          <span>{describeToolArguments(toolCall.function.name, toolCall.function.arguments)}</span>
          <pre>{toolCall.function.arguments}</pre>
        </div>
        <div className="audit-tool-result">
          <strong>工具返回内容</strong>
          {result ? <ToolResultView item={result} /> : <p>未记录工具返回。</p>}
        </div>
      </div>
    </details>
  );
}

function PrimaryCallNode({
  call,
  calls,
  ordinal,
}: {
  call: LlmCall;
  calls: LlmCall[];
  ordinal: number;
}) {
  const toolCalls = call.response_json?.toolCalls ?? [];
  const toolResults = call.context_items.filter((item) => item.itemType === "tool_result");
  const retryIndex = callRetryIndex(calls, call);
  const failed = call.status === "failed" || Boolean(call.error_code);
  return (
    <details className={`audit-node audit-call${failed ? " failed" : ""}`} open>
      <summary>
        <span className="audit-node-title">
          <span className="round-number">{ordinal}</span>
          <strong>
            {retryIndex > 0 && `【重试 ${retryIndex}】`}
            第 {ordinal} 轮调用 · {thoughtCallStageLabel(call)}
          </strong>
        </span>
        <span className="audit-summary-badges">
          {toolCalls.length > 0 && <AuditBadge tone="current">工具</AuditBadge>}
          {failed && <AuditBadge tone="failure">客观失败</AuditBadge>}
          <AuditBadge tone={toolCalls.length > 0 ? "persisted" : "execution"}>
            {toolCalls.length > 0 ? "输出进入本段后续调用上下文" : "仅执行记录"}
          </AuditBadge>
        </span>
      </summary>
      <div className="audit-node-body">
        <CallStats call={call} />
        {failed && (
          <p className="audit-error-copy">
            调用未产生可提交结果：{call.error_code ?? "unknown_error"}。
            相同请求哈希再次出现时会显示为重试。
          </p>
        )}
        {toolCalls.map((toolCall) => (
          <ToolInvocation
            key={toolCall.id}
            toolCall={toolCall}
            result={toolResults.find((item) => item.referenceId === toolCall.id)}
          />
        ))}
        {call.response_json?.content?.trim() && (
          <section className="audit-model-output">
            <header>
              <strong>模型本次输出</strong>
              <AuditBadge tone="execution">调用结果</AuditBadge>
            </header>
            <p>{call.response_json.content}</p>
          </section>
        )}
        <RawCallPayload call={call} />
      </div>
    </details>
  );
}

function HistoricalExecution({
  run,
  onOpen,
}: {
  run?: ContextRun;
  onOpen: () => void;
}) {
  if (!run) {
    return (
      <div className="audit-history-link">
        <p>这条历史 Thought 没有附带旧版执行摘要。</p>
        <button onClick={onOpen}>查看原 Thought</button>
      </div>
    );
  }
  return (
    <details className="audit-subnode audit-history-execution">
      <summary>
        <span>当时的执行记录</span>
        <AuditBadge tone="execution">不进入下一段 Thought 上下文</AuditBadge>
      </summary>
      <div className="audit-subnode-body">
        {run.calls.map((call) => {
          const tools = call.response_json?.toolCalls ?? [];
          return (
            <article className="audit-history-call" key={call.id}>
              <header>
                <strong>{thoughtCallStageLabel(call)}</strong>
                {call.status === "failed" && <AuditBadge tone="failure">失败</AuditBadge>}
              </header>
              <CallStats call={call} />
              {tools.map((toolCall) => {
                const result = call.tool_results.find((item) => item.referenceId === toolCall.id);
                return (
                  <div className="audit-history-tool" key={toolCall.id}>
                    <strong>{toolLabel(toolCall.function.name)}</strong>
                    <span>{describeToolArguments(toolCall.function.name, toolCall.function.arguments)}</span>
                    {result && <ToolResultView item={result} />}
                  </div>
                );
              })}
            </article>
          );
        })}
        <button className="audit-open-thought" onClick={onOpen}>查看原 Thought 完整载荷</button>
      </div>
    </details>
  );
}

function actionLabel(value: string) {
  if (value === "reply") return "回复候选";
  if (value === "memory") return "记忆候选";
  if (value === "task") return "任务候选";
  if (value === "no_action") return "不执行动作";
  return value;
}

function parseJsonObject(value?: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function ToolDefinitionList({ items }: { items: ThoughtContextItem[] }) {
  if (!items.length) return <p className="audit-empty">本次没有向模型提供工具。</p>;
  return (
    <div className="audit-tool-definitions">
      {items.map((item, index) => (
        <details className="audit-subnode" key={item.id}>
          <summary>
            <span>工具 {index + 1} · {toolLabel(item.referenceId ?? item.title)}</span>
            <AuditBadge tone="fixed">固定配置</AuditBadge>
          </summary>
          <div className="audit-subnode-body">
            <p>{toolDescription(item.referenceId ?? "", item.content)}</p>
            {item.metadata?.schema !== undefined && (
              <details className="audit-subnode audit-payload">
                <summary>参数约束</summary>
                <pre>{JSON.stringify(item.metadata.schema, null, 2)}</pre>
              </details>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function PersistedTurnNode({
  turn,
  run,
  onOpen,
}: {
  turn: ThoughtContextTurn;
  run?: ContextRun;
  onOpen: () => void;
}) {
  return (
    <details className="audit-node audit-previous-turn">
      <summary>
        <span className="audit-node-title">
          <strong>
            第 {turn.turnOrdinal ?? "?"} 次 Thought
          </strong>
        </span>
        <span className="audit-summary-badges">
          <AuditBadge tone="fixed">前序</AuditBadge>
          <AuditBadge tone="persisted">进入下一段 Thought 上下文</AuditBadge>
        </span>
      </summary>
      <div className="audit-node-body">
        <details className="audit-subnode" open>
          <summary>
            <span>读取的原始消息</span>
            <AuditBadge tone="persisted">{turn.messages.length} 条</AuditBadge>
          </summary>
          <div className="audit-subnode-body"><OriginalMessageList items={turn.messages} /></div>
        </details>
        {turn.thought && (
          <details className="audit-subnode audit-persisted-output" open>
            <summary>
              <span>最终思绪原文</span>
              <AuditBadge tone="persisted">进入下一段 Thought 上下文</AuditBadge>
            </summary>
            <div className="audit-subnode-body"><p>{turn.thought.content}</p></div>
          </details>
        )}
        <HistoricalExecution run={run} onOpen={onOpen} />
      </div>
    </details>
  );
}

function proposalResultCopy(proposal: ActionProposal) {
  if (proposal.delivery_status === "sent") {
    return `已发送${proposal.external_message_id ? ` · 平台消息 ${proposal.external_message_id}` : ""}`;
  }
  if (proposal.delivery_status) {
    return `发送状态：${proposal.delivery_status}${proposal.last_error_code ? ` · ${proposal.last_error_code}` : ""}`;
  }
  if (proposal.decision_outcome) {
    return `策略结果：${proposal.decision_outcome} · ${proposal.decision_reason_code ?? "无原因码"}`;
  }
  return `Proposal 状态：${proposal.status}`;
}

function CompilerCallNode({
  call,
  ordinal,
  proposals,
  finalPrimaryOutput,
  invalid,
}: {
  call: LlmCall;
  ordinal: number;
  proposals: ActionProposal[];
  finalPrimaryOutput: string | null;
  invalid: boolean;
}) {
  const instructions = call.request_context.filter((message) => message.role === "system");
  const schemaItem = call.context_items.find((item) => item.itemType === "response_schema");
  const parsed = parseJsonObject(call.response_json?.content);
  const parsedStatus = typeof parsed?.status === "string" ? parsed.status : null;
  const revisionReasons = Array.isArray(parsed?.revisionReasons)
    ? parsed.revisionReasons.map(String)
    : [];
  return (
    <details className={`audit-node audit-compiler-call${invalid ? " failed" : ""}`} open>
      <summary>
        <span className="audit-node-title">
          <span className="round-number">{ordinal}</span>
          <strong>fast 第 {ordinal} 次 · {thoughtCallStageLabel(call)}</strong>
        </span>
        <span className="audit-summary-badges">
          {invalid && <AuditBadge tone="failure">解析失败</AuditBadge>}
          <AuditBadge tone="execution">不进入主模型上下文</AuditBadge>
        </span>
      </summary>
      <div className="audit-node-body">
        <CallStats call={call} />
        <details className="audit-subnode">
          <summary>系统提示词</summary>
          <div className="audit-subnode-body">
            {instructions.map((message, index) => {
              const descriptor = describeSystemInstruction(message.content ?? "");
              return (
                <details className="audit-subnode" key={`${call.id}-instruction-${index}`}>
                  <summary>{descriptor.label}</summary>
                  <pre>{message.content}</pre>
                </details>
              );
            })}
          </div>
        </details>
        <details className="audit-subnode">
          <summary>
            <span>输出 JSON 约束</span>
            <AuditBadge tone="execution">仅 fast 模型</AuditBadge>
          </summary>
          <div className="audit-subnode-body">
            {schemaItem?.content ? (
              <pre>{JSON.stringify(parseJsonObject(schemaItem.content) ?? schemaItem.content, null, 2)}</pre>
            ) : (
              <p className="audit-empty">旧调用未单独保存 response schema；完整请求中的格式约束仍按实际载荷展示。</p>
            )}
          </div>
        </details>
        <details className="audit-subnode">
          <summary>工具调用列表</summary>
          <div className="audit-subnode-body"><p className="audit-empty">fast compiler 未提供工具。</p></div>
        </details>
        <details className="audit-subnode audit-persisted-output">
          <summary>
            <span>主模型最终思绪原文</span>
            <AuditBadge tone="persisted">compiler 输入</AuditBadge>
          </summary>
          <div className="audit-subnode-body"><p>{finalPrimaryOutput || "没有可展示的主模型最终输出。"}</p></div>
        </details>
        <RawCallPayload call={call} />
        <details className="audit-subnode">
          <summary>fast 模型返回的 JSON</summary>
          <pre>{call.response_json?.content || "（没有返回内容）"}</pre>
        </details>
        <details className="audit-subnode audit-parse-result" open>
          <summary>
            <span>解析结果</span>
            <AuditBadge tone={invalid ? "failure" : "execution"}>
              {invalid ? "校验失败" : parsedStatus ?? call.status}
            </AuditBadge>
          </summary>
          <div className="audit-subnode-body">
            {revisionReasons.length > 0 && (
              <div className="audit-revision-reasons">
                <strong>要求主模型修订</strong>
                <ul>{revisionReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              </div>
            )}
            {proposals.length > 0 ? proposals.map((proposal) => (
              <article className="audit-action" key={proposal.id}>
                <header>
                  <strong>动作 {proposal.ordinal + 1} · {actionLabel(proposal.proposal_type)}</strong>
                  <AuditBadge tone="execution">{proposal.status}</AuditBadge>
                </header>
                {typeof proposal.payload?.content === "string" && <p>{proposal.payload.content}</p>}
                <small>{proposalResultCopy(proposal)}</small>
                {proposal.last_error_message && <small>{proposal.last_error_message}</small>}
              </article>
            )) : (
              <p className="audit-empty">
                {parsedStatus === "accepted" ? "解析成功，没有动作候选。" : "本次解析没有生成已提交的动作。"}
              </p>
            )}
          </div>
        </details>
      </div>
    </details>
  );
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
  const contextOutline = useMemo(
    () => buildThoughtContextOutline(primaryContextCalls),
    [primaryContextCalls],
  );
  const systemInstructions = useMemo(() => {
    return collectPrimarySystemInstructions(detail?.calls ?? []);
  }, [detail]);
  const compilerCalls = useMemo(
    () => (detail?.calls ?? []).filter((call) => call.purpose === "compiler"),
    [detail],
  );
  const finalNaturalCall = useMemo(() => [...primaryContextCalls].reverse().find((call) => (
    call.status === "succeeded" &&
    Boolean(call.response_json?.content?.trim()) &&
    !(call.response_json?.toolCalls?.length)
  )) ?? null, [primaryContextCalls]);
  const contextRunsById = useMemo(() => new Map(
    (detail?.contextRuns ?? []).map((run) => [run.id, run]),
  ), [detail]);

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
                    <h2>
                      <LuCircle className={`run-dot state-${detail.run.status}`} aria-hidden />
                      {detail.run.status === "completed"
                        ? "Thought 已成功生成"
                        : detail.run.status === "running" ? "Thought 正在生成" : "Thought 生成失败"}
                      <small>· 会话第 {detail.run.turn_ordinal} 次 · 上下文第 {detail.run.context_epoch_ordinal} 段</small>
                    </h2>
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
                    <details className="audit-panel audit-stats-panel" open>
                      <summary>
                        <span className="audit-panel-title"><LuBrainCircuit aria-hidden /><strong>思绪统计状态</strong></span>
                        <AuditBadge tone={detail.run.status === "completed" ? "persisted" : "failure"}>
                          {stateLabel(detail.run.status)}
                        </AuditBadge>
                      </summary>
                      <div className="audit-panel-body">
                        <dl className="thought-facts">
                          <div><dt>思绪上下文段</dt><dd>第 {detail.run.context_epoch_ordinal} 段</dd></div>
                          <div><dt>会话内 Thought</dt><dd>第 {detail.run.turn_ordinal} 次</dd></div>
                          <div><dt>本次调用轮次</dt><dd>主模型 {primaryContextCalls.length} 次 · fast {compilerCalls.length} 次</dd></div>
                          <div><dt>触发原因</dt><dd>{detail.run.trigger_reason}</dd></div>
                          <div><dt>开始时间</dt><dd>{formatDateTime(detail.run.started_at)}</dd></div>
                          <div><dt>结束时间</dt><dd>{formatDateTime(detail.run.completed_at)}</dd></div>
                          <div><dt>任务尝试</dt><dd>{detail.run.job_attempt_count} / {detail.run.job_max_attempts}</dd></div>
                          <div><dt>新增消息</dt><dd>{contextOutline.currentMessages.length} 条</dd></div>
                          <div><dt>最终决策</dt><dd>{detail.run.decision ?? "没有动作"}</dd></div>
                          <div><dt>上下文状态</dt><dd>
                            {detail.run.context_epoch_ordinal < detail.run.current_epoch_ordinal
                              ? "重置前历史段" : "当前活动段"}
                          </dd></div>
                        </dl>
                      </div>
                    </details>

                    <details className="audit-panel audit-primary-panel" open>
                      <summary>
                        <span className="audit-panel-title"><LuListTree aria-hidden /><strong>主模型上下文</strong></span>
                        <span className="audit-summary-badges">
                          <AuditBadge tone="current">原始内容优先</AuditBadge>
                          <AuditBadge tone="persisted">可还原下一段 Thought 上下文</AuditBadge>
                        </span>
                      </summary>
                      <div className="audit-panel-body">
                        <div className="audit-legend">
                          <AuditBadge tone="persisted">进入下一段 Thought 上下文</AuditBadge>
                          <AuditBadge tone="persisted">进入本段后续调用上下文</AuditBadge>
                          <AuditBadge tone="fixed">固定配置</AuditBadge>
                          <AuditBadge tone="current">本次输入</AuditBadge>
                          <AuditBadge tone="execution">仅执行记录</AuditBadge>
                          <p>绿色标注表示原文已进入后续模型输入，并明确区分本段工具续轮与下一段 Thought；调用审计本身仍统一保存于 PostgreSQL。</p>
                        </div>

                        <details className="audit-node" open>
                          <summary>
                            <span className="audit-node-title"><LuShieldCheck aria-hidden /><strong>系统提示词</strong></span>
                            <AuditBadge tone="fixed">每次请求发送一次</AuditBadge>
                          </summary>
                          <div className="audit-node-body">
                            {systemInstructions.map((instruction) => (
                              <details className="audit-subnode" key={instruction.content}>
                                <summary>{instruction.label}</summary>
                                <pre>{instruction.content}</pre>
                              </details>
                            ))}
                          </div>
                        </details>

                        <details className="audit-node" open>
                          <summary>
                            <span className="audit-node-title"><LuWrench aria-hidden /><strong>工具列表</strong></span>
                            <AuditBadge tone="fixed">提供 {contextOutline.tools.length} 个</AuditBadge>
                          </summary>
                          <div className="audit-node-body"><ToolDefinitionList items={contextOutline.tools} /></div>
                        </details>

                        {contextOutline.compression.map((item) => (
                          <details className="audit-node audit-persisted-output" key={item.id}>
                            <summary>
                              <span className="audit-node-title"><strong>上一上下文段摘要</strong></span>
                              <AuditBadge tone="persisted">进入下一段 Thought 上下文</AuditBadge>
                            </summary>
                            <div className="audit-node-body"><p>{item.content}</p></div>
                          </details>
                        ))}

                        {contextOutline.initializationMessages.length > 0 && (
                          <details className="audit-node">
                            <summary>
                              <span className="audit-node-title"><strong>首次初始化读取的历史消息</strong></span>
                              <AuditBadge tone="current">仅首次输入</AuditBadge>
                            </summary>
                            <div className="audit-node-body">
                              <OriginalMessageList items={contextOutline.initializationMessages} />
                            </div>
                          </details>
                        )}

                        {contextOutline.previousTurns.map((turn) => (
                          <PersistedTurnNode
                            key={turn.thoughtRunId}
                            turn={turn}
                            run={contextRunsById.get(turn.thoughtRunId)}
                            onOpen={() => setSelectedId(turn.thoughtRunId)}
                          />
                        ))}

                        {contextOutline.unassignedHistoryMessages.length > 0 && (
                          <details className="audit-node">
                            <summary>
                              <span className="audit-node-title"><strong>旧版未分组的历史消息</strong></span>
                              <AuditBadge tone="persisted">进入下一段 Thought 上下文</AuditBadge>
                            </summary>
                            <div className="audit-node-body">
                              <OriginalMessageList items={contextOutline.unassignedHistoryMessages} />
                            </div>
                          </details>
                        )}

                        <details className="audit-node audit-current-turn" open>
                          <summary>
                            <span className="audit-node-title">
                              <LuBrainCircuit aria-hidden />
                              <strong>第 {detail.run.turn_ordinal} 次 Thought</strong>
                            </span>
                            <span className="audit-summary-badges">
                              <AuditBadge tone="current">本次</AuditBadge>
                              <AuditBadge tone="persisted">成功后进入下一段 Thought 上下文</AuditBadge>
                            </span>
                          </summary>
                          <div className="audit-node-body">
                            <details className="audit-subnode" open>
                              <summary>
                                <span>读取到的原始消息</span>
                                <AuditBadge tone="current">{contextOutline.currentMessages.length} 条</AuditBadge>
                              </summary>
                              <div className="audit-subnode-body">
                                <OriginalMessageList items={contextOutline.currentMessages} />
                              </div>
                            </details>

                            <details className="audit-subnode">
                              <summary>
                                <span>被动记忆召回</span>
                                <span className="audit-summary-badges">
                                  <AuditBadge tone="current">本次输入</AuditBadge>
                                  {!contextOutline.recalledMemories.length && <AuditBadge tone="fixed">尚未实现</AuditBadge>}
                                </span>
                              </summary>
                              <div className="audit-subnode-body">
                                {contextOutline.recalledMemories.length ? contextOutline.recalledMemories.map((item) => (
                                  <article className="audit-memory" key={item.id}>
                                    <strong>{item.title}</strong><p>{item.content}</p>
                                  </article>
                                )) : <p className="audit-empty">本次没有被动召回记忆；审核记忆库仍未接入运行时。</p>}
                              </div>
                            </details>

                            <div className="audit-call-stack">
                              {primaryContextCalls.map((call, index) => (
                                <PrimaryCallNode
                                  key={call.id}
                                  call={call}
                                  calls={primaryContextCalls}
                                  ordinal={index + 1}
                                />
                              ))}
                            </div>

                            <details className="audit-subnode audit-persisted-output" open>
                              <summary>
                                <span>最后一轮思绪输出</span>
                                <AuditBadge tone="persisted">原文进入下一段 Thought 上下文</AuditBadge>
                              </summary>
                              <div className="audit-subnode-body">
                                <p>{finalNaturalCall?.response_json?.content || "尚未形成可提交的最终思绪。"}</p>
                              </div>
                            </details>
                          </div>
                        </details>
                      </div>
                    </details>

                    <details className="audit-panel audit-fast-panel" open>
                      <summary>
                        <span className="audit-panel-title"><LuMessageSquareText aria-hidden /><strong>快速模型上下文</strong></span>
                        <AuditBadge tone="execution">不进入主模型上下文</AuditBadge>
                      </summary>
                      <div className="audit-panel-body">
                        {compilerCalls.length ? compilerCalls.map((call, index) => (
                          <CompilerCallNode
                            key={call.id}
                            call={call}
                            ordinal={index + 1}
                            proposals={detail.proposals.filter((proposal) => (
                              proposal.compiler_llm_call_id === call.id
                            ))}
                            finalPrimaryOutput={finalNaturalCall?.response_json?.content ?? null}
                            invalid={detail.run.compiler_state?.invalidCallIds?.includes(call.id) ?? false}
                          />
                        )) : <p className="audit-empty">本次尚未执行 fast compiler。</p>}
                      </div>
                    </details>
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
