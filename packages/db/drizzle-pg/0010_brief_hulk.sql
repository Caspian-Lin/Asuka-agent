ALTER TABLE "llm_calls" ADD COLUMN "cached_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "thought_stream_epochs" ADD COLUMN "cached_input_tokens" integer;