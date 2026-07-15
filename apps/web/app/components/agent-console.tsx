"use client";

import { useState } from "react";
import ImChannelPage from "@/app/components/im-channel-page";
import JobsPage from "@/app/components/jobs-page";
import LlmSettingsPanel from "@/app/components/llm-settings-panel";
import MemoriesPage from "@/app/components/memories-page";
import ThoughtRunsPage from "@/app/components/thought-runs-page";

type ViewKey = "channels" | "thoughts" | "memories" | "jobs" | "settings";

const navItems: Array<{ key: ViewKey; label: string; glyph: string }> = [
  { key: "channels", label: "IM Channel", glyph: "◎" },
  { key: "thoughts", label: "思绪", glyph: "◌" },
  { key: "memories", label: "记忆", glyph: "◇" },
  { key: "jobs", label: "定时任务", glyph: "◷" },
  { key: "settings", label: "设置", glyph: "⊙" },
];

export default function AgentConsole() {
  const [activeView, setActiveView] = useState<ViewKey>("channels");
  const [requestedThoughtRunId, setRequestedThoughtRunId] = useState<string | null>(null);

  function openThought(thoughtRunId: string) {
    setRequestedThoughtRunId(thoughtRunId);
    setActiveView("thoughts");
  }

  return (
    <main className="agent-shell">
      <aside className="side-rail">
        <button className="brand" onClick={() => setActiveView("channels")} aria-label="返回 IM Channel">
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
            </button>
          ))}
        </nav>

        <div className="rail-note database-note">
          <div className="rail-note-head"><span>唯一数据源</span><strong>PostgreSQL</strong></div>
          <p>QQ 消息、思绪、模型调用和记忆候选统一持久化。</p>
        </div>
      </aside>

      <section className="workbench">
        <nav className="mobile-nav" aria-label="移动端导航">
          {navItems.map((item) => (
            <button key={item.key} className={activeView === item.key ? "active" : ""} onClick={() => setActiveView(item.key)}>
              <span>{item.glyph}</span>{item.label}
            </button>
          ))}
        </nav>

        {activeView === "channels" && <ImChannelPage />}
        {activeView === "thoughts" && <ThoughtRunsPage requestedRunId={requestedThoughtRunId} />}
        {activeView === "memories" && <MemoriesPage onOpenThought={openThought} />}
        {activeView === "jobs" && <JobsPage />}

        {activeView === "settings" && (
          <section className="page-panel settings-page">
            <div className="page-hero"><div><span className="section-kicker">Agent configuration</span><h1>设置</h1><p>管理 PostgreSQL 中的主模型与快速模型配置。模型不可用不会阻断 QQ 消息入站和持久化。</p></div></div>
            <LlmSettingsPanel />
          </section>
        )}
      </section>
    </main>
  );
}
