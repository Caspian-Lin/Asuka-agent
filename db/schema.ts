import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  mode: text("mode").notNull().default("shadow"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    channel: text("channel").notNull().default("web"),
    externalId: text("external_id"),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("conversations_agent_idx").on(table.agentId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    citationsJson: text("citations_json").notNull().default("[]"),
    correlationId: text("correlation_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("messages_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id"),
    eventType: text("event_type").notNull(),
    sourceType: text("source_type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    correlationId: text("correlation_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("events_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("events_type_idx").on(table.eventType),
  ],
);

export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    entityType: text("entity_type").notNull(),
    aliasesJson: text("aliases_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("entities_name_type_uidx").on(
      table.canonicalName,
      table.entityType,
    ),
  ],
);

export const eventEntities = sqliteTable(
  "event_entities",
  {
    eventId: text("event_id").notNull(),
    entityId: text("entity_id").notNull(),
    relation: text("relation").notNull().default("mentions"),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.entityId, table.relation] }),
    index("event_entities_entity_idx").on(table.entityId),
  ],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    memoryType: text("memory_type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("candidate"),
    sourceType: text("source_type").notNull(),
    confidence: real("confidence").notNull().default(0.5),
    importance: real("importance").notNull().default(0.5),
    accessScope: text("access_scope").notNull().default("private"),
    sensitivity: text("sensitivity").notNull().default("normal"),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    recordedAt: text("recorded_at").notNull(),
    supersededAt: text("superseded_at"),
    retrieveCount: integer("retrieve_count").notNull().default(0),
    helpfulUseCount: integer("helpful_use_count").notNull().default(0),
    lastRetrievedAt: text("last_retrieved_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("memories_agent_status_idx").on(table.agentId, table.status),
    index("memories_type_idx").on(table.memoryType),
  ],
);

export const memoryEvidence = sqliteTable(
  "memory_evidence",
  {
    memoryId: text("memory_id").notNull(),
    eventId: text("event_id").notNull(),
    evidenceRole: text("evidence_role").notNull().default("supports"),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.eventId] }),
    index("memory_evidence_event_idx").on(table.eventId),
  ],
);

export const memoryLinks = sqliteTable(
  "memory_links",
  {
    sourceMemoryId: text("source_memory_id").notNull(),
    targetMemoryId: text("target_memory_id").notNull(),
    linkType: text("link_type").notNull(),
    confidence: real("confidence").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sourceMemoryId, table.targetMemoryId, table.linkType],
    }),
  ],
);

export const thoughts = sqliteTable(
  "thoughts",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").notNull(),
    content: text("content").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    confidence: real("confidence").notNull(),
    novelty: real("novelty").notNull(),
    urgency: real("urgency").notNull(),
    expectedValue: real("expected_value").notNull(),
    risk: real("risk").notNull(),
    decision: text("decision").notNull().default("shadow"),
    humanLabel: text("human_label"),
    labelNote: text("label_note"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("thoughts_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const evaluationCases = sqliteTable(
  "evaluation_cases",
  {
    id: text("id").primaryKey(),
    suite: text("suite").notNull(),
    category: text("category").notNull(),
    prompt: text("prompt").notNull(),
    expectedJson: text("expected_json").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("evaluation_cases_suite_idx").on(table.suite)],
);

export const evaluationRuns = sqliteTable(
  "evaluation_runs",
  {
    id: text("id").primaryKey(),
    suite: text("suite").notNull(),
    status: text("status").notNull(),
    summaryJson: text("summary_json").notNull().default("{}"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [index("evaluation_runs_time_idx").on(table.startedAt)],
);

export const evaluationResults = sqliteTable(
  "evaluation_results",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    caseId: text("case_id").notNull(),
    predictedJson: text("predicted_json").notNull(),
    metricsJson: text("metrics_json").notNull(),
    score: real("score").notNull(),
    passed: integer("passed", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("evaluation_results_run_idx").on(table.runId),
    uniqueIndex("evaluation_results_run_case_uidx").on(
      table.runId,
      table.caseId,
    ),
  ],
);

export const agentSettings = sqliteTable("agent_settings", {
  agentId: text("agent_id").primaryKey(),
  shadowMode: integer("shadow_mode", { mode: "boolean" })
    .notNull()
    .default(true),
  quietHoursStart: text("quiet_hours_start").notNull().default("23:00"),
  quietHoursEnd: text("quiet_hours_end").notNull().default("08:00"),
  dailyProactiveBudget: integer("daily_proactive_budget").notNull().default(3),
  modelMode: text("model_mode").notNull().default("deterministic_mvp"),
  updatedAt: text("updated_at").notNull(),
});
