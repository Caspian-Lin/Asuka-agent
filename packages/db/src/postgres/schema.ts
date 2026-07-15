import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  pgEnum,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  mode: text("mode").notNull().default("shadow"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const llmProfile = pgEnum("llm_profile", ["primary", "fast"]);

export const llmProfileSettings = pgTable(
  "llm_profile_settings",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    profile: llmProfile("profile").notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url").notNull(),
    modelId: text("model_id").notNull(),
    encryptedApiKey: text("encrypted_api_key"),
    contextWindow: integer("context_window").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    lastTestStatus: text("last_test_status"),
    lastTestLatencyMs: integer("last_test_latency_ms"),
    lastTestErrorCode: text("last_test_error_code"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.profile] }),
    index("llm_profile_settings_agent_idx").on(table.agentId),
  ],
);

/** Authoritative boundary for external IM accounts and deliveries. */
export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    provider: text("provider").notNull(),
    accountId: text("account_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    cursor: text("cursor"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("channels_provider_account_uidx").on(
      table.provider,
      table.accountId,
    ),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    channel: text("channel").notNull().default("web"),
    channelId: text("channel_id").references(() => channels.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id"),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("conversations_agent_idx").on(table.agentId),
    index("conversations_channel_time_idx").on(table.channelId, table.updatedAt),
    uniqueIndex("conversations_agent_channel_external_uidx")
      .on(table.agentId, table.channel, table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    citationsJson: jsonb("citations_json").notNull().default([]),
    correlationId: text("correlation_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("messages_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("messages_unread_idx")
      .on(table.conversationId, table.createdAt)
      .where(sql`${table.role} = 'user' and ${table.readAt} is null`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    eventType: text("event_type").notNull(),
    sourceType: text("source_type").notNull(),
    payloadJson: jsonb("payload_json").notNull().default({}),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("events_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("events_type_idx").on(table.eventType),
  ],
);

export const inboundDeliveries = pgTable(
  "inbound_deliveries",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    externalConversationId: text("external_conversation_id").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    senderId: text("sender_id").notNull(),
    messageType: text("message_type").notNull(),
    content: jsonb("content").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    rawHash: text("raw_hash").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("received"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("inbound_deliveries_channel_message_uidx").on(
      table.channelId,
      table.externalMessageId,
    ),
    index("inbound_deliveries_pending_idx").on(table.status, table.receivedAt),
  ],
);

export const inboundDeliveryLabels = pgTable(
  "inbound_delivery_labels",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => inboundDeliveries.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deliveryId, table.label] })],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    jobType: text("job_type").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    scheduleType: text("schedule_type").notNull(),
    scheduleExpression: text("schedule_expression").notNull(),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    configurable: boolean("configurable").notNull().default(false),
    enabled: boolean("enabled").notNull().default(false),
    status: text("status").notNull().default("planned"),
    config: jsonb("config").notNull().default({}),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("jobs_agent_type_uidx").on(table.agentId, table.jobType),
    index("jobs_status_idx").on(table.status, table.enabled),
  ],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    triggerType: text("trigger_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metrics: jsonb("metrics").notNull().default({}),
  },
  (table) => [
    uniqueIndex("job_runs_idempotency_uidx").on(table.idempotencyKey),
    index("job_runs_job_time_idx").on(table.jobId, table.startedAt),
  ],
);
