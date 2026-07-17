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

export const messageAuthorKind = pgEnum("message_author_kind", [
  "user",
  "agent",
  "system",
]);

export const messageDirection = pgEnum("message_direction", [
  "inbound",
  "outbound",
  "internal",
]);

export const thoughtStreamStatus = pgEnum("thought_stream_status", [
  "active",
  "paused",
  "archived",
]);

export const thoughtEpochStatus = pgEnum("thought_epoch_status", [
  "active",
  "compressing",
  "closed",
  "failed",
]);

export const thoughtRunStage = pgEnum("thought_run_stage", [
  "pending",
  "primary",
  "compiler",
  "revision",
  "committing",
  "completed",
  "failed",
]);

export const llmCallPurpose = pgEnum("llm_call_purpose", [
  "primary",
  "tool_continuation",
  "compiler",
  "revision",
  "compression",
]);

export const actionProposalType = pgEnum("action_proposal_type", [
  "reply",
  "memory",
  "task",
  "no_action",
]);

export const actionProposalStatus = pgEnum("action_proposal_status", [
  "proposed",
  "policy_approved",
  "policy_rejected",
  "executing",
  "executed",
  "failed",
  "cancelled",
]);

export const memorySensitivity = pgEnum("memory_sensitivity", [
  "public",
  "normal",
  "sensitive",
  "restricted",
]);

export const memoryRetrievalMode = pgEnum("memory_retrieval_mode", [
  "passive",
  "tool",
]);

export const memoryRetrievalDecision = pgEnum("memory_retrieval_decision", [
  "returned",
  "filtered",
  "below_threshold",
]);

export const speechDecisionOutcome = pgEnum("speech_decision_outcome", [
  "silent",
  "defer",
  "blocked",
  "shadow_speak",
  "speak",
]);

export const speechFeedbackLabel = pgEnum("speech_feedback_label", [
  "send",
  "defer",
  "silent",
]);

export const outboundDeliveryStatus = pgEnum("outbound_delivery_status", [
  "queued",
  "sending",
  "awaiting_response",
  "sent",
  "retry_wait",
  "failed",
  "failed_uncertain",
  "cancelled",
]);

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

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    participantId: text("participant_id").notNull(),
    displayName: text("display_name").notNull(),
    aliases: jsonb("aliases").notNull().default([]),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.participantId] }),
    index("conversation_participants_last_seen_idx").on(
      table.conversationId,
      table.lastSeenAt,
    ),
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
    authorKind: messageAuthorKind("author_kind").notNull().default("user"),
    direction: messageDirection("direction").notNull().default("inbound"),
    content: text("content").notNull(),
    senderId: text("sender_id"),
    senderDisplayName: text("sender_display_name"),
    replyToExternalMessageId: text("reply_to_external_message_id"),
    externalMessageId: text("external_message_id"),
    externalReceipt: jsonb("external_receipt").notNull().default({}),
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
    index("messages_sender_idx").on(table.conversationId, table.senderId),
    uniqueIndex("messages_conversation_external_uidx")
      .on(table.conversationId, table.externalMessageId)
      .where(sql`${table.externalMessageId} is not null`),
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
    correlationId: text("correlation_id").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    metrics: jsonb("metrics").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("job_runs_idempotency_uidx").on(table.idempotencyKey),
    index("job_runs_job_time_idx").on(table.jobId, table.startedAt),
    index("job_runs_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
  ],
);

/** One persistent, conversation-isolated short-term cognition stream. */
export const thoughtStreams = pgTable(
  "thought_streams",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    status: thoughtStreamStatus("status").notNull().default("active"),
    currentEpochOrdinal: integer("current_epoch_ordinal").notNull().default(1),
    committedMessageAt: timestamp("committed_message_at", { withTimezone: true }),
    committedMessageId: text("committed_message_id"),
    version: integer("version").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("thought_streams_agent_conversation_uidx").on(
      table.agentId,
      table.conversationId,
    ),
    index("thought_streams_status_idx").on(table.status, table.updatedAt),
    index("thought_streams_lease_idx").on(table.leaseExpiresAt),
  ],
);

