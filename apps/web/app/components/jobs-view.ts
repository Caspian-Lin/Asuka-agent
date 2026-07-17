export type JobMetrics = {
  deliveryCount?: number;
  conversationCount?: number;
  messageCount?: number;
  thoughtCount?: number;
  candidateCount?: number;
};

export function formatJobMetrics(metrics?: JobMetrics | null) {
  if (!metrics) return "暂无处理统计";
  if (typeof metrics.deliveryCount === "number") return `${metrics.deliveryCount} 条入站消息`;
  const fragments = [
    typeof metrics.conversationCount === "number" ? `${metrics.conversationCount} 个会话` : null,
    typeof metrics.messageCount === "number" ? `${metrics.messageCount} 条消息` : null,
    typeof metrics.thoughtCount === "number" ? `${metrics.thoughtCount} 条思绪` : null,
    typeof metrics.candidateCount === "number" ? `${metrics.candidateCount} 条记忆候选` : null,
  ].filter(Boolean);
  return fragments.join(" · ") || "本轮没有新增消息";
}

export function canManuallyRunJob(job: {
  enabled: boolean;
  status: string;
  job_type: string;
}) {
  return job.enabled && job.status === "active" &&
    ["thought_tick", "memory_consolidation"].includes(job.job_type);
}

export function canEditJobConfig(job: {
  configurable: boolean;
  job_type: string;
}) {
  return job.configurable &&
    ["thought_tick", "memory_consolidation"].includes(job.job_type);
}

export type JobConfigDraft = {
  enabled: boolean;
  intervalMinutes: number;
  dailyTime: string;
  maxBatchMessages: number;
  maxAttempts: number;
};

export function jobConfigDraft(job: {
  job_type: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
}): JobConfigDraft {
  const config = job.config ?? {};
  const dailyHour = Number(config.dailyHour ?? 3);
  const dailyMinute = Number(config.dailyMinute ?? 0);
  return {
    enabled: job.enabled,
    intervalMinutes: Math.max(1, Math.round(Number(config.intervalSeconds ?? 900) / 60)),
    dailyTime: `${String(dailyHour).padStart(2, "0")}:${String(dailyMinute).padStart(2, "0")}`,
    maxBatchMessages: Number(config.maxBatchMessages ?? config.maxMessages ??
      (job.job_type === "thought_tick" ? 50 : 100)),
    maxAttempts: Number(config.maxAttempts ?? 3),
  };
}

export function formatRunScope(
  parameters?: { conversationId?: string } | null,
  conversations: Array<{ id: string; title: string }> = [],
) {
  const conversationId = parameters?.conversationId;
  if (!conversationId) return "所有有新增消息的会话";
  const conversation = conversations.find((item) => item.id === conversationId);
  return conversation?.title ?? `会话 ${conversationId}`;
}
