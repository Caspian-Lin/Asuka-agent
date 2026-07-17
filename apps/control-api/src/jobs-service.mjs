import {
  normalizeJobUpdate,
  SchedulerConfigError,
} from "@asuka-agent/agent-core/scheduler-config";

export class JobRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "JobRequestError";
    this.code = code;
    this.status = status;
  }
}

const manuallyRunnableTypes = new Set(["thought_tick", "memory_consolidation"]);

export function createJobsService({ repository, randomId, clock = () => new Date() }) {
  async function listJobs() {
    return repository.listJobs();
  }

  async function trigger(jobId, input = {}) {
    const job = await repository.getJob(jobId);
    if (!job) throw new JobRequestError("job_not_found", "任务不存在", 404);
    if (!manuallyRunnableTypes.has(job.job_type)) {
      throw new JobRequestError("job_not_runnable", "该系统任务不支持手动触发", 409);
    }
    if (!job.enabled || job.status !== "active") {
      throw new JobRequestError("job_disabled", "任务当前未启用", 409);
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new JobRequestError("job_run_parameters_invalid", "运行参数必须是 JSON 对象");
    }
    const unknownParameter = Object.keys(input).find((field) => field !== "conversationId");
    if (unknownParameter) {
      throw new JobRequestError(
        "job_run_parameters_invalid",
        `运行参数包含不支持的字段：${unknownParameter}`,
      );
    }
    if (input.conversationId !== undefined &&
        input.conversationId !== null &&
        typeof input.conversationId !== "string") {
      throw new JobRequestError("job_run_parameters_invalid", "conversationId 必须是字符串");
    }
    const conversationId = input?.conversationId == null || input.conversationId === ""
      ? null
      : input.conversationId;
    if (conversationId && job.job_type !== "thought_tick") {
      throw new JobRequestError(
        "job_scope_unsupported",
        "只有定时思绪整理支持指定会话立即运行",
      );
    }
    if (conversationId) {
      const conversation = await repository.getConversation(conversationId);
      if (!conversation) {
        throw new JobRequestError(
          "conversation_not_found",
          "目标会话不存在、未启用或不属于当前 Agent",
          404,
        );
      }
    }
    const configuredAttempts = Number(job.config?.maxAttempts ?? 3);
    const maxAttempts = Number.isSafeInteger(configuredAttempts) &&
      configuredAttempts > 0 && configuredAttempts <= 10
      ? configuredAttempts
      : 3;
    const runId = randomId();
    const now = clock();
    return repository.enqueue({
      id: runId,
      jobId: job.id,
      correlationId: `job-run:${runId}`,
      idempotencyKey: `manual:${job.id}:${runId}`,
      maxAttempts,
      parameters: conversationId ? { conversationId } : {},
      now,
    });
  }

  async function update(jobId, input) {
    const job = await repository.getJob(jobId);
    if (!job) throw new JobRequestError("job_not_found", "任务不存在", 404);
    let normalized;
    try {
      normalized = normalizeJobUpdate(job, input, clock());
    } catch (error) {
      if (error instanceof SchedulerConfigError) {
        throw new JobRequestError(error.code, error.message, 400);
      }
      throw error;
    }
    return repository.updateJob(jobId, normalized);
  }

  async function listConversations() {
    return repository.listConversations();
  }

  async function listRuns(jobId) {
    const job = await repository.getJob(jobId);
    if (!job) throw new JobRequestError("job_not_found", "任务不存在", 404);
    return repository.listRuns(jobId);
  }

  async function getRun(runId) {
    const detail = await repository.getRun(runId);
    if (!detail) throw new JobRequestError("job_run_not_found", "任务运行不存在", 404);
    return detail;
  }

  return { getRun, listConversations, listJobs, listRuns, trigger, update };
}