/** An append-only context epoch; compression closes one epoch and opens another. */
export const thoughtStreamEpochs = pgTable(
  "thought_stream_epochs",
  {
    id: text("id").primaryKey(),
    streamId: text("stream_id")
      .notNull()
      .references(() => thoughtStreams.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    status: thoughtEpochStatus("status").notNull().default("active"),
    compressionOutput: text("compression_output"),
    compressionPromptVersion: text("compression_prompt_version"),
    coversThroughThoughtRunId: text("covers_through_thought_run_id"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("thought_stream_epochs_stream_ordinal_uidx").on(
      table.streamId,
      table.ordinal,
    ),
    index("thought_stream_epochs_status_idx").on(table.streamId, table.status),
  ],
);

/** One inspectable cognition process for one conversation and trigger. */
export const thoughtRuns = pgTable(
  "thought_runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    streamId: text("stream_id")
      .notNull()
      .references(() => thoughtStreams.id, { onDelete: "cascade" }),
    epochId: text("epoch_id")
      .notNull()
      .references(() => thoughtStreamEpochs.id, { onDelete: "restrict" }),
    turnOrdinal: integer("turn_ordinal").notNull(),
    jobRunId: text("job_run_id")
      .notNull()
      .references(() => jobRuns.id, { onDelete: "cascade" }),
    correlationId: text("correlation_id").notNull(),
    triggerType: text("trigger_type").notNull(),
    triggerReason: text("trigger_reason").notNull(),
    status: text("status").notNull(),
    processingStage: thoughtRunStage("processing_stage").notNull().default("pending"),
    newMessageStartAt: timestamp("new_message_start_at", { withTimezone: true }),
    newMessageStartId: text("new_message_start_id"),
    newMessageEndAt: timestamp("new_message_end_at", { withTimezone: true }),
    newMessageEndId: text("new_message_end_id"),
    primaryState: jsonb("primary_state").notNull().default({}),
    primaryOutput: text("primary_output"),
    primaryOutputHash: text("primary_output_hash"),
    primaryPromptVersion: text("primary_prompt_version"),
    primaryStopReason: text("primary_stop_reason"),
    primaryCompletedAt: timestamp("primary_completed_at", { withTimezone: true }),
    compilerState: jsonb("compiler_state").notNull().default({}),
    compilerStatus: text("compiler_status"),
    compilerAttemptCount: integer("compiler_attempt_count").notNull().default(0),
    compilerPromptVersion: text("compiler_prompt_version"),
    revisionCount: integer("revision_count").notNull().default(0),
    compiledAt: timestamp("compiled_at", { withTimezone: true }),
    decision: text("decision"),
    summary: text("summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("thought_runs_job_conversation_uidx").on(
      table.jobRunId,
      table.conversationId,
    ),
    index("thought_runs_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("thought_runs_trigger_time_idx").on(table.triggerType, table.createdAt),
    uniqueIndex("thought_runs_stream_turn_uidx").on(
      table.streamId,
      table.turnOrdinal,
    ),
    index("thought_runs_epoch_turn_idx").on(table.epochId, table.turnOrdinal),
  ],
);

export const jobConversationWatermarks = pgTable(
  "job_conversation_watermarks",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessageId: text("last_message_id"),
    lastSuccessRunId: text("last_success_run_id")
      .references(() => jobRuns.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.jobId, table.conversationId] })],
);

