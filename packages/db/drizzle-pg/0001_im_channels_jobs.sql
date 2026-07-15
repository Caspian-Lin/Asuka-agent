INSERT INTO "agents" ("id", "name", "description", "mode", "created_at", "updated_at")
VALUES (
  'agent-asuka',
  'Asuka Agent',
  '可追溯、可评测、支持 IM Channel 的持续型聊天 Agent',
  'shadow',
  now(),
  now()
)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "updated_at" = EXCLUDED."updated_at";
--> statement-breakpoint
UPDATE "channels" SET "agent_id" = 'agent-asuka' WHERE "agent_id" = 'agent-purr';
--> statement-breakpoint
UPDATE "conversations" SET "agent_id" = 'agent-asuka' WHERE "agent_id" = 'agent-purr';
--> statement-breakpoint
DELETE FROM "agents" WHERE "id" = 'agent-purr';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "read_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "job_type" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "schedule_type" text NOT NULL,
  "schedule_expression" text NOT NULL,
  "timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
  "configurable" boolean DEFAULT false NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "status" text DEFAULT 'planned' NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL,
  "status" text NOT NULL,
  "trigger_type" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "error_code" text,
  "error_message" text,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_provider_account_id_key";
--> statement-breakpoint
ALTER TABLE "inbound_deliveries" DROP CONSTRAINT "inbound_deliveries_channel_id_external_message_id_key";
--> statement-breakpoint
ALTER TABLE "inbound_deliveries" DROP CONSTRAINT "inbound_deliveries_channel_id_fkey";
--> statement-breakpoint
ALTER TABLE "inbound_delivery_labels" DROP CONSTRAINT "inbound_delivery_labels_delivery_id_fkey";
--> statement-breakpoint
ALTER TABLE "inbound_delivery_labels" RENAME CONSTRAINT "inbound_delivery_labels_pkey" TO "inbound_delivery_labels_delivery_id_label_pk";
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "inbound_deliveries" ADD CONSTRAINT "inbound_deliveries_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "inbound_delivery_labels" ADD CONSTRAINT "inbound_delivery_labels_delivery_id_inbound_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "inbound_deliveries"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id");
--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "channels_provider_account_uidx" ON "channels" ("provider", "account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_deliveries_channel_message_uidx" ON "inbound_deliveries" ("channel_id", "external_message_id");
--> statement-breakpoint
CREATE INDEX "messages_unread_idx" ON "messages" ("conversation_id", "created_at") WHERE "role" = 'user' AND "read_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_agent_type_uidx" ON "jobs" ("agent_id", "job_type");
--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" ("status", "enabled");
--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_idempotency_uidx" ON "job_runs" ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "job_runs_job_time_idx" ON "job_runs" ("job_id", "started_at");
--> statement-breakpoint
INSERT INTO "jobs" (
  "id", "agent_id", "job_type", "name", "description", "schedule_type",
  "schedule_expression", "timezone", "configurable", "enabled", "status",
  "config", "created_at", "updated_at"
) VALUES
  (
    'job-qq-ingress', 'agent-asuka', 'qq_ingress', 'NapCat 消息接收',
    '通过正向 WebSocket 接收白名单群消息并写入不可变接收箱。',
    'event', 'websocket', 'Asia/Shanghai', false, true, 'active',
    '{"managedBy":"gateway"}'::jsonb, now(), now()
  ),
  (
    'job-inbound-projection', 'agent-asuka', 'inbound_projection', '入站消息投影',
    '定期从 PostgreSQL 领取新增消息并投影到会话与事件表。',
    'interval', '5s', 'Asia/Shanghai', false, true, 'active',
    '{"managedBy":"worker"}'::jsonb, now(), now()
  ),
  (
    'job-memory-consolidation', 'agent-asuka', 'memory_consolidation', '夜间记忆整理',
    '生成可审阅的摘要、归档与 supersede 提案，不直接修改事实。',
    'cron', '0 3 * * *', 'Asia/Shanghai', true, false, 'planned',
    '{"availability":"future"}'::jsonb, now(), now()
  ),
  (
    'job-evaluation-regression', 'agent-asuka', 'evaluation_regression', '定时回归评测',
    '按计划运行固定评测集并保留历史结果。',
    'cron', '0 4 * * *', 'Asia/Shanghai', true, false, 'planned',
    '{"availability":"future"}'::jsonb, now(), now()
  )
ON CONFLICT ("agent_id", "job_type") DO NOTHING;
