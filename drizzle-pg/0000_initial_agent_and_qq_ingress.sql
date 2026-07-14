CREATE TABLE "agents" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "mode" text NOT NULL DEFAULT 'shadow',
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'web',
  "external_id" text,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversations_agent_idx" ON "conversations" ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_agent_channel_external_uidx" ON "conversations" ("agent_id", "channel", "external_id") WHERE "external_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "citations_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "correlation_id" text NOT NULL,
  "created_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "messages_conversation_time_idx" ON "messages" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE TABLE "events" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text,
  "event_type" text NOT NULL,
  "source_type" text NOT NULL,
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "correlation_id" text NOT NULL,
  "created_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "events_conversation_time_idx" ON "events" ("conversation_id", "created_at");
--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" ("event_type");
--> statement-breakpoint
CREATE TABLE "channels" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "provider" text NOT NULL,
  "account_id" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "cursor" text,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  UNIQUE("provider", "account_id")
);
--> statement-breakpoint
CREATE TABLE "inbound_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "channel_id" text NOT NULL REFERENCES "channels"("id"),
  "external_conversation_id" text NOT NULL,
  "external_message_id" text NOT NULL,
  "sender_id" text NOT NULL,
  "message_type" text NOT NULL,
  "content" jsonb NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "raw_hash" text NOT NULL,
  "sent_at" timestamptz,
  "received_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'received',
  "attempts" integer NOT NULL DEFAULT 0,
  "claimed_at" timestamptz,
  "processed_at" timestamptz,
  "last_error" text,
  UNIQUE("channel_id", "external_message_id")
);
--> statement-breakpoint
CREATE INDEX "inbound_deliveries_pending_idx" ON "inbound_deliveries" ("status", "received_at");
--> statement-breakpoint
CREATE TABLE "inbound_delivery_labels" (
  "delivery_id" text NOT NULL REFERENCES "inbound_deliveries"("id"),
  "label" text NOT NULL,
  PRIMARY KEY("delivery_id", "label")
);
