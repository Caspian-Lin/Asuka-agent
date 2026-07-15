"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { controlRequest } from "./control-api";
import {
  minuteToTime,
  speechOutcomeCopy,
  speechReasonCopy,
  timeToMinute,
} from "./speech-decisions-view";

type OutboundPolicy = {
  enabled: boolean;
  mode: "shadow" | "active";
  timezone: string;
  quiet_start_minute: number;
  quiet_end_minute: number;
  daily_budget: number;
  cooldown_seconds: number;
  duplicate_window_seconds: number;
  freshness_seconds: number;
  updated_at: string;
};

type SpeechDecision = {
  id: string;
  outcome: string;
  reason_code: string;
  draft: string;
  evidence_references: Array<Record<string, unknown>>;
  policy_snapshot: Record<string, unknown>;
  next_evaluation_at: string | null;
  evaluation_count: number;
  feedback_label: "send" | "defer" | "silent" | null;
  feedback_note: string | null;
  feedback_at: string | null;
  created_at: string;
  proposal_status: string;
  thought_run_id: string;
  trigger_type: string;
  trigger_reason: string;
  conversation_title: string;
  external_conversation_id: string;
  delivery_status: string | null;
  external_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  sent_at: string | null;
};

type OutboundSnapshot = { policy: OutboundPolicy; decisions: SpeechDecision[] };

