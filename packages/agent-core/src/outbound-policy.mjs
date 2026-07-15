import { createHash } from "node:crypto";

export function normalizeSpeechContent(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechContentHash(value) {
  return createHash("sha256").update(normalizeSpeechContent(value)).digest("hex");
}

function localMinute(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

function inQuietHours(now, policy) {
  const start = Number(policy.quietStartMinute);
  const end = Number(policy.quietEndMinute);
  if (start === end) return false;
  const minute = localMinute(now, policy.timezone);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

function result(outcome, reasonCode, nextEvaluationAt = null) {
  return { outcome, reasonCode, nextEvaluationAt };
}

export function evaluateSpeechPolicy({
  proposal,
  agentMode,
  policy,
  channelEnabled,
  allowlisted,
  now = new Date(),
  sentToday = 0,
  lastSpokenAt = null,
  duplicateSeen = false,
}) {
  if (proposal.type === "no_action") return result("silent", "model_no_action");
  if (proposal.type !== "reply") return result("silent", "no_reply_proposal");
  if (!policy.enabled) return result("blocked", "kill_switch");
  if (!channelEnabled) return result("blocked", "channel_disabled");
  if (!allowlisted) return result("blocked", "conversation_not_allowlisted");
  if (proposal.targetConversationId !== proposal.conversationId) {
    return result("blocked", "target_mismatch");
  }
  if (!proposal.draft.trim()) return result("blocked", "draft_empty");
  if (!Array.isArray(proposal.evidenceReferences) ||
      proposal.evidenceReferences.length === 0) {
    return result("blocked", "evidence_missing");
  }
  const freshnessMs = Math.max(1, Number(policy.freshnessSeconds)) * 1_000;
  if (now.getTime() - new Date(proposal.createdAt).getTime() > freshnessMs) {
    return result("silent", "opportunity_stale");
  }
  if (duplicateSeen) return result("silent", "duplicate_suppressed");
  if (inQuietHours(now, policy)) {
    return result("defer", "quiet_hours", new Date(now.getTime() + 5 * 60_000));
  }
  if (sentToday >= Number(policy.dailyBudget)) {
    return result("defer", "daily_budget", new Date(now.getTime() + 60 * 60_000));
  }
  if (lastSpokenAt) {
    const cooldownEndsAt = new Date(
      new Date(lastSpokenAt).getTime() + Number(policy.cooldownSeconds) * 1_000,
    );
    if (cooldownEndsAt > now) return result("defer", "channel_cooldown", cooldownEndsAt);
  }
  if (agentMode === "shadow") return result("shadow_speak", "shadow_mode");
  if (agentMode !== "active") return result("blocked", "agent_mode_invalid");
  return result("speak", "policy_passed");
}