export const operationalThoughts = pgTable(
  "operational_thoughts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    jobRunId: text("job_run_id")
      .notNull()
      .references(() => jobRuns.id, { onDelete: "cascade" }),
    thoughtRunId: text("thought_run_id")
      .notNull()
      .references(() => thoughtRuns.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    intent: text("intent").notNull(),
    basis: text("basis").notNull(),
    evidenceMessageIds: jsonb("evidence_message_ids").notNull(),
    confidenceMillis: integer("confidence_millis").notNull(),
    risk: text("risk").notNull(),
    decision: text("decision").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("operational_thoughts_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("operational_thoughts_thought_run_uidx").on(table.thoughtRunId),
    index("operational_thoughts_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const memoryCandidates = pgTable(
  "memory_candidates",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    jobRunId: text("job_run_id")
      .notNull()
      .references(() => jobRuns.id, { onDelete: "cascade" }),
    thoughtRunId: text("thought_run_id")
      .notNull()
      .references(() => thoughtRuns.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    memoryType: text("memory_type").notNull().default("fact"),
    subjectId: text("subject_id"),
    sourceSpeakerId: text("source_speaker_id").notNull(),
    claim: text("claim").notNull(),
    evidenceMessageIds: jsonb("evidence_message_ids").notNull(),
    confidenceMillis: integer("confidence_millis").notNull(),
    attributionStatus: text("attribution_status").notNull(),
    sensitivity: memorySensitivity("sensitivity").notNull().default("normal"),
    disclosurePolicy: jsonb("disclosure_policy").notNull().default({
      scope: "subject",
      conversationIds: [],
      participantIds: [],
    }),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    targetCandidateId: text("target_candidate_id"),
    diff: jsonb("diff").notNull().default({}),
    status: text("status").notNull().default("pending_review"),
    promptVersion: text("prompt_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("memory_candidates_idempotency_uidx").on(table.idempotencyKey),
    index("memory_candidates_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("memory_candidates_agent_subject_idx").on(
      table.agentId,
      table.subjectId,
      table.status,
    ),
    index("memory_candidates_target_idx").on(table.targetCandidateId),
    index("memory_candidates_thought_run_idx").on(table.thoughtRunId),
  ],
);

/** One auditable global-memory query, including empty and fully denied results. */
export const memoryRetrievalAudits = pgTable(
  "memory_retrieval_audits",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    thoughtRunId: text("thought_run_id")
      .notNull()
      .references(() => thoughtRuns.id, { onDelete: "cascade" }),
    mode: memoryRetrievalMode("mode").notNull(),
    query: text("query").notNull(),
    queryHash: text("query_hash").notNull(),
    requestedLimit: integer("requested_limit").notNull(),
    minimumRelevanceMillis: integer("minimum_relevance_millis").notNull(),
    candidateCount: integer("candidate_count").notNull(),
    filteredCount: integer("filtered_count").notNull(),
    returnedCount: integer("returned_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("memory_retrieval_audits_thought_idx").on(
      table.thoughtRunId,
      table.createdAt,
    ),
    index("memory_retrieval_audits_conversation_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

/** Per-memory policy and threshold outcome for a retrieval audit. */
export const memoryRetrievalItems = pgTable(
  "memory_retrieval_items",
  {
    auditId: text("audit_id")
      .notNull()
      .references(() => memoryRetrievalAudits.id, { onDelete: "cascade" }),
    memoryCandidateId: text("memory_candidate_id")
      .notNull()
      .references(() => memoryCandidates.id, { onDelete: "cascade" }),
    decision: memoryRetrievalDecision("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    relevanceMillis: integer("relevance_millis"),
    rank: integer("rank"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.auditId, table.memoryCandidateId] }),
    index("memory_retrieval_items_memory_idx").on(
      table.memoryCandidateId,
      table.createdAt,
    ),
  ],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    jobRunId: text("job_run_id")
      .notNull()
      .references(() => jobRuns.id, { onDelete: "cascade" }),
    thoughtRunId: text("thought_run_id")
      .notNull()
      .references(() => thoughtRuns.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .references(() => conversations.id, { onDelete: "set null" }),
    correlationId: text("correlation_id").notNull(),
    profile: llmProfile("profile").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    purpose: llmCallPurpose("purpose").notNull().default("primary"),
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash"),
    status: text("status").notNull(),
    errorCode: text("error_code"),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    sequenceNumber: integer("sequence_number").notNull().default(1),
    requestContext: jsonb("request_context").notNull().default([]),
    responseJson: jsonb("response_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("llm_calls_run_idx").on(table.jobRunId, table.createdAt),
    uniqueIndex("llm_calls_thought_sequence_uidx").on(
      table.thoughtRunId,
      table.sequenceNumber,
    ),
  ],
);

/** A compiler result awaiting deterministic policy evaluation and execution. */
export const actionProposals = pgTable(
  "action_proposals",
  {
    id: text("id").primaryKey(),
    thoughtRunId: text("thought_run_id")
      .notNull()
      .references(() => thoughtRuns.id, { onDelete: "cascade" }),
    compilerLlmCallId: text("compiler_llm_call_id")
      .references(() => llmCalls.id, { onDelete: "set null" }),
    ordinal: integer("ordinal").notNull(),
    proposalType: actionProposalType("proposal_type").notNull(),
    status: actionProposalStatus("status").notNull().default("proposed"),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    evidenceReferences: jsonb("evidence_references").notNull().default([]),
    policyReasons: jsonb("policy_reasons").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("action_proposals_idempotency_uidx").on(table.idempotencyKey),
    uniqueIndex("action_proposals_thought_ordinal_uidx").on(
      table.thoughtRunId,
      table.ordinal,
    ),
    index("action_proposals_status_idx").on(table.status, table.createdAt),
    index("action_proposals_compiler_call_idx").on(table.compilerLlmCallId),
  ],
);

/** Owner-controlled hard policy; model output cannot modify this row. */
export const outboundPolicies = pgTable("outbound_policies", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  timezone: text("timezone").notNull().default("Asia/Shanghai"),
  quietStartMinute: integer("quiet_start_minute").notNull().default(0),
  quietEndMinute: integer("quiet_end_minute").notNull().default(0),
  dailyBudget: integer("daily_budget").notNull().default(10),
  cooldownSeconds: integer("cooldown_seconds").notNull().default(300),
  duplicateWindowSeconds: integer("duplicate_window_seconds").notNull().default(86_400),
  freshnessSeconds: integer("freshness_seconds").notNull().default(1_800),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/** Auditable semantic decision plus deterministic hard-policy result. */
export const speechDecisions = pgTable(
  "speech_decisions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    thoughtRunId: text("thought_run_id")
      .notNull()
      .references(() => thoughtRuns.id, { onDelete: "cascade" }),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => actionProposals.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    outcome: speechDecisionOutcome("outcome").notNull(),
    reasonCode: text("reason_code").notNull(),
    draft: text("draft").notNull(),
    contentHash: text("content_hash").notNull(),
    evidenceReferences: jsonb("evidence_references").notNull().default([]),
    policySnapshot: jsonb("policy_snapshot").notNull().default({}),
    nextEvaluationAt: timestamp("next_evaluation_at", { withTimezone: true }),
    evaluationCount: integer("evaluation_count").notNull().default(1),
    feedbackLabel: speechFeedbackLabel("feedback_label"),
    feedbackNote: text("feedback_note"),
    feedbackAt: timestamp("feedback_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("speech_decisions_proposal_uidx").on(table.proposalId),
    uniqueIndex("speech_decisions_thought_proposal_uidx").on(
      table.thoughtRunId,
      table.proposalId,
    ),
    index("speech_decisions_conversation_time_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("speech_decisions_deferred_idx").on(table.outcome, table.nextEvaluationAt),
    index("speech_decisions_content_idx").on(table.conversationId, table.contentHash),
  ],
);

/** The only queue allowed to call NapCat send actions. */
export const outboundDeliveries = pgTable(
  "outbound_deliveries",
  {
    id: text("id").primaryKey(),
    speechDecisionId: text("speech_decision_id")
      .notNull()
      .references(() => speechDecisions.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    externalConversationId: text("external_conversation_id").notNull(),
    echo: text("echo").notNull(),
    status: outboundDeliveryStatus("status").notNull().default("queued"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    externalMessageId: text("external_message_id"),
    responseJson: jsonb("response_json"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("outbound_deliveries_decision_uidx").on(table.speechDecisionId),
    uniqueIndex("outbound_deliveries_echo_uidx").on(table.echo),
    index("outbound_deliveries_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    index("outbound_deliveries_channel_idx").on(table.channelId, table.createdAt),
  ],
);

/** Structured references available to a specific model round. */
export const llmCallContextItems = pgTable(
  "llm_call_context_items",
  {
    id: text("id").primaryKey(),
    llmCallId: text("llm_call_id")
      .notNull()
      .references(() => llmCalls.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    itemType: text("item_type").notNull(),
    referenceId: text("reference_id"),
    title: text("title").notNull(),
    content: text("content"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("llm_call_context_items_ordinal_uidx").on(
      table.llmCallId,
      table.ordinal,
    ),
    index("llm_call_context_items_reference_idx").on(
      table.itemType,
      table.referenceId,
    ),
  ],
);
