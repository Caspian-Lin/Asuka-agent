import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * The channel ingress tables are the authoritative boundary for external IM.
 * Raw payloads are retained for audit; only supported content is projected to
 * the agent message stream by a later consumer.
 */
export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    provider: text("provider").notNull(),
    accountId: text("account_id").notNull(),
    enabled: integer("enabled").notNull().default(1),
    cursor: text("cursor"),
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

export const inboundDeliveries = pgTable(
  "inbound_deliveries",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
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
    deliveryId: text("delivery_id").notNull(),
    label: text("label").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deliveryId, table.label] })],
);
