export const speechOutcomeCopy: Record<string, { label: string; tone: string }> = {
  silent: { label: "保持沉默", tone: "muted" },
  defer: { label: "延后评估", tone: "waiting" },
  blocked: { label: "策略阻断", tone: "blocked" },
  shadow_speak: { label: "影子发言", tone: "shadow" },
  speak: { label: "真实发言", tone: "sent" },
};

export const speechReasonCopy: Record<string, string> = {
  model_no_action: "模型明确选择不发言",
  no_reply_proposal: "没有可执行的回复提案",
  kill_switch: "自主发言总开关已关闭",
  channel_disabled: "QQ Channel 已停用",
  conversation_not_allowlisted: "会话不在 QQ 白名单中",
  target_mismatch: "回复目标与触发会话不一致",
  draft_empty: "回复草稿为空",
  evidence_missing: "回复没有引用本轮证据",
  opportunity_stale: "发言机会已经过期",
  duplicate_suppressed: "近期已经生成相同内容",
  quiet_hours: "当前处于静默时段",
  daily_budget: "已达到今日发言额度",
  channel_cooldown: "当前会话仍在冷却期",
  shadow_mode: "影子模式仅记录，不发送 QQ",
  agent_mode_invalid: "Agent 运行模式无效",
  policy_passed: "所有硬策略检查均已通过",
};

export function minuteToTime(value: number) {
  const minute = Math.max(0, Math.min(1_439, Math.trunc(Number(value) || 0)));
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function timeToMinute(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}
