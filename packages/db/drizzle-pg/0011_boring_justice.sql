CREATE TYPE "public"."memory_retrieval_decision" AS ENUM('returned', 'filtered', 'below_threshold');--> statement-breakpoint
CREATE TYPE "public"."memory_retrieval_mode" AS ENUM('passive', 'tool');--> statement-breakpoint
CREATE TYPE "public"."memory_sensitivity" AS ENUM('public', 'normal', 'sensitive', 'restricted');--> statement-breakpoint
CREATE TABLE "memory_retrieval_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thought_run_id" text NOT NULL,
	"mode" "memory_retrieval_mode" NOT NULL,
	"query" text NOT NULL,
	"query_hash" text NOT NULL,
	"requested_limit" integer NOT NULL,
	"minimum_relevance_millis" integer NOT NULL,
	"candidate_count" integer NOT NULL,
	"filtered_count" integer NOT NULL,
	"returned_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_items" (
	"audit_id" text NOT NULL,
	"memory_candidate_id" text NOT NULL,
	"decision" "memory_retrieval_decision" NOT NULL,
	"reason_code" text NOT NULL,
	"relevance_millis" integer,
	"rank" integer,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_retrieval_items_audit_id_memory_candidate_id_pk" PRIMARY KEY("audit_id","memory_candidate_id")
);
--> statement-breakpoint
DROP INDEX "memory_candidates_subject_idx";--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "memory_type" text DEFAULT 'fact' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "sensitivity" "memory_sensitivity" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "disclosure_policy" jsonb DEFAULT '{"scope":"subject","conversationIds":[],"participantIds":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "valid_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "valid_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD COLUMN "diff" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_retrieval_audits" ADD CONSTRAINT "memory_retrieval_audits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_audits" ADD CONSTRAINT "memory_retrieval_audits_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_audits" ADD CONSTRAINT "memory_retrieval_audits_thought_run_id_thought_runs_id_fk" FOREIGN KEY ("thought_run_id") REFERENCES "public"."thought_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_items" ADD CONSTRAINT "memory_retrieval_items_audit_id_memory_retrieval_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."memory_retrieval_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_retrieval_items" ADD CONSTRAINT "memory_retrieval_items_memory_candidate_id_memory_candidates_id_fk" FOREIGN KEY ("memory_candidate_id") REFERENCES "public"."memory_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_retrieval_audits_thought_idx" ON "memory_retrieval_audits" USING btree ("thought_run_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_retrieval_audits_conversation_idx" ON "memory_retrieval_audits" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_retrieval_items_memory_idx" ON "memory_retrieval_items" USING btree ("memory_candidate_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_candidates_agent_subject_idx" ON "memory_candidates" USING btree ("agent_id","subject_id","status");--> statement-breakpoint
CREATE INDEX "memory_candidates_target_idx" ON "memory_candidates" USING btree ("target_candidate_id");