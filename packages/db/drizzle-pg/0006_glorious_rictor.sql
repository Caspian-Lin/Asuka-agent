CREATE TYPE "public"."action_proposal_status" AS ENUM('proposed', 'policy_approved', 'policy_rejected', 'executing', 'executed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."action_proposal_type" AS ENUM('reply', 'memory', 'task', 'no_action');--> statement-breakpoint
CREATE TYPE "public"."llm_call_purpose" AS ENUM('primary', 'tool_continuation', 'compiler', 'revision', 'compression');--> statement-breakpoint
CREATE TYPE "public"."message_author_kind" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound', 'internal');--> statement-breakpoint
CREATE TYPE "public"."thought_epoch_status" AS ENUM('active', 'compressing', 'closed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."thought_run_stage" AS ENUM('pending', 'primary', 'compiler', 'revision', 'committing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."thought_stream_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "action_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"thought_run_id" text NOT NULL,
	"compiler_llm_call_id" text,
	"ordinal" integer NOT NULL,
	"proposal_type" "action_proposal_type" NOT NULL,
	"status" "action_proposal_status" DEFAULT 'proposed' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thought_stream_epochs" (
	"id" text PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"status" "thought_epoch_status" DEFAULT 'active' NOT NULL,
	"compression_output" text,
	"compression_prompt_version" text,
	"covers_through_thought_run_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thought_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"status" "thought_stream_status" DEFAULT 'active' NOT NULL,
	"current_epoch_ordinal" integer DEFAULT 1 NOT NULL,
	"committed_message_at" timestamp with time zone,
	"committed_message_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "purpose" "llm_call_purpose" DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_kind" "message_author_kind" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "direction" "message_direction" DEFAULT 'inbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "external_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "external_receipt" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "stream_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "epoch_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "turn_ordinal" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "processing_stage" "thought_run_stage" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "new_message_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "new_message_start_id" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "new_message_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "new_message_end_id" text;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_thought_run_id_thought_runs_id_fk" FOREIGN KEY ("thought_run_id") REFERENCES "public"."thought_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_proposals" ADD CONSTRAINT "action_proposals_compiler_llm_call_id_llm_calls_id_fk" FOREIGN KEY ("compiler_llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_stream_epochs" ADD CONSTRAINT "thought_stream_epochs_stream_id_thought_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."thought_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_streams" ADD CONSTRAINT "thought_streams_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_streams" ADD CONSTRAINT "thought_streams_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_idempotency_uidx" ON "action_proposals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "action_proposals_thought_ordinal_uidx" ON "action_proposals" USING btree ("thought_run_id","ordinal");--> statement-breakpoint
CREATE INDEX "action_proposals_status_idx" ON "action_proposals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "action_proposals_compiler_call_idx" ON "action_proposals" USING btree ("compiler_llm_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thought_stream_epochs_stream_ordinal_uidx" ON "thought_stream_epochs" USING btree ("stream_id","ordinal");--> statement-breakpoint
CREATE INDEX "thought_stream_epochs_status_idx" ON "thought_stream_epochs" USING btree ("stream_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "thought_streams_agent_conversation_uidx" ON "thought_streams" USING btree ("agent_id","conversation_id");--> statement-breakpoint
CREATE INDEX "thought_streams_status_idx" ON "thought_streams" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "thought_streams_lease_idx" ON "thought_streams" USING btree ("lease_expires_at");--> statement-breakpoint
ALTER TABLE "thought_runs" ADD CONSTRAINT "thought_runs_stream_id_thought_streams_id_fk" FOREIGN KEY ("stream_id") REFERENCES "public"."thought_streams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD CONSTRAINT "thought_runs_epoch_id_thought_stream_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."thought_stream_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_external_uidx" ON "messages" USING btree ("conversation_id","external_message_id") WHERE "messages"."external_message_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "thought_runs_stream_turn_uidx" ON "thought_runs" USING btree ("stream_id","turn_ordinal");--> statement-breakpoint
CREATE INDEX "thought_runs_epoch_turn_idx" ON "thought_runs" USING btree ("epoch_id","turn_ordinal");