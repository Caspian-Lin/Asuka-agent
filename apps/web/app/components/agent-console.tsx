"use client";

import { useEffect, useState } from "react";
import {
  LuBot,
  LuBrainCircuit,
  LuClock3,
  LuDatabase,
  LuMessagesSquare,
  LuMessageSquareReply,
  LuSettings,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import ImChannelPage from "@/app/components/im-channel-page";
import JobsPage from "@/app/components/jobs-page";
import LlmSettingsPanel from "@/app/components/llm-settings-panel";
import MemoriesPage from "@/app/components/memories-page";
import SpeechDecisionsPage from "@/app/components/speech-decisions-page";
import ThemeSettingsPanel from "@/app/components/theme-settings-panel";
import {
  COLOR_THEME_STORAGE_KEY,
  parseColorTheme,
  type ColorTheme,
} from "@/app/components/theme-preferences";
import ThoughtRunsPage from "@/app/components/thought-runs-page";

type ViewKey = "channels" | "thoughts" | "memories" | "speech" | "jobs" | "settings";

const navItems: Array<{ key: ViewKey; label: string; icon: IconType }> = [
  { key: "channels", label: "IM Channel", icon: LuMessagesSquare },
  { key: "thoughts", label: "思绪", icon: LuBrainCircuit },
  { key: "memories", label: "记忆", icon: LuDatabase },
  { key: "speech", label: "自主发言", icon: LuMessageSquareReply },
  { key: "jobs", label: "定时任务", icon: LuClock3 },
  { key: "settings", label: "设置", icon: LuSettings },
];

export default function AgentConsole() {
  const [activeView, setActiveView] = useState<ViewKey>("channels");
  const [requestedThoughtRunId, setRequestedThoughtRunId] = useState<string | null>(null);
  const [colorTheme, setColorTheme] = useState<ColorTheme>("classic");

  useEffect(() => {
    const syncStoredTheme = () => {
      let storedTheme: string | null = null;
      try {
        storedTheme = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY);
      } catch {
        // Storage can be unavailable in locked-down browser profiles.
      }
      const nextTheme = parseColorTheme(storedTheme);
      setColorTheme(nextTheme);
      document.documentElement.dataset.colorTheme = nextTheme;
    };
    const timer = window.setTimeout(syncStoredTheme, 0);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === COLOR_THEME_STORAGE_KEY) syncStoredTheme();
    };
    window.addEventListener("storage", handleStorage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  function changeColorTheme(theme: ColorTheme) {
    setColorTheme(theme);
    document.documentElement.dataset.colorTheme = theme;
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, theme);
    } catch {
      // The active tab still keeps the selected theme when storage is unavailable.
    }
  }

  function openThought(thoughtRunId: string) {
    setRequestedThoughtRunId(thoughtRunId);
    setActiveView("thoughts");
  }

  return (
    <main className="agent-shell">
      <aside className="side-rail">
        <button className="brand" onClick={() => setActiveView("channels")} aria-label="返回 IM Channel">
          <span className="brand-mark"><LuBot aria-hidden /></span>
          <span><strong>Asuka</strong><small>Agent</small></span>
        </button>

        <nav className="primary-nav" aria-label="主要导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                className={activeView === item.key ? "active" : ""}
                onClick={() => setActiveView(item.key)}
                aria-current={activeView === item.key ? "page" : undefined}
              >
                <span><Icon aria-hidden /></span>{item.label}
              </button>
            );
          })}
        </nav>

        <div className="rail-note database-note">
          <div className="rail-note-head"><span>唯一数据源</span><strong>PostgreSQL</strong></div>
          <p>QQ 消息、思绪、模型调用和记忆候选统一持久化。</p>
        </div>
      </aside>

      <section className="workbench">
        <nav className="mobile-nav" aria-label="移动端导航">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.key} className={activeView === item.key ? "active" : ""} onClick={() => setActiveView(item.key)}>
                <span><Icon aria-hidden /></span>{item.label}
              </button>
            );
          })}
        </nav>

        {activeView === "channels" && <ImChannelPage />}
        {activeView === "thoughts" && <ThoughtRunsPage requestedRunId={requestedThoughtRunId} />}
        {activeView === "memories" && <MemoriesPage onOpenThought={openThought} />}
        {activeView === "speech" && <SpeechDecisionsPage onOpenThought={openThought} />}
        {activeView === "jobs" && <JobsPage />}

        {activeView === "settings" && (
          <section className="page-panel settings-page">
            <div className="page-hero"><div><span className="page-context">Agent configuration</span><h1>设置</h1><p>管理本机界面配色，以及 PostgreSQL 中的主模型与快速模型配置。模型不可用不会阻断 QQ 消息入站和持久化。</p></div></div>
            <ThemeSettingsPanel theme={colorTheme} onChange={changeColorTheme} />
            <LlmSettingsPanel />
          </section>
        )}
      </section>
    </main>
  );
}
