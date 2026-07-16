"use client";

import { useEffect, useState } from "react";
import {
  LuBot,
  LuBrainCircuit,
  LuClock3,
  LuDatabase,
  LuMessagesSquare,
  LuMessageSquareReply,
  LuPanelLeftClose,
  LuPanelLeftOpen,
  LuSettings,
} from "react-icons/lu";
import type { IconType } from "react-icons";
import ImChannelPage from "@/app/components/im-channel-page";
import JobsPage from "@/app/components/jobs-page";
import LlmSettingsPanel from "@/app/components/llm-settings-panel";
import MemoriesPage from "@/app/components/memories-page";
import {
  NAV_RAIL_COLLAPSED_STORAGE_KEY,
  parseNavRailCollapsed,
} from "@/app/components/navigation-preferences";
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
  const [railCollapsed, setRailCollapsed] = useState(false);

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

  useEffect(() => {
    const syncStoredRailState = () => {
      let storedState: string | null = null;
      try {
        storedState = window.localStorage.getItem(NAV_RAIL_COLLAPSED_STORAGE_KEY);
      } catch {
        // Storage can be unavailable in locked-down browser profiles.
      }
      setRailCollapsed(parseNavRailCollapsed(storedState));
    };
    const timer = window.setTimeout(syncStoredRailState, 0);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === NAV_RAIL_COLLAPSED_STORAGE_KEY) syncStoredRailState();
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

  function toggleRail() {
    setRailCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(NAV_RAIL_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // The active tab still keeps the selected state when storage is unavailable.
      }
      return next;
    });
  }

  return (
    <main className={`agent-shell${railCollapsed ? " rail-collapsed" : ""}`}>
      <aside className="side-rail" id="primary-navigation-rail">
        <button
          className="rail-collapse-button"
          onClick={toggleRail}
          aria-controls="primary-navigation-rail"
          aria-expanded={!railCollapsed}
          aria-label={railCollapsed ? "展开导航侧栏" : "折叠导航侧栏"}
          title={railCollapsed ? "展开导航侧栏" : "折叠导航侧栏"}
        >
          {railCollapsed ? <LuPanelLeftOpen aria-hidden /> : <LuPanelLeftClose aria-hidden />}
        </button>
        <button className="brand" onClick={() => setActiveView("channels")} aria-label="返回 IM Channel">
          <span className="brand-mark"><LuBot aria-hidden /></span>
          <span className="brand-copy"><strong>Asuka</strong><small>Agent</small></span>
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
                title={item.label}
              >
                <span className="nav-icon"><Icon aria-hidden /></span>
                <span className="nav-label">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="rail-note database-note" role="note" aria-label="唯一数据源：PostgreSQL">
          <LuDatabase className="rail-note-icon" aria-hidden />
          <div className="rail-note-content">
            <div className="rail-note-head"><span>唯一数据源</span><strong>PostgreSQL</strong></div>
            <p>QQ 消息、思绪、模型调用和记忆候选统一持久化。</p>
          </div>
        </div>
      </aside>

      <section className={`workbench${activeView === "thoughts" ? " thought-workbench" : ""}`}>
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