function formatDateTime(value?: string | null, fallback = "—") {
  if (!value) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function evidenceLabel(reference: Record<string, unknown>) {
  const type = String(reference.type ?? "source");
  const id = String(reference.id ?? "unknown");
  return `${type}:${id}`;
}

export default function SpeechDecisionsPage({
  onOpenThought,
}: {
  onOpenThought: (thoughtRunId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<OutboundSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await controlRequest<OutboundSnapshot>("/api/outbound");
      setSnapshot(value);
      setSelectedId((current) => current && value.decisions.some((item) => item.id === current)
        ? current
        : value.decisions[0]?.id ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "自主发言数据载入失败");
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

  const selected = useMemo(
    () => snapshot?.decisions.find((item) => item.id === selectedId) ?? null,
    [selectedId, snapshot],
  );

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy("policy");
    setError(null);
    setNotice(null);
    try {
      await controlRequest<{ policy: OutboundPolicy }>("/api/outbound/policy", {
        method: "PUT",
        body: JSON.stringify({
          enabled: values.get("enabled") === "on",
          mode: values.get("mode"),
          timezone: values.get("timezone"),
          quietStartMinute: timeToMinute(String(values.get("quietStart") ?? "00:00")),
          quietEndMinute: timeToMinute(String(values.get("quietEnd") ?? "00:00")),
          dailyBudget: Number(values.get("dailyBudget")),
          cooldownSeconds: Number(values.get("cooldownSeconds")),
          duplicateWindowSeconds: Number(values.get("duplicateWindowSeconds")),
          freshnessSeconds: Number(values.get("freshnessSeconds")),
        }),
      });
      await load();
      setNotice("自主发言硬策略已保存；未发送的旧 delivery 会取消，新决策使用这组配置。影子模式不会发送 QQ。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "自主发言策略保存失败");
    } finally {
      setBusy(null);
    }
  }

  async function saveFeedback(decisionId: string, label: "send" | "defer" | "silent") {
    setBusy(`feedback-${label}`);
    setError(null);
    try {
      await controlRequest<{ feedback: object }>(
        `/api/outbound/decisions/${encodeURIComponent(decisionId)}/feedback`,
        { method: "POST", body: JSON.stringify({ label }) },
      );
      await load();
      setNotice("反馈已记录，仅用于后续评估，不会改变或补发这条消息。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "反馈保存失败");
    } finally {
      setBusy(null);
    }
  }

  const policy = snapshot?.policy;
  const operatingState = !policy?.enabled
    ? "总开关关闭"
    : policy.mode === "shadow"
      ? "影子模式"
      : "真实发送已启用";

  return (
    <section className="page-panel speech-page">
      <header className="speech-page-head">
        <div>
          <h1>自主发言</h1>
          <p>查看模型提出的发言动作、硬策略判断与 NapCat 送达结果。模型不能修改这里的安全边界。</p>
        </div>
        <span className={`speech-operating-state ${policy?.enabled && policy.mode === "active" ? "is-active" : ""}`}>
          <i />{operatingState}
        </span>
      </header>

      <div aria-live="polite">
        {error && <div className="inline-error" role="alert">{error} <button onClick={() => void load()}>重试</button></div>}
        {notice && <div className="inline-success" role="status">{notice}</div>}
      </div>

      {loading || !policy ? (
        <div className="speech-loading" aria-busy="true"><i /><i /></div>
      ) : (
        <>
          <form key={policy.updated_at} className="speech-policy" onSubmit={(event) => void savePolicy(event)}>
            <header>
              <div><h2>发送边界</h2><p>先通过模型语义决策，再逐项执行以下确定性检查。</p></div>
              <label className="speech-master-switch">
                <input name="enabled" type="checkbox" defaultChecked={policy.enabled} />
                <span><strong>允许自主发言</strong><small>关闭时所有回复提案都会被阻断</small></span>
              </label>
            </header>

            <fieldset className="speech-mode-field">
              <legend>运行模式</legend>
              <label><input name="mode" type="radio" value="shadow" defaultChecked={policy.mode === "shadow"} /><span><strong>影子模式</strong><small>记录本来会说什么，不调用发送 API</small></span></label>
              <label><input name="mode" type="radio" value="active" defaultChecked={policy.mode === "active"} /><span><strong>真实发送</strong><small>通过全部策略后加入 NapCat 出站队列</small></span></label>
            </fieldset>

            <div className="speech-policy-fields">
              <label><span>时区</span><input name="timezone" required defaultValue={policy.timezone} /></label>
              <label><span>静默开始</span><input name="quietStart" type="time" required defaultValue={minuteToTime(policy.quiet_start_minute)} /></label>
              <label><span>静默结束</span><input name="quietEnd" type="time" required defaultValue={minuteToTime(policy.quiet_end_minute)} /></label>
              <label><span>每日额度</span><input name="dailyBudget" type="number" min="0" max="100" required defaultValue={policy.daily_budget} /><small>0 表示始终延后</small></label>
              <label><span>会话冷却（秒）</span><input name="cooldownSeconds" type="number" min="0" max="86400" required defaultValue={policy.cooldown_seconds} /></label>
              <label><span>重复抑制（秒）</span><input name="duplicateWindowSeconds" type="number" min="0" max="604800" required defaultValue={policy.duplicate_window_seconds} /></label>
              <label><span>发言时效（秒）</span><input name="freshnessSeconds" type="number" min="60" max="86400" required defaultValue={policy.freshness_seconds} /></label>
            </div>
            <footer><p>静默开始与结束相同表示不启用静默时段。</p><button className="primary-action" type="submit" disabled={busy === "policy"}>{busy === "policy" ? "保存中…" : "保存策略"}</button></footer>
          </form>

          <section className="speech-audit" aria-labelledby="speech-audit-title">
            <header><div><h2 id="speech-audit-title">决策记录</h2><p>每条记录都能回到触发思绪、引用证据和实际送达状态。</p></div><button className="secondary-action" onClick={() => void load()}>刷新</button></header>
            {snapshot.decisions.length === 0 ? (
              <div className="speech-empty"><h3>还没有发言决策</h3><p>运行一次思绪任务后，fast 模型的动作提案会在这里经过硬策略评估。</p></div>
            ) : (
              <div className="speech-audit-grid">
                <div className="speech-decision-list" aria-label="发言决策列表">
                  {snapshot.decisions.map((decision) => {
                    const outcome = speechOutcomeCopy[decision.outcome] ?? { label: decision.outcome, tone: "muted" };
                    return <button key={decision.id} className={decision.id === selectedId ? "selected" : ""} aria-current={decision.id === selectedId ? "true" : undefined} onClick={() => setSelectedId(decision.id)}>
                      <span className={`speech-outcome tone-${outcome.tone}`}>{outcome.label}</span>
                      <strong>{decision.conversation_title}</strong>
                      <p>{decision.draft || "（没有回复草稿）"}</p>
                      <small>{formatDateTime(decision.created_at)} · {speechReasonCopy[decision.reason_code] ?? decision.reason_code}</small>
                    </button>;
                  })}
                </div>

                {selected && <article className="speech-decision-detail">
                  <header><div><span className={`speech-outcome tone-${speechOutcomeCopy[selected.outcome]?.tone ?? "muted"}`}>{speechOutcomeCopy[selected.outcome]?.label ?? selected.outcome}</span><h3>{selected.conversation_title}</h3><code>{selected.external_conversation_id}</code></div><time>{formatDateTime(selected.created_at)}</time></header>
                  <section><h4>回复草稿</h4><p className="speech-draft">{selected.draft || "模型决定不发言。"}</p></section>
                  <dl className="speech-decision-facts">
                    <div><dt>策略原因</dt><dd>{speechReasonCopy[selected.reason_code] ?? selected.reason_code}</dd></div>
                    <div><dt>触发方式</dt><dd>{selected.trigger_type} · {selected.trigger_reason}</dd></div>
                    <div><dt>评估次数</dt><dd>{selected.evaluation_count}</dd></div>
                    <div><dt>下次评估</dt><dd>{formatDateTime(selected.next_evaluation_at, "不再评估")}</dd></div>
                    <div><dt>送达状态</dt><dd>{selected.delivery_status ?? "未创建 delivery"}</dd></div>
                    <div><dt>QQ 消息 ID</dt><dd>{selected.external_message_id ?? "—"}</dd></div>
                  </dl>
                  {selected.last_error_message && <div className="speech-delivery-error"><strong>{selected.last_error_code}</strong><p>{selected.last_error_message}</p></div>}
                  <section><h4>本轮引用</h4>{selected.evidence_references.length ? <ul className="speech-evidence">{selected.evidence_references.map((reference, index) => <li key={`${evidenceLabel(reference)}-${index}`}><code>{evidenceLabel(reference)}</code></li>)}</ul> : <p className="speech-muted">没有引用；硬策略不会允许真实发送。</p>}</section>
                  <section className="speech-feedback"><div><h4>你的判断</h4><p>只记录评估标签，不会立即发送、撤回或改写这条消息。</p></div><div>{(["send", "defer", "silent"] as const).map((label) => <button key={label} className={selected.feedback_label === label ? "selected" : ""} aria-pressed={selected.feedback_label === label} disabled={busy?.startsWith("feedback-")} onClick={() => void saveFeedback(selected.id, label)}>{label === "send" ? "应该发送" : label === "defer" ? "应该延后" : "应该沉默"}</button>)}</div></section>
                  <button className="thought-link" onClick={() => onOpenThought(selected.thought_run_id)}>查看关联思绪 · {selected.thought_run_id}</button>
                </article>}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
