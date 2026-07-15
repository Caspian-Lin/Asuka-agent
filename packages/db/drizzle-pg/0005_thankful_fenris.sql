CREATE TABLE "llm_call_context_items" (
	"id" text PRIMARY KEY NOT NULL,
	"llm_call_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"item_type" text NOT NULL,
	"reference_id" text,
	"title" text NOT NULL,
	"content" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thought_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"job_run_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_reason" text NOT NULL,
	"status" text NOT NULL,
	"decision" text,
	"summary" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "thought_run_id" text;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "sequence_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "request_context" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "response_json" jsonb;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "thought_run_id" text;--> statement-breakpoint
ALTER TABLE "operational_thoughts" ADD COLUMN "thought_run_id" text;--> statement-breakpoint
INSERT INTO "thought_runs" (
	"id", "agent_id", "conversation_id", "job_run_id", "correlation_id",
	"trigger_type", "trigger_reason", "status", "decision", "summary",
	"started_at", "completed_at", "created_at"
)
SELECT
	'thought-run:legacy:' || call."job_run_id" || ':' || call."conversation_id",
	job."agent_id",
	call."conversation_id",
	call."job_run_id",
	run."correlation_id",
	run."trigger_type",
	CASE job."job_type"
		WHEN 'memory_consolidation' THEN '定时整理新增消息并生成记忆候选'
		ELSE '定时检查新增消息并决定是否形成可执行思绪'
	END,
	CASE WHEN bool_or(call."status" = 'succeeded') THEN 'completed' ELSE run."status" END,
	max(thought."decision"),
	max(COALESCE(thought."intent", candidate."claim")),
	min(call."created_at"),
	run."completed_at",
	min(call."created_at")
FROM "llm_calls" call
JOIN "job_runs" run ON run."id" = call."job_run_id"
JOIN "jobs" job ON job."id" = run."job_id"
LEFT JOIN "operational_thoughts" thought
	ON thought."job_run_id" = call."job_run_id"
	AND thought."conversation_id" = call."conversation_id"
LEFT JOIN "memory_candidates" candidate
	ON candidate."job_run_id" = call."job_run_id"
	AND candidate."conversation_id" = call."conversation_id"
WHERE call."conversation_id" IS NOT NULL
GROUP BY call."job_run_id", call."conversation_id", job."agent_id", job."job_type",
	run."correlation_id", run."trigger_type", run."status", run."completed_at";--> statement-breakpoint
WITH numbered AS (
	SELECT "id",
		'thought-run:legacy:' || "job_run_id" || ':' || "conversation_id" AS "thought_run_id",
		row_number() OVER (
			PARTITION BY "job_run_id", "conversation_id"
			ORDER BY "created_at", "id"
		) AS "sequence_number"
	FROM "llm_calls"
	WHERE "conversation_id" IS NOT NULL
)
UPDATE "llm_calls" call
SET "thought_run_id" = numbered."thought_run_id",
	"sequence_number" = numbered."sequence_number"
FROM numbered
WHERE call."id" = numbered."id";--> statement-breakpoint
UPDATE "memory_candidates" candidate
SET "thought_run_id" = 'thought-run:legacy:' || candidate."job_run_id" || ':' || candidate."conversation_id";--> statement-breakpoint
UPDATE "operational_thoughts" thought
SET "thought_run_id" = 'thought-run:legacy:' || thought."job_run_id" || ':' || thought."conversation_id";--> statement-breakpoint
ALTER TABLE "llm_calls" ALTER COLUMN "thought_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ALTER COLUMN "thought_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "operational_thoughts" ALTER COLUMN "thought_run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_call_context_items" ADD CONSTRAINT "llm_call_context_items_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD CONSTRAINT "thought_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD CONSTRAINT "thought_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD CONSTRAINT "thought_runs_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_call_context_items_ordinal_uidx" ON "llm_call_context_items" USING btree ("llm_call_id","ordinal");--> statement-breakpoint
CREATE INDEX "llm_call_context_items_reference_idx" ON "llm_call_context_items" USING btree ("item_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thought_runs_job_conversation_uidx" ON "thought_runs" USING btree ("job_run_id","conversation_id");--> statement-breakpoint
CREATE INDEX "thought_runs_conversation_time_idx" ON "thought_runs" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "thought_runs_trigger_time_idx" ON "thought_runs" USING btree ("trigger_type","created_at");--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_thought_run_id_thought_runs_id_fk" FOREIGN KEY ("thought_run_id") REFERENCES "public"."thought_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_thought_run_id_thought_runs_id_fk" FOREIGN KEY ("thought_run_id") REFERENCES "public"."thought_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_thoughts" ADD CONSTRAINT "operational_thoughts_thought_run_id_thought_runs_id_fk" FOREIGN KEY ("thought_run_id") REFERENCES "public"."thought_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_calls_thought_sequence_uidx" ON "llm_calls" USING btree ("thought_run_id","sequence_number");--> statement-breakpoint
CREATE INDEX "memory_candidates_thought_run_idx" ON "memory_candidates" USING btree ("thought_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operational_thoughts_thought_run_uidx" ON "operational_thoughts" USING btree ("thought_run_id");
