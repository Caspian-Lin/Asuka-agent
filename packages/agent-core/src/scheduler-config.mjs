const editableJobTypes = new Set(["thought_tick", "memory_consolidation"]);

export class SchedulerConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SchedulerConfigError";
    this.code = code;
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SchedulerConfigError(
      "job_config_invalid",
      `${field} 必须是 ${minimum} 到 ${maximum} 之间的整数`,
    );
  }
  return value;
}

function dailyParts(config) {
  return {
    hour: boundedInteger(Number(config?.dailyHour ?? 3), "每日执行小时", 0, 23),
    minute: boundedInteger(Number(config?.dailyMinute ?? 0), "每日执行分钟", 0, 59),
  };
}

export function canConfigureJob(job) {
  return job?.configurable === true && editableJobTypes.has(job.job_type);
}

export function nextRunAt(job, now = new Date()) {
  if (job.job_type === "thought_tick") {
    const intervalSeconds = Number(job.config?.intervalSeconds ?? 900);
    const safeSeconds = Number.isSafeInteger(intervalSeconds) && intervalSeconds >= 60
      ? intervalSeconds
      : 900;
    const scheduled = job.next_run_at ? new Date(job.next_run_at) : now;
    return new Date(Math.max(now.getTime(), scheduled.getTime()) + safeSeconds * 1_000);
  }
  const { hour, minute } = dailyParts(job.config);
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60_000);
  let target = new Date(Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
    hour - 8,
    minute,
  ));
  if (target <= now) target = new Date(target.getTime() + 24 * 60 * 60_000);
  return target;
}

export function normalizeJobUpdate(job, input, now = new Date()) {
  if (!canConfigureJob(job)) {
    throw new SchedulerConfigError("job_not_configurable", "该系统任务不允许修改配置");
  }
  if (!plainObject(input)) {
    throw new SchedulerConfigError("job_config_invalid", "任务配置必须是 JSON 对象");
  }
  const allowedFields = new Set(["enabled", "schedule", "limits"]);
  const unknownField = Object.keys(input).find((field) => !allowedFields.has(field));
  if (unknownField) {
    throw new SchedulerConfigError(
      "job_config_invalid",
      `任务配置包含不支持的字段：${unknownField}`,
    );
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new SchedulerConfigError("job_config_invalid", "enabled 必须是布尔值");
  }
  if (input.schedule !== undefined && !plainObject(input.schedule)) {
    throw new SchedulerConfigError("job_config_invalid", "schedule 必须是 JSON 对象");
  }
  if (input.limits !== undefined && !plainObject(input.limits)) {
    throw new SchedulerConfigError("job_config_invalid", "limits 必须是 JSON 对象");
  }

  const enabled = input.enabled ?? job.enabled;
  const config = { ...(plainObject(job.config) ? job.config : {}) };
  let scheduleExpression = job.schedule_expression;

  if (job.job_type === "thought_tick") {
    const unknownScheduleField = Object.keys(input.schedule ?? {})
      .find((field) => field !== "intervalMinutes");
    if (unknownScheduleField) {
      throw new SchedulerConfigError(
        "job_config_invalid",
        `定时思绪整理不支持调度字段：${unknownScheduleField}`,
      );
    }
    const intervalMinutes = input.schedule?.intervalMinutes === undefined
      ? Math.max(1, Math.round(Number(config.intervalSeconds ?? 900) / 60))
      : boundedInteger(input.schedule.intervalMinutes, "执行间隔（分钟）", 1, 1_440);
    config.intervalSeconds = intervalMinutes * 60;
    scheduleExpression = `${intervalMinutes}m`;
  } else {
    const unknownScheduleField = Object.keys(input.schedule ?? {})
      .find((field) => field !== "dailyTime");
    if (unknownScheduleField) {
      throw new SchedulerConfigError(
        "job_config_invalid",
        `夜间记忆沉淀不支持调度字段：${unknownScheduleField}`,
      );
    }
    const current = dailyParts(config);
    const dailyTime = input.schedule?.dailyTime ??
      `${String(current.hour).padStart(2, "0")}:${String(current.minute).padStart(2, "0")}`;
    const match = /^(\d{2}):(\d{2})$/.exec(dailyTime);
    if (!match) {
      throw new SchedulerConfigError("job_config_invalid", "每日执行时间必须使用 HH:mm 格式");
    }
    config.dailyHour = boundedInteger(Number(match[1]), "每日执行小时", 0, 23);
    config.dailyMinute = boundedInteger(Number(match[2]), "每日执行分钟", 0, 59);
    scheduleExpression = `${config.dailyMinute} ${config.dailyHour} * * *`;
  }

  const allowedLimitFields = new Set(["maxBatchMessages", "maxAttempts"]);
  const unknownLimitField = Object.keys(input.limits ?? {})
    .find((field) => !allowedLimitFields.has(field));
  if (unknownLimitField) {
    throw new SchedulerConfigError(
      "job_config_invalid",
      `任务配置不支持限制字段：${unknownLimitField}`,
    );
  }
  if (input.limits?.maxBatchMessages !== undefined) {
    config.maxBatchMessages = boundedInteger(
      input.limits.maxBatchMessages,
      "单会话最大消息数",
      1,
      1_000,
    );
  } else {
    config.maxBatchMessages = boundedInteger(
      Number(config.maxBatchMessages ?? config.maxMessages ??
        (job.job_type === "thought_tick" ? 50 : 100)),
      "单会话最大消息数",
      1,
      1_000,
    );
  }
  delete config.maxMessages;
  if (input.limits?.maxAttempts !== undefined) {
    config.maxAttempts = boundedInteger(input.limits.maxAttempts, "最大重试次数", 1, 10);
  } else {
    config.maxAttempts = boundedInteger(
      Number(config.maxAttempts ?? 3),
      "最大重试次数",
      1,
      10,
    );
  }

  return {
    enabled,
    status: enabled ? "active" : "disabled",
    scheduleType: job.job_type === "thought_tick" ? "interval" : "cron",
    scheduleExpression,
    timezone: "Asia/Shanghai",
    config,
    nextRunAt: enabled
      ? nextRunAt({
          job_type: job.job_type,
          next_run_at: null,
          config,
        }, now)
      : null,
  };
}
