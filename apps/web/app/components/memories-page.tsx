"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { controlRequest } from "./control-api";

type MemoryCandidate = {
  id: string;
  operation: string;
  subject_id: string | null;
  source_speaker_id: string;
  source_speaker_name: string;
  claim: string;
  evidence_message_ids: string[];
  confidence_millis: number;
  attribution_status: string;
  target_candidate_id: string | null;
  status: string;
  prompt_version: string;
  thought_run_id: string;
  thought_summary: string | null;
  trigger_type: string;
  trigger_reason: string;
  conversation_id: string;
  conversation_title: string;
  created_at: string;
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function MemoriesPage({
  onOpenThought,
}: {
  onOpenThought: (thoughtRunId: string) => void;
}) {
  const [memories, setMemories] = useState<MemoryCandidate[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "pending_review" | "unresolved">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await controlRequest<{ memories: MemoryCandidate[] }>("/api/memories");
      setMemories(payload.memories);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "记忆候选载入失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return memories.filter((memory) => {
      const matchesQuery = !normalized || `${memory.claim} ${memory.source_speaker_name} ${memory.conversation_title}`.toLowerCase().includes(normalized);
      const matchesFilter = filter === "all" ||
        (filter === "unresolved" ? memory.attribution_status === "unresolved" : memory.status === filter);
      return matchesQuery && matchesFilter;
    });
  }, [filter, memories, query]);

  const unresolvedCount = memories.filter((memory) => memory.attribution_status === "unresolved").length;

  return (
    <section className="page-panel memories-page">
      <div className="page-hero memory-hero">
        <div><span className="section-kicker">PostgreSQL · review candidates</span><h1>长期记忆</h1><p>当前只生成待审候选，不会自动激活或召回。每条候选都必须关联产生它的思绪运行、来源说话人和证据消息。</p></div>
        <div className="dual-stat"><span><strong>{memories.length}</strong>候选</span><i /><span><strong>{unresolvedCount}</strong>归因待定</span></div>
      </div>

      <div className="memory-boundary-note"><strong>当前边界</strong><span>候选生成已接入真实模型；正式记忆库、激活审核与召回排序尚未实现。</span></div>
      {error && <div className="inline-error">{error} <button onClick={() => void load()}>重试</button></div>}

      <div className="memory-toolbar">
        <label className="search-field"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索候选、说话人或会话" /></label>
        <div className="filter-tabs">
          {([ ["all", "全部"], ["pending_review", "待审"], ["unresolved", "归因待定"] ] as const).map(([value, label]) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="jobs-skeleton" aria-label="正在载入记忆"><i /><i /><i /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state"><span className="empty-orbit">◇</span><h3>没有匹配的真实记忆候选</h3><p>memory_consolidation 处理到新的 QQ 消息并找到可靠事实后，候选会出现在这里。</p></div>
      ) : (
        <div className="memory-candidate-list">
          {filtered.map((memory) => (
            <article key={memory.id}>
              <header>
                <span className="memory-type">◇ {memory.operation}</span>
                <span className={`status-label ${memory.status}`}>{memory.status === "pending_review" ? "待审" : memory.status}</span>
              </header>
              <h2>{memory.claim}</h2>
              <dl>
                <div><dt>来源说话人</dt><dd>{memory.source_speaker_name} · {memory.source_speaker_id}</dd></div>
                <div><dt>事实主体</dt><dd>{memory.subject_id ?? "未解析，不自动归属"}</dd></div>
                <div><dt>归因状态</dt><dd>{memory.attribution_status}</dd></div>
                <div><dt>置信度</dt><dd>{Math.round(memory.confidence_millis / 10)}%</dd></div>
              </dl>
              <div className="memory-evidence"><span>证据消息</span>{memory.evidence_message_ids.map((id) => <code key={id}>{id}</code>)}</div>
              <footer>
                <span>{memory.conversation_title} · {formatDateTime(memory.created_at)}</span>
                <button className="ghost-button" onClick={() => onOpenThought(memory.thought_run_id)}>查看来源思绪</button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
