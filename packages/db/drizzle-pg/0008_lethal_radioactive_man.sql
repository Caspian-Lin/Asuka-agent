ALTER TABLE "thought_runs" ADD COLUMN "compiler_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "compiler_status" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "compiler_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "compiler_prompt_version" text;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "revision_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thought_runs" ADD COLUMN "compiled_at" timestamp with time zone;