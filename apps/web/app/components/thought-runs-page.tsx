"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LuBrainCircuit,
  LuCircle,
  LuFileInput,
  LuListTree,
  LuMessageSquareText,
} from "react-icons/lu";
import { controlRequest } from "./control-api";

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
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  thought_count: number;
  candidate_count: number;
};

type ContextItem = {
  id: string;
  ordinal: number;
  itemType: string;
  referenceId: string | null;
  title: string;
  content: string | null;
  metadata: Record<string, unknown>;
};

type LlmCall = {
  id: string;
  sequence_number: number;
  profile: string;
  provider: string;
  model: string | null;
  prompt_version: string;
  status: string;
  error_code: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  request_context: Array<{ role: string; content: string }>;
  response_json: { content?: string } | null;
  context_items: ContextItem[];
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

function responseText(call: LlmCall) {
  const content = call.response_json?.content;
  if (!content) return call.error_code ? `调用失败：${call.error_code}` : "模型没有返回可展示内容";
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
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

  const loadRuns = useCallback(async () => {
    try {
      const payload = await controlRequest<{ thoughtRuns: ThoughtRun[] }>("/api/thought-runs");
      setRuns(payload.thoughtRuns);
      setSelectedId((current) => current ?? payload.thoughtRuns[0]?.id ?? null);
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

  const totals = useMemo(() => runs.reduce(
    (summary, run) => ({
      calls: summary.calls + run.call_count,
      tokens: summary.tokens + run.input_tokens + run.output_tokens,
    }),
    { calls: 0, tokens: 0 },
  ), [runs]);

  return (
    <section className="page-panel thought-runs-page">
      <div className="page-hero">
        <div><span className="page-context">Cognition trace</span><h1>思绪运行</h1><p>一次思绪从触发原因开始，串联一轮或多轮模型调用、上下文、记忆及外部来源。这里展示可审计结果，不承担数据标注。</p></div>
        <div className="dual-stat"><span><strong>{runs.length}</strong>次运行</span><i /><span><strong>{totals.tokens}</strong>tokens</span></div>
      </div>

      {error && <div className="inline-error">{error} <button onClick={() => void loadRuns()}>重试</button></div>}
      {loading ? (
        <div className="jobs-skeleton" aria-label="正在载入思绪"><i /><i /><i /></div>
      ) : runs.length === 0 ? (
        <div className="empty-state"><LuBrainCircuit className="empty-icon" aria-hidden /><h3>还没有真实思绪运行</h3><p>定时任务处理到新的 QQ 消息后，会在这里留下触发、模型轮次和引用记录。</p></div>
      ) : (
        <div className="thought-workspace">
          <div className="thought-run-list" aria-label="思绪运行列表">
            {runs.map((run) => (
              <button
                className={run.id === selectedId ? "selected" : ""}
                key={run.id}
                onClick={() => setSelectedId(run.id)}
              >
                <LuCircle className={`run-dot state-${run.status}`} aria-hidden />
                <span><strong>{run.summary ?? "运行未产生结论"}</strong><small>{run.conversation_title} · {triggerLabel(run.trigger_type)}</small></span>
                <span><strong>{run.call_count} 轮</strong><small>{run.input_tokens + run.output_tokens} tokens</small></span>
                <time>{formatDateTime(run.started_at)}</time>
              </button>
            ))}
          </div>

          <aside className="thought-inspector" aria-live="polite">
            {!detail || detail.run.id !== selectedId ? (
              <div className="run-loading"><i /><i /><i /></div>
            ) : (
              <>
                <header>
                  <div><span>{triggerLabel(detail.run.trigger_type)}</span><h2>{detail.run.summary ?? "无结论"}</h2></div>
                  <span className={`run-state state-${detail.run.status}`}>{detail.run.status}</span>
                </header>
                <div className="thought-inspector-body">
                  <dl className="thought-facts">
                    <div><dt>触发原因</dt><dd>{detail.run.trigger_reason}</dd></div>
                    <div><dt>会话</dt><dd>{detail.run.conversation_title}</dd></div>
                    <div><dt>开始时间</dt><dd>{formatDateTime(detail.run.started_at)}</dd></div>
                    <div><dt>结束时间</dt><dd>{formatDateTime(detail.run.completed_at)}</dd></div>
                    <div><dt>模型调用</dt><dd>{detail.calls.length} 轮</dd></div>
                    <div><dt>决策</dt><dd>{detail.run.decision ?? "—"}</dd></div>
                  </dl>

                  {detail.calls.map((call) => (
                    <section className="thought-round" key={call.id}>
                      <header>
                        <div><LuBrainCircuit aria-hidden /><strong>第 {call.sequence_number} 轮模型调用</strong><small>{call.profile} · {call.model ?? call.provider}</small></div>
                        <span>{call.input_tokens ?? 0} in / {call.output_tokens ?? 0} out · {call.latency_ms ?? 0} ms</span>
                      </header>

                      <div className="context-reference-list">
                        <h3>引用与输入来源</h3>
                        {call.context_items.length === 0 ? <p>旧运行没有保存结构化来源。</p> : call.context_items.map((item) => (
                          <article key={item.id}>
                            <span><LuFileInput aria-hidden />{item.itemType === "message" ? "消息" : item.itemType === "memory_candidate" ? "候选记忆" : item.itemType}</span>
                            <div><strong>{item.title}</strong>{item.content && <p>{item.content}</p>}<small>{item.referenceId ?? "无引用 ID"}</small></div>
                          </article>
                        ))}
                      </div>

                      <details className="model-context">
                        <summary><LuListTree aria-hidden />查看本轮完整模型上下文</summary>
                        {call.request_context.map((message, index) => (
                          <article key={`${call.id}-message-${index}`}><span>{message.role}</span><pre>{message.content}</pre></article>
                        ))}
                      </details>

                      <details className="model-output">
                        <summary><LuMessageSquareText aria-hidden />查看本轮模型输出</summary>
                        <pre>{responseText(call)}</pre>
                      </details>
                    </section>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
