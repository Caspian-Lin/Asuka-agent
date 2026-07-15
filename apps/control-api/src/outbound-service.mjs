export class OutboundRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "OutboundRequestError";
    this.code = code;
    this.status = status;
  }
}

function integerInRange(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new OutboundRequestError(
      "outbound_policy_invalid",
      `${name} 必须是 ${minimum}–${maximum} 之间的整数`,
    );
  }
  return number;
}

function validTimezone(value) {
  const timezone = String(value ?? "").trim();
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format(new Date());
  } catch {
    throw new OutboundRequestError("outbound_policy_invalid", "时区名称无效");
  }
  return timezone;
}

export function validateOutboundPolicy(payload) {
  if (typeof payload?.enabled !== "boolean") {
    throw new OutboundRequestError("outbound_policy_invalid", "总开关必须是布尔值");
  }
  if (!["shadow", "active"].includes(payload.mode)) {
    throw new OutboundRequestError("outbound_policy_invalid", "运行模式必须是 shadow 或 active");
  }
  return {
    enabled: payload.enabled,
    mode: payload.mode,
    timezone: validTimezone(payload.timezone),
    quietStartMinute: integerInRange(payload.quietStartMinute, "静默开始时间", 0, 1_439),
    quietEndMinute: integerInRange(payload.quietEndMinute, "静默结束时间", 0, 1_439),
    dailyBudget: integerInRange(payload.dailyBudget, "每日额度", 0, 100),
    cooldownSeconds: integerInRange(payload.cooldownSeconds, "会话冷却", 0, 86_400),
    duplicateWindowSeconds: integerInRange(
      payload.duplicateWindowSeconds,
      "重复抑制窗口",
      0,
      604_800,
    ),
    freshnessSeconds: integerInRange(payload.freshnessSeconds, "发言时效", 60, 86_400),
  };
}

export function validateSpeechFeedback(payload) {
  const label = String(payload?.label ?? "");
  if (!["send", "defer", "silent"].includes(label)) {
    throw new OutboundRequestError("speech_feedback_invalid", "反馈必须是发送、延后或沉默");
  }
  const note = String(payload?.note ?? "").trim();
  if (note.length > 500) {
    throw new OutboundRequestError("speech_feedback_invalid", "反馈备注不能超过 500 字");
  }
  return { label, note: note || null };
}

export function createOutboundService({ repository, agentId = "agent-asuka" }) {
  async function snapshot() {
    const [policy, decisions] = await Promise.all([
      repository.getPolicy(agentId),
      repository.listDecisions(agentId),
    ]);
    if (!policy) {
      throw new OutboundRequestError("outbound_policy_not_found", "自主发言策略不存在", 404);
    }
    return { policy, decisions };
  }

  async function savePolicy(payload) {
    return repository.savePolicy(agentId, validateOutboundPolicy(payload));
  }

  async function saveFeedback(decisionId, payload) {
    const result = await repository.saveFeedback(
      agentId,
      decisionId,
      validateSpeechFeedback(payload),
    );
    if (!result) {
      throw new OutboundRequestError("speech_decision_not_found", "发言决策不存在", 404);
    }
    return result;
  }

  return { saveFeedback, savePolicy, snapshot };
}
