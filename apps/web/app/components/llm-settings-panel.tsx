"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuCircleDashed,
  LuKeyRound,
  LuPlugZap,
  LuSave,
  LuShieldCheck,
  LuTrash2,
} from "react-icons/lu";
import { controlRequest } from "./control-api";
import { buildLlmSettingsPayload } from "./llm-settings-form";

type LlmProfileName = "primary" | "fast";

type LlmProfile = {
  profile: LlmProfileName;
  displayName: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  enabled: boolean;
  keyConfigured: boolean;
  keyMask: string | null;
  availability:
    | "missing_configuration"
    | "disabled"
    | "missing_key"
    | "ready_untested"
    | "healthy"
    | "error";
  lastTest: null | {
    status: string;
    latencyMs: number | null;
    errorCode: string | null;
    testedAt: string;
  };
  updatedAt: string | null;
};

type SettingsResponse = {
  profiles: LlmProfile[];
  fallback: { strategy: "none"; message: string };
};

const profileCopy: Record<LlmProfileName, { title: string; purpose: string }> = {
  primary: {
    title: "主模型",
    purpose: "最终回复，以及需要更强推理和信息整合的任务。",
  },
  fast: {
    title: "快速小模型",
    purpose: "抽取、结构化判断、定时扫描等高频低延迟任务。",
  },
};

const availabilityCopy: Record<LlmProfile["availability"], string> = {
  missing_configuration: "等待配置",
  disabled: "已停用",
  missing_key: "缺少密钥",
  ready_untested: "待连接测试",
  healthy: "连接正常",
  error: "连接异常",
};

