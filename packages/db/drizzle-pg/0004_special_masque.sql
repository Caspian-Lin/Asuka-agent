CREATE TABLE "conversation_participants" (
	"conversation_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_participants_conversation_id_participant_id_pk" PRIMARY KEY("conversation_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "job_conversation_watermarks" (
	"job_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_id" text,
	"last_success_run_id" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_conversation_watermarks_job_id_conversation_id_pk" PRIMARY KEY("job_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"job_run_id" text NOT NULL,
	"conversation_id" text,
	"correlation_id" text NOT NULL,
	"profile" "llm_profile" NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"output_hash" text,
	"status" text NOT NULL,
	"error_code" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"job_run_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"operation" text NOT NULL,
	"subject_id" text,
	"source_speaker_id" text NOT NULL,
	"claim" text NOT NULL,
	"evidence_message_ids" jsonb NOT NULL,
	"confidence_millis" integer NOT NULL,
	"attribution_status" text NOT NULL,
	"target_candidate_id" text,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_thoughts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"job_run_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"intent" text NOT NULL,
	"basis" text NOT NULL,
	"evidence_message_ids" jsonb NOT NULL,
	"confidence_millis" integer NOT NULL,
	"risk" text NOT NULL,
	"decision" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "started_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "correlation_id" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_display_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_external_message_id" text;--> statement-breakpoint
UPDATE "job_runs"
SET "correlation_id" = 'job-run:' || "id",
    "scheduled_for" = "started_at",
    "available_at" = "started_at",
    "created_at" = "started_at";--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "correlation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "available_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_runs" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
UPDATE "messages" AS m
SET "sender_id" = d."sender_id",
    "sender_display_name" = COALESCE(
      NULLIF(d."raw_payload" -> 'sender' ->> 'card', ''),
      NULLIF(d."raw_payload" -> 'sender' ->> 'nickname', ''),
      d."sender_id"
    ),
    "reply_to_external_message_id" = (
      SELECT segment -> 'data' ->> 'id'
      FROM jsonb_array_elements(d."content") AS segment
      WHERE segment ->> 'type' = 'reply'
      LIMIT 1
    )
FROM "inbound_deliveries" AS d
WHERE d."id" = m."id";--> statement-breakpoint
WITH observed AS (
  SELECT
    m."conversation_id",
    d."sender_id" AS participant_id,
    COALESCE(
      NULLIF(d."raw_payload" -> 'sender' ->> 'card', ''),
      NULLIF(d."raw_payload" -> 'sender' ->> 'nickname', ''),
      d."sender_id"
    ) AS display_name,
    COALESCE(d."sent_at", d."received_at") AS observed_at
  FROM "messages" AS m
  JOIN "inbound_deliveries" AS d ON d."id" = m."id"
), participants AS (
  SELECT
    "conversation_id",
    "participant_id",
    (array_agg("display_name" ORDER BY "observed_at" DESC))[1] AS display_name,
    jsonb_agg(DISTINCT "display_name") AS aliases,
    min("observed_at") AS first_seen_at,
    max("observed_at") AS last_seen_at
  FROM observed
  GROUP BY "conversation_id", "participant_id"
)
INSERT INTO "conversation_participants" (
  "conversation_id", "participant_id", "display_name", "aliases",
  "first_seen_at", "last_seen_at"
)
SELECT
  "conversation_id", "participant_id", "display_name", "aliases",
  "first_seen_at", "last_seen_at"
FROM participants;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_conversation_watermarks" ADD CONSTRAINT "job_conversation_watermarks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_conversation_watermarks" ADD CONSTRAINT "job_conversation_watermarks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_conversation_watermarks" ADD CONSTRAINT "job_conversation_watermarks_last_success_run_id_job_runs_id_fk" FOREIGN KEY ("last_success_run_id") REFERENCES "public"."job_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_thoughts" ADD CONSTRAINT "operational_thoughts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_thoughts" ADD CONSTRAINT "operational_thoughts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_thoughts" ADD CONSTRAINT "operational_thoughts_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_participants_last_seen_idx" ON "conversation_participants" USING btree ("conversation_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "llm_calls_run_idx" ON "llm_calls" USING btree ("job_run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_candidates_idempotency_uidx" ON "memory_candidates" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "memory_candidates_conversation_time_idx" ON "memory_candidates" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_candidates_subject_idx" ON "memory_candidates" USING btree ("conversation_id","subject_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_thoughts_idempotency_uidx" ON "operational_thoughts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "operational_thoughts_conversation_time_idx" ON "operational_thoughts" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "job_runs_claim_idx" ON "job_runs" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("conversation_id","sender_id");
--> statement-breakpoint
INSERT INTO "jobs" (
  "id", "agent_id", "job_type", "name", "description", "schedule_type",
  "schedule_expression", "timezone", "configurable", "enabled", "status",
  "config", "next_run_at", "created_at", "updated_at"
) VALUES (
  'job-thought-tick', 'agent-asuka', 'thought_tick', '定时思绪整理',
  '扫描有新增消息的白名单会话，生成至多一条带证据的 Operational Thought。',
  'interval', '15m', 'Asia/Shanghai', false, true, 'active',
  '{"profile":"fast","promptVersion":"thought-v1","maxMessages":50,"maxAttempts":3,"intervalSeconds":900}'::jsonb,
  now(), now(), now()
)
ON CONFLICT ("agent_id", "job_type") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "schedule_type" = EXCLUDED."schedule_type",
  "schedule_expression" = EXCLUDED."schedule_expression",
  "timezone" = EXCLUDED."timezone",
  "configurable" = EXCLUDED."configurable",
  "enabled" = EXCLUDED."enabled",
  "status" = EXCLUDED."status",
  "config" = EXCLUDED."config",
  "next_run_at" = COALESCE("jobs"."next_run_at", EXCLUDED."next_run_at"),
  "updated_at" = now();--> statement-breakpoint
UPDATE "jobs"
SET "name" = '夜间记忆沉淀',
    "description" = '从未处理证据生成可审查的新增、更新或冲突候选，不直接激活个人事实。',
    "schedule_type" = 'cron',
    "schedule_expression" = '0 3 * * *',
    "timezone" = 'Asia/Shanghai',
    "configurable" = false,
    "enabled" = true,
    "status" = 'active',
    "config" = '{"profile":"primary","promptVersion":"memory-v1","maxMessages":100,"maxAttempts":3,"dailyHour":3}'::jsonb,
    "next_run_at" = COALESCE(
      "next_run_at",
      (
        date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
        + interval '1 day 3 hours'
      ) AT TIME ZONE 'Asia/Shanghai'
    ),
    "updated_at" = now()
WHERE "agent_id" = 'agent-asuka' AND "job_type" = 'memory_consolidation';
