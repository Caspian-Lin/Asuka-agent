CREATE TYPE "public"."llm_profile" AS ENUM('primary', 'fast');--> statement-breakpoint
CREATE TABLE "llm_profile_settings" (
	"agent_id" text NOT NULL,
	"profile" "llm_profile" NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"model_id" text NOT NULL,
	"encrypted_api_key" text,
	"context_window" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_test_status" text,
	"last_test_latency_ms" integer,
	"last_test_error_code" text,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_profile_settings_agent_id_profile_pk" PRIMARY KEY("agent_id","profile")
);
--> statement-breakpoint
ALTER TABLE "llm_profile_settings" ADD CONSTRAINT "llm_profile_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_profile_settings_agent_idx" ON "llm_profile_settings" USING btree ("agent_id");