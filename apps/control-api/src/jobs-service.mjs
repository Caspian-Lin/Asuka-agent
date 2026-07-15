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

  async function trigger(jobId) {
    const job = await repository.getJob(jobId);
    if (!job) throw new JobRequestError("job_not_found", "任务不存在", 404);
    if (!manuallyRunnableTypes.has(job.job_type)) {
      throw new JobRequestError("job_not_runnable", "该系统任务不支持手动触发", 409);
    }
    if (!job.enabled || job.status !== "active") {
      throw new JobRequestError("job_disabled", "任务当前未启用", 409);
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
      now,
    });
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

  return { getRun, listJobs, listRuns, trigger };
}
