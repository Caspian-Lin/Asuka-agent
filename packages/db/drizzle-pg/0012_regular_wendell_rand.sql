ALTER TABLE "job_runs" ADD COLUMN "parameters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "jobs"
SET "configurable" = true,
    "schedule_type" = 'interval',
    "schedule_expression" = '15m',
    "config" = ("config" - 'maxMessages') ||
      '{"profile":"primary","promptVersion":"asuka-primary-thought-v2-zh","maxBatchMessages":50,"maxAttempts":3,"intervalSeconds":900}'::jsonb,
    "updated_at" = now()
WHERE "agent_id" = 'agent-asuka' AND "job_type" = 'thought_tick';--> statement-breakpoint
UPDATE "jobs"
SET "configurable" = true,
    "schedule_type" = 'cron',
    "schedule_expression" = '0 3 * * *',
    "config" = ("config" - 'maxMessages') ||
      '{"profile":"primary","promptVersion":"memory-v2-global-disclosure","maxBatchMessages":100,"maxAttempts":3,"dailyHour":3,"dailyMinute":0}'::jsonb,
    "updated_at" = now()
WHERE "agent_id" = 'agent-asuka' AND "job_type" = 'memory_consolidation';
--> statement-breakpoint
UPDATE "jobs"
SET "configurable" = false,
    "updated_at" = now()
WHERE "agent_id" = 'agent-asuka'
  AND "job_type" NOT IN ('thought_tick', 'memory_consolidation');
