ALTER TABLE "thought_runs" ADD COLUMN "primary_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "primary_output" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "primary_output_hash" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "primary_prompt_version" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "primary_stop_reason" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "primary_completed_at" timestamp with time zone;