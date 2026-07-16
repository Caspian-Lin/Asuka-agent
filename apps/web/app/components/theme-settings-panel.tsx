"use client";

import { LuCheck, LuPalette } from "react-icons/lu";
import type { ColorTheme } from "./theme-preferences";

type ThemeSettingsPanelProps = {
  theme: ColorTheme;
  onChange: (theme: ColorTheme) => void;
};

const themeOptions: Array<{
  value: ColorTheme;
  title: string;
  description: string;
}> = [
  {
    value: "classic",
    title: "明亮基础",
    description: "黑白界面、金橙操作色与明亮蓝信息色。",
  },
  {
    value: "asuka",
    title: "Asuka 红金",
    description: "深红导航、金橙工作区，以浅亮蓝突出交互。",
  },
];

export default function ThemeSettingsPanel({ theme, onChange }: ThemeSettingsPanelProps) {
  return (
    <section className="theme-settings-section" aria-labelledby="theme-settings-title">
      <header className="settings-section-head">
        <div>
          <h2 id="theme-settings-title">界面主题</h2>
          <p>只改变配色方案，不改变字体、字号、间距或页面结构。选择会保存在当前浏览器。</p>
        </div>
        <span className="theme-section-icon"><LuPalette aria-hidden />配色</span>
      </header>

      <div className="theme-option-list" aria-label="界面主题">
        {themeOptions.map((option) => {
          const selected = option.value === theme;
          return (
            <button
              type="button"
              className="theme-option"
              data-theme-preview={option.value}
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              key={option.value}
            >
              <span className="theme-preview" aria-hidden>
                <span className="theme-preview-navigation" />
                <span className="theme-preview-surface" />
                <span className="theme-preview-accent" />
              </span>
              <span className="theme-option-copy">
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
              <span className="theme-option-check" aria-hidden>{selected && <LuCheck />}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
