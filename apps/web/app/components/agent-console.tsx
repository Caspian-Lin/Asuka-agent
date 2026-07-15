"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ImChannelPage from "@/app/components/im-channel-page";
import JobsPage from "@/app/components/jobs-page";

type ViewKey =
  | "chat"
  | "channels"
  | "thoughts"
  | "memories"
  | "jobs"
  | "evaluation"
  | "settings";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: string[];
  createdAt: string;
};

type Memory = {
  id: string;
  memoryType: string;
  title: string;
  content: string;
  status: "candidate" | "active" | "rejected" | "archived";
  sourceType: string;
  confidence: number;
  importance: number;
  retrieveCount: number;
  helpfulUseCount: number;
  lastRetrievedAt?: string | null;
  updatedAt: string;
};

type Thought = {
  id: string;
  kind: string;
  content: string;
  evidenceIds: string[];
  confidence: number;
  novelty: number;
  urgency: number;
  expectedValue: number;
  risk: number;
  decision: string;
  humanLabel?: "send_now" | "defer" | "silent" | null;
  expiresAt: string;
  createdAt: string;
};

type AgentEvent = {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type EvaluationCase = {
  id: string;
  category: string;
  prompt: string;
  expected: Record<string, unknown>;
  tags: string[];
};

type EvaluationResult = {
  caseId: string;
  predicted: { memoryIds?: string[]; abstained?: boolean };
  metrics: { topScore?: number; hitAt3?: number };
  score: number;
  passed: boolean;
};

type Snapshot = {
  agent: { name: string; description: string; mode: string };
  conversation: { title: string; channel: string };
  settings: {
    shadowMode: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    dailyProactiveBudget: number;
    modelMode: string;
  };
  messages: Message[];
  memories: Memory[];
  thoughts: Thought[];
  events: AgentEvent[];
  evaluation: {
    suite: string;
    cases: EvaluationCase[];
    latestRun: null | {
      id: string;
      status: string;
      startedAt: string;
      summary: { total?: number; passed?: number; accuracy?: number };
      results: EvaluationResult[];
    };
  };
  metrics: {
    activeMemories: number;
    candidateMemories: number;
    labeledThoughts: number;
    totalThoughts: number;
    evaluationAccuracy: number | null;
    eventCount: number;
  };
};

const navItems: Array<{ key: ViewKey; label: string; glyph: string }> = [
  { key: "chat", label: "对话", glyph: "⌁" },
  { key: "channels", label: "IM Channel", glyph: "◎" },
  { key: "thoughts", label: "思绪", glyph: "◌" },
  { key: "memories", label: "记忆", glyph: "◇" },
  { key: "jobs", label: "定时任务", glyph: "◷" },
  { key: "evaluation", label: "评测", glyph: "↗" },
  { key: "settings", label: "设置", glyph: "⊙" },
];

const memoryTypeLabel: Record<string, string> = {
  preference: "偏好",
  goal: "目标",
  profile: "档案",
  prospective: "未来事项",
};

const thoughtKindLabel: Record<string, string> = {
  suggestion: "建议",
  follow_up: "跟进",
  memory_review: "记忆复核",
};

const eventLabel: Record<string, string> = {
  message_received: "收到消息",
  memory_retrieved: "召回记忆",
  memory_candidate_created: "生成候选记忆",
  shadow_thought_created: "生成 Shadow 思绪",
  agent_replied: "回复完成",
  memory_reviewed: "记忆已复核",
  thought_labeled: "思绪已标注",
  evaluation_completed: "评测完成",
};

function formatTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

async function requestSnapshot(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const payload = (await response.json()) as Snapshot | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : "操作失败");
  }
  return payload as Snapshot;
}

function ScoreBar({ label, value, tone = "lavender" }: { label: string; value: number; tone?: "lavender" | "cyan" | "rose" }) {
  return (
    <div className="score-row">
      <div className="score-label"><span>{label}</span><strong>{percent(value)}</strong></div>
      <div className="score-track"><span className={`score-fill ${tone}`} style={{ width: percent(value) }} /></div>
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="empty-state">
      <span className="empty-orbit">◌</span>
      <h3>{title}</h3>
      <p>{copy}</p>
    </div>
  );
}

