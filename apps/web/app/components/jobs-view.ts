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
