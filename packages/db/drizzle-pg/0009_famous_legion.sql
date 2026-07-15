CREATE TYPE "public"."outbound_delivery_status" AS ENUM('queued', 'sending', 'awaiting_response', 'sent', 'retry_wait', 'failed', 'failed_uncertain', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."speech_decision_outcome" AS ENUM('silent', 'defer', 'blocked', 'shadow_speak', 'speak');--> statement-breakpoint
CREATE TYPE "public"."speech_feedback_label" AS ENUM('send', 'defer', 'silent');--> statement-breakpoint
CREATE TABLE "outbound_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"speech_decision_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"echo" text NOT NULL,
	"status" "outbound_delivery_status" DEFAULT 'queued' NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"external_message_id" text,
	"response_json" jsonb,
	"last_error_code" text,
	"last_error_message" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_policies" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"quiet_start_minute" integer DEFAULT 0 NOT NULL,
	"quiet_end_minute" integer DEFAULT 0 NOT NULL,
	"daily_budget" integer DEFAULT 10 NOT NULL,
	"cooldown_seconds" integer DEFAULT 300 NOT NULL,
	"duplicate_window_seconds" integer DEFAULT 86400 NOT NULL,
	"freshness_seconds" integer DEFAULT 1800 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"thought_run_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"outcome" "speech_decision_outcome" NOT NULL,
	"reason_code" text NOT NULL,
	"draft" text NOT NULL,
	"content_hash" text NOT NULL,
	"evidence_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_evaluation_at" timestamp with time zone,
	"evaluation_count" integer DEFAULT 1 NOT NULL,
	"feedback_label" "speech_feedback_label",
	"feedback_note" text,
	"feedback_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_speech_decision_id_speech_decisions_id_fk" FOREIGN KEY ("speech_decision_id") REFERENCES "public"."speech_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_deliveries" ADD CONSTRAINT "outbound_deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_policies" ADD CONSTRAINT "outbound_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_decisions" ADD CONSTRAINT "speech_decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_decisions" ADD CONSTRAINT "speech_decisions_thought_run_id_thought_runs_id_fk" FOREIGN KEY ("thought_run_id") REFERENCES "public"."thought_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_decisions" ADD CONSTRAINT "speech_decisions_proposal_id_action_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."action_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speech_decisions" ADD CONSTRAINT "speech_decisions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_deliveries_decision_uidx" ON "outbound_deliveries" USING btree ("speech_decision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_deliveries_echo_uidx" ON "outbound_deliveries" USING btree ("echo");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_claim_idx" ON "outbound_deliveries" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "outbound_deliveries_channel_idx" ON "outbound_deliveries" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "speech_decisions_proposal_uidx" ON "speech_decisions" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "speech_decisions_thought_proposal_uidx" ON "speech_decisions" USING btree ("thought_run_id","proposal_id");--> statement-breakpoint
CREATE INDEX "speech_decisions_conversation_time_idx" ON "speech_decisions" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "speech_decisions_deferred_idx" ON "speech_decisions" USING btree ("outcome","next_evaluation_at");--> statement-breakpoint
CREATE INDEX "speech_decisions_content_idx" ON "speech_decisions" USING btree ("conversation_id","content_hash");
--> statement-breakpoint
INSERT INTO "outbound_policies" (
  "agent_id", "enabled", "timezone", "quiet_start_minute",
  "quiet_end_minute", "daily_budget", "cooldown_seconds",
  "duplicate_window_seconds", "freshness_seconds", "created_at", "updated_at"
) VALUES (
  'agent-asuka', false, 'Asia/Shanghai', 0, 0, 10, 300, 86400, 1800,
  now(), now()
)
ON CONFLICT ("agent_id") DO NOTHING;