export default function AgentConsole() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [activeView, setActiveView] = useState<ViewKey>("chat");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryFilter, setMemoryFilter] = useState<"all" | "candidate" | "active">("all");
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestSnapshot("/api/bootstrap")
      .then(setSnapshot)
      .catch((reason: Error) => setError(reason.message));
  }, []);

  useEffect(() => {
    if (activeView === "chat") {
      messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeView, snapshot?.messages.length]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const memoryById = useMemo(
    () => new Map(snapshot?.memories.map((memory) => [memory.id, memory]) ?? []),
    [snapshot?.memories],
  );

  const filteredMemories = useMemo(() => {
    const query = memoryQuery.trim().toLowerCase();
    return (snapshot?.memories ?? []).filter((memory) => {
      const matchesFilter = memoryFilter === "all" || memory.status === memoryFilter;
      const matchesQuery = !query || `${memory.title} ${memory.content}`.toLowerCase().includes(query);
      return matchesFilter && matchesQuery;
    });
  }, [memoryFilter, memoryQuery, snapshot?.memories]);

  async function mutate(key: string, path: string, init: RequestInit, success: string) {
    setBusy(key);
    setError(null);
    try {
      setSnapshot(await requestSnapshot(path, init));
      setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    await mutate(
      "send",
      "/api/messages",
      { method: "POST", body: JSON.stringify({ content }) },
      "本轮事件、记忆和思绪已记录",
    );
  }

  function reviewMemory(id: string, action: "accept" | "reject" | "archive") {
    return mutate(
      `memory-${id}`,
      "/api/memories",
      { method: "PATCH", body: JSON.stringify({ id, action }) },
      action === "accept" ? "候选记忆已接受" : action === "reject" ? "候选记忆已拒绝" : "记忆已归档",
    );
  }

  function labelThought(id: string, label: "send_now" | "defer" | "silent") {
    return mutate(
      `thought-${id}`,
      "/api/thoughts",
      { method: "PATCH", body: JSON.stringify({ id, label }) },
      "思绪标签已保存，可用于后续策略训练",
    );
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutate(
      "settings",
      "/api/settings",
      {
        method: "PATCH",
        body: JSON.stringify({
          shadowMode: values.get("shadowMode") === "on",
          quietHoursStart: values.get("quietHoursStart"),
          quietHoursEnd: values.get("quietHoursEnd"),
          dailyProactiveBudget: Number(values.get("dailyProactiveBudget")),
        }),
      },
      "策略设置已更新",
    );
  }

  function resetDemo() {
    if (!window.confirm("确认恢复演示初始数据？当前新增内容会被清除。")) return;
    void mutate("reset", "/api/reset", { method: "POST" }, "演示数据已恢复");
  }

  if (!snapshot) {
    return (
      <main className="loading-screen">
        <div className="loading-cat"><span>⌒</span><i /></div>
        <p>{error ? `载入失败：${error}` : "正在载入 Asuka Agent…"}</p>
        {error && <button onClick={() => window.location.reload()}>重新载入</button>}
      </main>
    );
  }

  const latestThought = snapshot.thoughts[0];
  const latestRetrieval = snapshot.events.find((event) => event.eventType === "memory_retrieved");
  const retrievedIds = Array.isArray(latestRetrieval?.payload.memoryIds)
    ? (latestRetrieval.payload.memoryIds as string[])
    : [];
  const contextUsed = Math.min(92, 18 + snapshot.messages.length * 3 + snapshot.memories.length * 2);

  return (
    <main className="agent-shell">
      <aside className="side-rail">
        <button className="brand" onClick={() => setActiveView("chat")} aria-label="返回对话">
          <span className="brand-mark"><i /><b>A</b></span>
          <span><strong>Asuka</strong><small>Agent</small></span>
        </button>

        <nav className="primary-nav" aria-label="主要导航">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={activeView === item.key ? "active" : ""}
              onClick={() => setActiveView(item.key)}
              aria-current={activeView === item.key ? "page" : undefined}
            >
              <span>{item.glyph}</span>{item.label}
              {item.key === "memories" && snapshot.metrics.candidateMemories > 0 && (
                <em>{snapshot.metrics.candidateMemories}</em>
              )}
            </button>
          ))}
        </nav>

        <div className="rail-note">
          <div className="rail-note-head"><span>上下文预算</span><strong>{contextUsed}%</strong></div>
          <div className="budget-track"><span style={{ width: `${contextUsed}%` }} /></div>
          <p>{snapshot.metrics.activeMemories} 条有效记忆 · {snapshot.metrics.eventCount} 个近期事件</p>
        </div>
      </aside>

      <section className="workbench">
        <header className="top-bar">
          <div className="mobile-brand"><span className="brand-mark"><i /><b>A</b></span><strong>Asuka</strong></div>
          <div className="top-context">
            <span className="eyebrow">{snapshot.conversation.channel} channel</span>
            <strong>{snapshot.conversation.title}</strong>
          </div>
          <div className={`mode-pill ${snapshot.settings.shadowMode ? "shadow" : "review"}`}>
            <span />MVP · {snapshot.settings.shadowMode ? "Shadow Mode" : "Review Mode"}
          </div>
        </header>

        <nav className="mobile-nav" aria-label="移动端导航">
          {navItems.map((item) => (
            <button key={item.key} className={activeView === item.key ? "active" : ""} onClick={() => setActiveView(item.key)}>
              <span>{item.glyph}</span>{item.label}
            </button>
          ))}
        </nav>

        {activeView === "chat" && (
          <div className="chat-grid">
            <section className="conversation-panel">
              <div className="section-heading conversation-heading">
                <div><span className="section-kicker">Conversation</span><h1>把认知过程变得可见</h1></div>
                <span className="online-note"><i /> 本地确定性引擎</span>
              </div>

              <div className="message-stream" aria-live="polite">
                <div className="day-divider"><span>第一阶段 · 可审查运行</span></div>
                {snapshot.messages.map((message) => (
                  <article key={message.id} className={`message ${message.role}`}>
                    {message.role === "assistant" && <span className="avatar agent-avatar">A</span>}
                    <div className="message-body">
                      <div className="message-meta">
                        <strong>{message.role === "assistant" ? snapshot.agent.name : "你"}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <p>{message.content}</p>
                      {message.citations.length > 0 && (
                        <div className="citation-row">
                          <span>依据</span>
                          {message.citations.map((id) => (
                            <button key={id} onClick={() => setActiveView("memories")}>
                              ◇ {memoryById.get(id)?.title ?? id.slice(0, 8)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {message.role === "user" && <span className="avatar user-avatar">你</span>}
                  </article>
                ))}
                <div ref={messageEndRef} />
              </div>

              <div className="composer-wrap">
                <div className="quick-prompts">
                  {["你记得我的界面偏好吗？", "我正在做一个主动聊天 Agent", "帮我运行一次评测"].map((prompt) => (
                    <button key={prompt} onClick={() => setDraft(prompt)}>{prompt}</button>
                  ))}
                </div>
                <form className="composer" onSubmit={sendMessage}>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder="告诉 Asuka Agent 一个偏好、目标，或问它记得什么…"
                    rows={2}
                    maxLength={4000}
                    aria-label="输入消息"
                  />
                  <div className="composer-foot">
                    <span>Enter 发送 · Shift + Enter 换行</span>
                    <button className="send-button" disabled={!draft.trim() || busy === "send"}>
                      {busy === "send" ? "处理中" : "发送"}<b>↗</b>
                    </button>
                  </div>
                </form>
              </div>
            </section>

            <aside className="cognition-panel">
              <div className="section-heading compact">
                <div><span className="section-kicker">Cognition trace</span><h2>此刻的认知活动</h2></div>
                <span className="pulse-dot" aria-label="实时更新" />
              </div>

              <article className="trace-card recall-card">
                <div className="trace-title"><span className="trace-icon cyan">◇</span><div><strong>记忆召回</strong><small>{latestRetrieval ? formatTime(latestRetrieval.createdAt) : "尚未发生"}</small></div></div>
                {retrievedIds.length > 0 ? retrievedIds.map((id) => {
                  const memory = memoryById.get(id);
                  return memory ? (
                    <button className="mini-memory" key={id} onClick={() => setActiveView("memories")}>
                      <span><em>{memoryTypeLabel[memory.memoryType] ?? memory.memoryType}</em><strong>{memory.title}</strong></span>
                      <small>置信 {percent(memory.confidence)}</small>
                    </button>
                  ) : null;
                }) : <p className="muted-copy">当前没有高相关记忆，系统选择不强行补全。</p>}
              </article>

              {latestThought && (
                <article className="trace-card thought-card">
                  <div className="trace-title"><span className="trace-icon rose">◌</span><div><strong>Shadow 思绪</strong><small>{thoughtKindLabel[latestThought.kind] ?? latestThought.kind}</small></div><span className="shadow-tag">未发送</span></div>
                  <blockquote>“{latestThought.content}”</blockquote>
                  <ScoreBar label="预期价值" value={latestThought.expectedValue} />
                  <ScoreBar label="风险" value={latestThought.risk} tone="rose" />
                  <button className="text-action" onClick={() => setActiveView("thoughts")}>标注这条思绪 <span>→</span></button>
                </article>
              )}

              <article className="trace-card pipeline-card">
                <div className="trace-title"><span className="trace-icon lavender">⌁</span><div><strong>本轮流水线</strong><small>由 correlation id 串联</small></div></div>
                <ol>
                  {snapshot.events.slice(0, 5).reverse().map((event, index) => (
                    <li key={event.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{eventLabel[event.eventType] ?? event.eventType}</strong><small>{formatTime(event.createdAt)}</small></div></li>
                  ))}
                </ol>
              </article>
            </aside>
          </div>
        )}

        {activeView === "channels" && <ImChannelPage />}

        {activeView === "thoughts" && (
          <section className="page-panel">
            <div className="page-hero">
              <div><span className="section-kicker">Shadow dataset</span><h1>思绪标注台</h1><p>所有主动发言候选先留在影子模式；你的标签会成为后续策略模型的训练数据。</p></div>
              <div className="hero-stat"><strong>{snapshot.metrics.labeledThoughts}/{snapshot.metrics.totalThoughts}</strong><span>已标注</span></div>
            </div>
            <div className="thought-list">
              {snapshot.thoughts.length === 0 ? <EmptyState title="还没有思绪" copy="发送一条消息后，认知流水线会生成首条 Shadow 思绪。" /> : snapshot.thoughts.map((thought) => (
                <article className="thought-item" key={thought.id}>
                  <div className="item-topline">
                    <span className="kind-pill">◌ {thoughtKindLabel[thought.kind] ?? thought.kind}</span>
                    <span>{formatDateTime(thought.createdAt)} · {thought.decision}</span>
                  </div>
                  <h2>{thought.content}</h2>
                  <div className="score-grid">
                    <ScoreBar label="置信" value={thought.confidence} />
                    <ScoreBar label="新颖" value={thought.novelty} tone="cyan" />
                    <ScoreBar label="紧迫" value={thought.urgency} tone="rose" />
                    <ScoreBar label="价值" value={thought.expectedValue} />
                  </div>
                  <div className="thought-footer">
                    <span>风险 {percent(thought.risk)} · {thought.evidenceIds.length} 条依据 · {thought.humanLabel ? `已标注：${thought.humanLabel}` : "等待人工标签"}</span>
                    <div className="segmented-actions" aria-label="思绪标签">
                      {([ ["send_now", "应发送"], ["defer", "稍后"], ["silent", "静默"] ] as const).map(([value, label]) => (
                        <button key={value} className={thought.humanLabel === value ? "selected" : ""} disabled={busy === `thought-${thought.id}`} onClick={() => labelThought(thought.id, value)}>{label}</button>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {activeView === "memories" && (
          <section className="page-panel">
            <div className="page-hero memory-hero">
              <div><span className="section-kicker">Evidence first</span><h1>长期记忆</h1><p>事实、偏好与目标先作为候选进入审查；原始事件永远保留为证据层。</p></div>
              <div className="dual-stat"><span><strong>{snapshot.metrics.activeMemories}</strong>有效</span><i /><span><strong>{snapshot.metrics.candidateMemories}</strong>待审</span></div>
            </div>
            <div className="memory-toolbar">
              <label className="search-field"><span>⌕</span><input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="搜索记忆内容" /></label>
              <div className="filter-tabs">
                {([ ["all", "全部"], ["candidate", "待审"], ["active", "有效"] ] as const).map(([value, label]) => <button key={value} className={memoryFilter === value ? "active" : ""} onClick={() => setMemoryFilter(value)}>{label}</button>)}
              </div>
            </div>
            <div className="memory-grid">
              {filteredMemories.length === 0 ? <EmptyState title="没有匹配的记忆" copy="换个关键词，或在对话中明确说“请记住……”生成候选。" /> : filteredMemories.map((memory) => (
                <article className={`memory-card status-${memory.status}`} key={memory.id}>
                  <div className="item-topline"><span className="memory-type">◇ {memoryTypeLabel[memory.memoryType] ?? memory.memoryType}</span><span className={`status-label ${memory.status}`}>{memory.status === "candidate" ? "待审" : memory.status === "active" ? "有效" : memory.status === "rejected" ? "已拒绝" : "已归档"}</span></div>
                  <h2>{memory.title}</h2><p>{memory.content}</p>
                  <div className="memory-signals"><span>置信 <strong>{percent(memory.confidence)}</strong></span><span>重要 <strong>{percent(memory.importance)}</strong></span><span>召回 <strong>{memory.retrieveCount}</strong></span></div>
                  <div className="memory-card-foot"><small>{memory.sourceType} · 更新于 {formatDateTime(memory.updatedAt)}</small><div>
                    {memory.status === "candidate" && <><button className="ghost-button reject" disabled={busy === `memory-${memory.id}`} onClick={() => reviewMemory(memory.id, "reject")}>拒绝</button><button className="primary-button small" disabled={busy === `memory-${memory.id}`} onClick={() => reviewMemory(memory.id, "accept")}>接受</button></>}
                    {memory.status === "active" && <button className="ghost-button" disabled={busy === `memory-${memory.id}`} onClick={() => reviewMemory(memory.id, "archive")}>归档</button>}
                  </div></div>
                </article>
              ))}
            </div>
          </section>
        )}

        {activeView === "evaluation" && (
          <section className="page-panel">
            <div className="page-hero">
              <div><span className="section-kicker">Regression harness</span><h1>第一阶段评测</h1><p>固定样本覆盖事实召回、目标召回和未知信息拒答；每次运行都保存输入、预测和分数。</p></div>
              <button className="primary-button" disabled={busy === "evaluation"} onClick={() => mutate("evaluation", "/api/evaluations", { method: "POST" }, "评测运行完成")}>{busy === "evaluation" ? "运行中…" : "运行评测"}<span>↗</span></button>
            </div>
            <div className="metric-strip">
              <article><span>准确率</span><strong>{snapshot.evaluation.latestRun ? percent(snapshot.evaluation.latestRun.summary.accuracy ?? 0) : "—"}</strong><small>phase1-memory-smoke</small></article>
              <article><span>样本数</span><strong>{snapshot.evaluation.cases.length}</strong><small>版本化固定集</small></article>
              <article><span>通过</span><strong>{snapshot.evaluation.latestRun?.summary.passed ?? "—"}</strong><small>Hit@3 / abstain</small></article>
              <article><span>最近运行</span><strong className="date-stat">{snapshot.evaluation.latestRun ? formatDateTime(snapshot.evaluation.latestRun.startedAt) : "未运行"}</strong><small>结果持久保存</small></article>
            </div>
            <div className="evaluation-table-wrap">
              <div className="table-title"><div><h2>评测样本</h2><p>期望值与检索预测逐条对照</p></div><span>{snapshot.evaluation.suite}</span></div>
              <div className="evaluation-table" role="table">
                <div className="evaluation-row header" role="row"><span>类别</span><span>输入</span><span>期望</span><span>结果</span></div>
                {snapshot.evaluation.cases.map((testCase) => {
                  const result = snapshot.evaluation.latestRun?.results.find((item) => item.caseId === testCase.id);
                  const expectedMemory = typeof testCase.expected.expectedMemoryId === "string" ? memoryById.get(testCase.expected.expectedMemoryId) : null;
                  return <div className="evaluation-row" role="row" key={testCase.id}>
                    <span><em>{testCase.category}</em><small>{testCase.tags.join(" · ")}</small></span>
                    <span>{testCase.prompt}</span>
                    <span>{testCase.expected.abstain ? "应拒答 / 不召回" : expectedMemory?.title ?? String(testCase.expected.expectedMemoryId ?? "—")}</span>
                    <span>{result ? <b className={result.passed ? "pass" : "fail"}>{result.passed ? "通过" : "未通过"}<small>top {result.metrics.topScore?.toFixed(2) ?? "0.00"}</small></b> : <b className="pending">待运行</b>}</span>
                  </div>;
                })}
              </div>
            </div>
          </section>
        )}

        {activeView === "jobs" && <JobsPage />}

        {activeView === "settings" && (
          <section className="page-panel settings-page">
            <div className="page-hero"><div><span className="section-kicker">Policy controls</span><h1>运行策略</h1><p>第一阶段默认禁止自主外发；先通过人工复核积累安全、可解释的决策数据。</p></div></div>
            <form className="settings-grid" onSubmit={saveSettings}>
              <article className="settings-card wide">
                <div><span className="settings-icon">◌</span><div><h2>Shadow Mode</h2><p>生成思绪与发送决策，但不对外主动发言。</p></div></div>
                <label className="switch"><input name="shadowMode" type="checkbox" defaultChecked={snapshot.settings.shadowMode} /><span /></label>
              </article>
              <article className="settings-card"><div><span className="settings-icon cyan">☾</span><div><h2>安静时段</h2><p>即使未来允许主动发送，也应避免打扰。</p></div></div><div className="time-range"><label>开始<input name="quietHoursStart" type="time" defaultValue={snapshot.settings.quietHoursStart} /></label><span>→</span><label>结束<input name="quietHoursEnd" type="time" defaultValue={snapshot.settings.quietHoursEnd} /></label></div></article>
              <article className="settings-card"><div><span className="settings-icon rose">↗</span><div><h2>每日主动预算</h2><p>限制主动触达次数，避免“人格感”退化成打扰。</p></div></div><label className="budget-input"><input name="dailyProactiveBudget" type="number" min="0" max="20" defaultValue={snapshot.settings.dailyProactiveBudget} /><span>次 / 天</span></label></article>
              <article className="settings-card"><div><span className="settings-icon">⌁</span><div><h2>推理适配器</h2><p>MVP 不依赖外部密钥，可稳定复现数据链路。</p></div></div><div className="read-only-value"><span className="status-dot" />{snapshot.settings.modelMode}</div></article>
              <article className="settings-card danger-zone"><div><span className="settings-icon rose">↺</span><div><h2>恢复演示数据</h2><p>清除本次实验新增内容，回到三个固定评测样本。</p></div></div><button type="button" className="ghost-button reject" onClick={resetDemo} disabled={busy === "reset"}>{busy === "reset" ? "恢复中…" : "恢复初始状态"}</button></article>
              <div className="settings-submit"><span>策略变更会保存在 D1，并在下一轮生效。</span><button className="primary-button" disabled={busy === "settings"}>{busy === "settings" ? "保存中…" : "保存设置"}</button></div>
            </form>
          </section>
        )}
      </section>

      {(notice || error) && <div className={`toast ${error ? "error" : "success"}`} role="status"><span>{error ? "!" : "✓"}</span>{error ?? notice}<button onClick={() => { setError(null); setNotice(null); }}>×</button></div>}
    </main>
  );
}