function formatTestTime(value?: string | null) {
  if (!value) return "尚未测试";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function LlmSettingsPanel() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await controlRequest<SettingsResponse>("/api/llm/settings"));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型配置载入失败");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function saveProfile(event: FormEvent<HTMLFormElement>, profile: LlmProfileName) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(`save-${profile}`);
    setError(null);
    try {
      await controlRequest<{ profile: LlmProfile }>(`/api/llm/settings/${profile}`, {
        method: "PUT",
        body: JSON.stringify(buildLlmSettingsPayload(values)),
      });
      form.reset();
      await load();
      setNotice(`${profileCopy[profile].title}配置已保存`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型配置保存失败");
    } finally {
      setBusy(null);
    }
  }

  async function testProfile(profile: LlmProfileName) {
    setBusy(`test-${profile}`);
    setError(null);
    try {
      const payload = await controlRequest<{
        result: { latencyMs: number; model: string };
      }>(`/api/llm/settings/${profile}/test`, { method: "POST" });
      await load();
      setNotice(
        `${profileCopy[profile].title}连接正常 · ${payload.result.latencyMs} ms · ${payload.result.model}`,
      );
    } catch (reason) {
      await load();
      setError(reason instanceof Error ? reason.message : "连接测试失败");
    } finally {
      setBusy(null);
    }
  }

  async function deleteKey(profile: LlmProfileName) {
    if (!window.confirm(`确认删除${profileCopy[profile].title}的 API Key？该档位会同时停用。`)) {
      return;
    }
    setBusy(`delete-${profile}`);
    setError(null);
    try {
      await controlRequest<{ profile: LlmProfile }>(
        `/api/llm/settings/${profile}/key`,
        { method: "DELETE", body: JSON.stringify({ confirmation: "DELETE" }) },
      );
      await load();
      setNotice(`${profileCopy[profile].title} API Key 已删除`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "API Key 删除失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="llm-settings-section" aria-labelledby="llm-settings-title">
      <header className="settings-section-head">
        <div>
          <h2 id="llm-settings-title">模型 API</h2>
          <p>业务代码按用途明确选择档位；密钥只在服务端加密保存，页面不会回填。</p>
        </div>
        <span className="no-fallback-badge"><LuShieldCheck aria-hidden />不自动降级</span>
      </header>

      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <div className="inline-success" role="status">{notice}</div>}

      {!settings ? (
        <div className="llm-settings-loading" aria-busy="true">正在读取模型配置…</div>
      ) : (
        <>
          <div className="llm-profile-list">
            {settings.profiles.map((profile) => {
              const copy = profileCopy[profile.profile];
              const AvailabilityIcon = profile.availability === "healthy"
                ? LuCircleCheck
                : profile.availability === "error" || profile.availability === "missing_key"
                  ? LuCircleAlert
                  : LuCircleDashed;
              const saving = busy === `save-${profile.profile}`;
              const testing = busy === `test-${profile.profile}`;
              const deleting = busy === `delete-${profile.profile}`;
              return (
                <form
                  className={`llm-profile-form profile-${profile.profile}`}
                  key={`${profile.profile}-${profile.updatedAt ?? "new"}`}
                  onSubmit={(event) => void saveProfile(event, profile.profile)}
                >
                  <header>
                    <div>
                      <span className="llm-profile-role">{profile.profile}</span>
                      <h3>{copy.title}</h3>
                      <p>{copy.purpose}</p>
                    </div>
                    <div className="llm-profile-state">
                      <span className={`connection-state state-${profile.availability}`}>
                        <AvailabilityIcon aria-hidden />{availabilityCopy[profile.availability]}
                      </span>
                      <label className="switch" title="启用此模型档位">
                        <input name="enabled" type="checkbox" defaultChecked={profile.enabled} />
                        <span />
                      </label>
                    </div>
                  </header>

                  <div className="llm-fields">
                    <label>
                      <span>显示名称</span>
                      <input
                        name="displayName"
                        required
                        maxLength={80}
                        defaultValue={profile.displayName}
                      />
                    </label>
                    <label className="wide-field">
                      <span>OpenAI-compatible Base URL</span>
                      <input
                        name="baseUrl"
                        type="url"
                        required
                        maxLength={2048}
                        placeholder="http://127.0.0.1:11434/v1"
                        defaultValue={profile.baseUrl}
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <span>模型 ID</span>
                      <input
                        name="modelId"
                        required
                        maxLength={200}
                        placeholder="model-name"
                        defaultValue={profile.modelId}
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <span>上下文长度</span>
                      <input
                        name="contextWindow"
                        type="number"
                        min={1024}
                        max={2_000_000}
                        step={1}
                        required
                        defaultValue={profile.contextWindow}
                      />
                      <small>本地预算上限，调用时还会预留输出空间。</small>
                    </label>
                    <label className="wide-field api-key-field">
                      <span>API Key</span>
                      <input
                        name="apiKey"
                        type="password"
                        maxLength={8192}
                        autoComplete="new-password"
                        placeholder={profile.keyConfigured ? "已配置；留空则保留原值" : "输入 API Key"}
                      />
                      <small className="key-status-copy">
                        <LuKeyRound aria-hidden />
                        {profile.keyConfigured
                          ? `${profile.keyMask} 已加密保存。服务端只返回固定掩码。`
                          : "尚未配置。启用前必须提供密钥。"}
                      </small>
                    </label>
                  </div>

                  <footer>
                    <div className="last-test-summary">
                      <span>{formatTestTime(profile.lastTest?.testedAt)}</span>
                      {profile.lastTest?.latencyMs !== null && profile.lastTest?.latencyMs !== undefined && (
                        <strong>{profile.lastTest.latencyMs} ms</strong>
                      )}
                      {profile.lastTest?.errorCode && <code>{profile.lastTest.errorCode}</code>}
                    </div>
                    <div className="llm-profile-actions">
                      {profile.keyConfigured && (
                        <button
                          className="text-danger-button"
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => void deleteKey(profile.profile)}
                        >
                          <LuTrash2 aria-hidden />{deleting ? "删除中…" : "删除密钥"}
                        </button>
                      )}
                      <button
                        className="ghost-button"
                        type="button"
                        disabled={Boolean(busy) || !profile.keyConfigured}
                        onClick={() => void testProfile(profile.profile)}
                      >
                        <LuPlugZap aria-hidden />{testing ? "测试中…" : "测试连接"}
                      </button>
                      <button className="primary-button" disabled={Boolean(busy)}>
                        <LuSave aria-hidden />{saving ? "保存中…" : "保存配置"}
                      </button>
                    </div>
                  </footer>
                </form>
              );
            })}
          </div>
          <p className="fallback-note"><strong>故障策略：</strong>{settings.fallback.message}</p>
        </>
      )}
    </section>
  );
}
