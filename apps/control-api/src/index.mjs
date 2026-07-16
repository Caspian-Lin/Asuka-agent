import http from "node:http";
import { randomUUID } from "node:crypto";
import { databaseConfig, positiveInteger } from "@asuka-agent/config";
import { LlmConfigurationError } from "@asuka-agent/llm/runtime";
import postgres from "postgres";
import { createJobsService, JobRequestError } from "./jobs-service.mjs";
import { createLlmSettingsService } from "./llm-settings-service.mjs";
import {
  createOutboundService,
  OutboundRequestError,
} from "./outbound-service.mjs";
import {
  createThoughtStreamService,
  ThoughtStreamRequestError,
} from "./thought-stream-service.mjs";

const host = process.env.CONTROL_API_HOST ?? "127.0.0.1";
const port = positiveInteger(process.env, "CONTROL_API_PORT", 3002);
const database = databaseConfig(process.env, "the control API");
const sql = postgres(database.url, { ssl: database.ssl });

const llmSettingsRepository = {
  list(agentId) {
    return sql`
      SELECT profile, display_name, base_url, model_id,
             (encrypted_api_key IS NOT NULL) AS key_configured,
             context_window, enabled, last_test_status, last_test_latency_ms,
             last_test_error_code, last_tested_at, updated_at
      FROM llm_profile_settings
      WHERE agent_id = ${agentId}
      ORDER BY profile
    `;
  },
  async get(agentId, profile) {
    const rows = await sql`
      SELECT profile, display_name, base_url, model_id, encrypted_api_key,
             context_window, enabled, last_test_status, last_test_latency_ms,
             last_test_error_code, last_tested_at, updated_at
      FROM llm_profile_settings
      WHERE agent_id = ${agentId} AND profile = ${profile}
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
  async upsert(agentId, settings) {
    const rows = await sql`
      INSERT INTO llm_profile_settings (
        agent_id, profile, display_name, base_url, model_id,
        encrypted_api_key, context_window, enabled, created_at, updated_at
      ) VALUES (
        ${agentId}, ${settings.profile}, ${settings.displayName},
        ${settings.baseUrl}, ${settings.modelId}, ${settings.encryptedApiKey},
        ${settings.contextWindow}, ${settings.enabled}, now(), now()
      )
      ON CONFLICT (agent_id, profile) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        base_url = EXCLUDED.base_url,
        model_id = EXCLUDED.model_id,
        encrypted_api_key = EXCLUDED.encrypted_api_key,
        context_window = EXCLUDED.context_window,
        enabled = EXCLUDED.enabled,
        last_test_status = NULL,
        last_test_latency_ms = NULL,
        last_test_error_code = NULL,
        last_tested_at = NULL,
        updated_at = now()
      RETURNING *
    `;
    return rows[0];
  },
  async clearApiKey(agentId, profile) {
    const rows = await sql`
      UPDATE llm_profile_settings
      SET encrypted_api_key = NULL,
          enabled = false,
          last_test_status = NULL,
          last_test_latency_ms = NULL,
          last_test_error_code = NULL,
          last_tested_at = NULL,
          updated_at = now()
      WHERE agent_id = ${agentId} AND profile = ${profile}
      RETURNING *
    `;
    return rows[0] ?? null;
  },
  async recordTest(agentId, profile, result) {
    await sql`
      UPDATE llm_profile_settings
      SET last_test_status = ${result.status},
          last_test_latency_ms = ${result.latencyMs},
          last_test_error_code = ${result.errorCode},
          last_tested_at = now(),
          updated_at = now()
      WHERE agent_id = ${agentId} AND profile = ${profile}
    `;
  },
};

const llmSettings = createLlmSettingsService({
  repository: llmSettingsRepository,
  encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY,
});

const jobsRepository = {
  listJobs() {
    return sql`
      SELECT j.id, j.job_type, j.name, j.description, j.schedule_type,
             j.schedule_expression, j.timezone, j.configurable, j.enabled,
             j.status, j.config, j.last_run_at, j.next_run_at, j.updated_at,
             latest.id AS latest_run_id,
             latest.status AS latest_run_status,
             latest.trigger_type AS latest_run_trigger_type,
             latest.attempt_count AS latest_run_attempt_count,
             latest.max_attempts AS latest_run_max_attempts,
             latest.started_at AS latest_run_started_at,
             latest.completed_at AS latest_run_completed_at,
             latest.error_code AS latest_run_error_code,
             latest.error_message AS latest_run_error_message,
             latest.metrics AS latest_run_metrics
      FROM jobs AS j
      LEFT JOIN LATERAL (
        SELECT id, status, trigger_type, attempt_count, max_attempts, started_at,
               completed_at, error_code, error_message, metrics, created_at
        FROM job_runs
        WHERE job_id = j.id
        ORDER BY created_at DESC
        LIMIT 1
      ) AS latest ON true
      WHERE j.agent_id = 'agent-asuka'
      ORDER BY CASE j.status WHEN 'active' THEN 0 ELSE 1 END, j.name
    `;
  },
  async getJob(jobId) {
    const rows = await sql`
      SELECT id, job_type, enabled, status, config
      FROM jobs
      WHERE id = ${jobId} AND agent_id = 'agent-asuka'
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
  async enqueue(input) {
    const rows = await sql`
      INSERT INTO job_runs (
        id, job_id, status, trigger_type, idempotency_key, correlation_id,
        scheduled_for, available_at, attempt_count, max_attempts,
        started_at, completed_at, metrics, created_at
      ) VALUES (
        ${input.id}, ${input.jobId}, 'queued', 'manual',
        ${input.idempotencyKey}, ${input.correlationId}, ${input.now},
        ${input.now}, 0, ${input.maxAttempts}, NULL, NULL,
        ${sql.json({})}, ${input.now}
      )
      RETURNING id, job_id, status, trigger_type, correlation_id, created_at
    `;
    return rows[0];
  },
  listRuns(jobId) {
    return sql`
      SELECT id, job_id, status, trigger_type, correlation_id, scheduled_for,
             available_at, attempt_count, max_attempts, lease_owner,
             lease_expires_at, heartbeat_at, started_at, completed_at,
             error_code, error_message, metrics, created_at
      FROM job_runs
      WHERE job_id = ${jobId}
      ORDER BY created_at DESC
      LIMIT 50
    `;
  },
  async getRun(runId) {
    const runs = await sql`
      SELECT run.id, run.job_id, job.name AS job_name, job.job_type,
             run.status, run.trigger_type, run.correlation_id,
             run.scheduled_for, run.available_at, run.attempt_count,
             run.max_attempts, run.lease_owner, run.lease_expires_at,
             run.heartbeat_at, run.started_at, run.completed_at,
             run.error_code, run.error_message, run.metrics, run.created_at
      FROM job_runs AS run
      JOIN jobs AS job ON job.id = run.job_id
      WHERE run.id = ${runId} AND job.agent_id = 'agent-asuka'
      LIMIT 1
    `;
    if (!runs[0]) return null;
    const [llmCalls, thoughts, candidates, watermarks] = await Promise.all([
      sql`
        SELECT id, thought_run_id, conversation_id, correlation_id, profile,
               provider, model, prompt_version, input_hash, output_hash,
               status, error_code, latency_ms, input_tokens, output_tokens,
               sequence_number, created_at
        FROM llm_calls WHERE job_run_id = ${runId} ORDER BY created_at
      `,
      sql`
        SELECT id, thought_run_id, conversation_id, intent, basis, evidence_message_ids,
               confidence_millis, risk, decision, expires_at, prompt_version,
               created_at
        FROM operational_thoughts
        WHERE job_run_id = ${runId} ORDER BY created_at
      `,
      sql`
        SELECT id, thought_run_id, conversation_id, operation, subject_id, source_speaker_id,
               claim, evidence_message_ids, confidence_millis,
               attribution_status, target_candidate_id, status,
               prompt_version, created_at
        FROM memory_candidates
        WHERE job_run_id = ${runId} ORDER BY created_at
      `,
      sql`
        SELECT job_id, conversation_id, last_message_at, last_message_id,
               updated_at
        FROM job_conversation_watermarks
        WHERE last_success_run_id = ${runId}
        ORDER BY conversation_id
      `,
    ]);
    return { run: runs[0], llmCalls, thoughts, candidates, watermarks };
  },
};

const jobsService = createJobsService({
  repository: jobsRepository,
  randomId: randomUUID,
});

const outboundRepository = {
  async getPolicy(agentId) {
    const rows = await sql`
      SELECT policy.agent_id, policy.enabled, agent.mode,
             policy.timezone, policy.quiet_start_minute,
             policy.quiet_end_minute, policy.daily_budget,
             policy.cooldown_seconds, policy.duplicate_window_seconds,
             policy.freshness_seconds, policy.updated_at
      FROM outbound_policies AS policy
      JOIN agents AS agent ON agent.id = policy.agent_id
      WHERE policy.agent_id = ${agentId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
  listDecisions(agentId) {
    return sql`
      SELECT decision.id, decision.outcome, decision.reason_code,
             decision.draft, decision.evidence_references,
             decision.policy_snapshot, decision.next_evaluation_at,
             decision.evaluation_count, decision.feedback_label,
             decision.feedback_note, decision.feedback_at,
             decision.created_at, decision.updated_at,
             proposal.id AS proposal_id, proposal.status AS proposal_status,
             thought.id AS thought_run_id, thought.trigger_type,
             thought.trigger_reason, conversation.id AS conversation_id,
             conversation.title AS conversation_title,
             conversation.external_id AS external_conversation_id,
             delivery.id AS delivery_id, delivery.status AS delivery_status,
             delivery.external_message_id, delivery.last_error_code,
             delivery.last_error_message, delivery.sent_at
      FROM speech_decisions AS decision
      JOIN action_proposals AS proposal ON proposal.id = decision.proposal_id
      JOIN thought_runs AS thought ON thought.id = decision.thought_run_id
      JOIN conversations AS conversation ON conversation.id = decision.conversation_id
      LEFT JOIN outbound_deliveries AS delivery
        ON delivery.speech_decision_id = decision.id
      WHERE decision.agent_id = ${agentId}
      ORDER BY decision.created_at DESC
      LIMIT 100
    `;
  },
  savePolicy(agentId, input) {
    return sql.begin(async (tx) => {
      await tx`
        UPDATE agents SET mode = ${input.mode}, updated_at = now()
        WHERE id = ${agentId}
      `;
      const rows = await tx`
        INSERT INTO outbound_policies (
          agent_id, enabled, timezone, quiet_start_minute, quiet_end_minute,
          daily_budget, cooldown_seconds, duplicate_window_seconds,
          freshness_seconds, created_at, updated_at
        ) VALUES (
          ${agentId}, ${input.enabled}, ${input.timezone},
          ${input.quietStartMinute}, ${input.quietEndMinute},
          ${input.dailyBudget}, ${input.cooldownSeconds},
          ${input.duplicateWindowSeconds}, ${input.freshnessSeconds}, now(), now()
        )
        ON CONFLICT (agent_id) DO UPDATE SET
          enabled = EXCLUDED.enabled, timezone = EXCLUDED.timezone,
          quiet_start_minute = EXCLUDED.quiet_start_minute,
          quiet_end_minute = EXCLUDED.quiet_end_minute,
          daily_budget = EXCLUDED.daily_budget,
          cooldown_seconds = EXCLUDED.cooldown_seconds,
          duplicate_window_seconds = EXCLUDED.duplicate_window_seconds,
          freshness_seconds = EXCLUDED.freshness_seconds,
          updated_at = EXCLUDED.updated_at
        RETURNING agent_id, enabled, ${input.mode}::text AS mode, timezone,
                  quiet_start_minute, quiet_end_minute, daily_budget,
                  cooldown_seconds, duplicate_window_seconds,
                  freshness_seconds, updated_at
      `;
      const cancelled = await tx`
        UPDATE outbound_deliveries AS delivery
        SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = 'policy_changed',
            last_error_message = '发送前策略已更新；旧 delivery 已取消',
            updated_at = now()
        FROM speech_decisions AS decision
        WHERE decision.id = delivery.speech_decision_id
          AND decision.agent_id = ${agentId}
          AND delivery.status IN ('queued', 'retry_wait')
        RETURNING delivery.id, delivery.message_id, delivery.conversation_id,
                  delivery.speech_decision_id
      `;
      for (const delivery of cancelled) {
        const messages = await tx`
          UPDATE messages
          SET external_receipt = ${tx.json({
            status: "cancelled",
            outboundDeliveryId: delivery.id,
            reason: "policy_changed",
          })}
          WHERE id = ${delivery.message_id}
          RETURNING correlation_id
        `;
        await tx`
          UPDATE action_proposals AS proposal
          SET status = 'cancelled', policy_reasons = ${tx.json(["policy_changed"])},
              updated_at = now()
          FROM speech_decisions AS decision
          WHERE decision.id = ${delivery.speech_decision_id}
            AND proposal.id = decision.proposal_id
        `;
        await tx`
          INSERT INTO events (
            id, conversation_id, event_type, source_type, payload_json,
            correlation_id, created_at
          ) VALUES (
            ${`event:outbound-policy-cancel:${delivery.id}`},
            ${delivery.conversation_id}, 'outbound_message_cancelled', 'policy',
            ${tx.json({ deliveryId: delivery.id, reasonCode: "policy_changed" })},
            ${messages[0]?.correlation_id ?? delivery.id}, now()
          ) ON CONFLICT (id) DO NOTHING
        `;
      }
      return rows[0];
    });
  },
  async saveFeedback(agentId, decisionId, input) {
    const rows = await sql`
      UPDATE speech_decisions
      SET feedback_label = ${input.label}, feedback_note = ${input.note},
          feedback_at = now(), updated_at = now()
      WHERE id = ${decisionId} AND agent_id = ${agentId}
      RETURNING id, feedback_label, feedback_note, feedback_at
    `;
    return rows[0] ?? null;
  },
};

const outboundService = createOutboundService({ repository: outboundRepository });

const thoughtStreamRepository = {
  async resetConversation({ conversationId, resetId, now }) {
    return sql.begin(async (tx) => {
      const rows = await tx`
        SELECT stream.id, stream.status, stream.current_epoch_ordinal,
               stream.committed_message_at, stream.committed_message_id,
               stream.lease_owner, stream.lease_expires_at
        FROM thought_streams AS stream
        JOIN conversations AS conversation ON conversation.id = stream.conversation_id
        WHERE stream.conversation_id = ${conversationId}
          AND stream.agent_id = 'agent-asuka'
          AND conversation.agent_id = 'agent-asuka'
        FOR UPDATE OF stream
      `;
      const stream = rows[0];
      if (!stream) return { outcome: "not_found" };
      if (stream.status !== "active") return { outcome: "inactive" };
      const leaseActive = stream.lease_owner && stream.lease_expires_at &&
        new Date(stream.lease_expires_at) > now;
      if (leaseActive) return { outcome: "busy" };

      const previousEpochOrdinal = Number(stream.current_epoch_ordinal);
      const currentEpochOrdinal = previousEpochOrdinal + 1;
      await tx`
        UPDATE thought_runs
        SET status = 'failed', processing_stage = 'failed',
            summary = '短期上下文已由操作员重置', completed_at = ${now}
        WHERE stream_id = ${stream.id} AND status = 'running'
      `;
      const latestRuns = await tx`
        SELECT thought.id
        FROM thought_runs AS thought
        JOIN thought_stream_epochs AS epoch ON epoch.id = thought.epoch_id
        WHERE thought.stream_id = ${stream.id}
          AND epoch.ordinal = ${previousEpochOrdinal}
          AND thought.status = 'completed'
        ORDER BY thought.turn_ordinal DESC
        LIMIT 1
      `;
      await tx`
        UPDATE thought_stream_epochs
        SET status = 'closed', completed_at = COALESCE(completed_at, ${now}),
            covers_through_thought_run_id = COALESCE(
              covers_through_thought_run_id,
              ${latestRuns[0]?.id ?? null}
            )
        WHERE stream_id = ${stream.id}
          AND ordinal = ${previousEpochOrdinal}
          AND status IN ('active', 'compressing')
      `;
      const updated = await tx`
        UPDATE thought_streams
        SET current_epoch_ordinal = ${currentEpochOrdinal},
            version = version + 1,
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            updated_at = ${now}
        WHERE id = ${stream.id}
        RETURNING committed_message_at, committed_message_id, version
      `;
      await tx`
        INSERT INTO events (
          id, conversation_id, event_type, source_type, payload_json,
          correlation_id, created_at
        ) VALUES (
          ${`event:thought-context-reset:${resetId}`}, ${conversationId},
          'thought_context_reset', 'operator',
          ${tx.json({
            streamId: String(stream.id),
            previousEpochOrdinal,
            currentEpochOrdinal,
          })}, ${`thought-context-reset:${resetId}`}, ${now}
        )
      `;
      return {
        outcome: "reset",
        stream: {
          id: String(stream.id),
          conversationId,
          previousEpochOrdinal,
          currentEpochOrdinal,
          committedMessageAt: updated[0].committed_message_at,
          committedMessageId: updated[0].committed_message_id,
          version: Number(updated[0].version),
          resetAt: now,
        },
      };
    });
  },
};

const thoughtStreams = createThoughtStreamService({
  repository: thoughtStreamRepository,
  randomId: randomUUID,
});

class RequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function allowedOrigin(origin) {
  if (!origin) return null;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "terminal.local"
      ? origin
      : null;
  } catch {
    return null;
  }
}

function sendJson(response, status, payload, origin = null) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) {
      throw new RequestError("request_too_large", "请求体过大", 413);
    }
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new RequestError("invalid_json", "请求 JSON 格式无效");
  }
}

async function getImSnapshot(conversationId) {
  const [channelRows, conversationRows] = await Promise.all([
    sql`
      SELECT id, provider, account_id, enabled, last_seen_at, config,
             created_at, updated_at
      FROM channels
      WHERE agent_id = 'agent-asuka'
      ORDER BY updated_at DESC
    `,
    sql`
      SELECT c.id, c.channel_id, c.external_id, c.title, c.status,
             c.created_at, c.updated_at,
             count(m.id)::int AS message_count,
             count(m.id) FILTER (
               WHERE m.author_kind = 'user'
                 AND m.direction = 'inbound'
                 AND m.read_at IS NULL
                 AND (
                   stream.committed_message_at IS NULL
                   OR (m.created_at, m.id) > (
                     stream.committed_message_at,
                     stream.committed_message_id
                   )
                 )
             )::int AS unread_count,
             count(m.id) FILTER (
               WHERE m.author_kind = 'user'
                 AND m.direction = 'inbound'
                 AND (
                   stream.committed_message_at IS NULL
                   OR (m.created_at, m.id) > (
                     stream.committed_message_at,
                     stream.committed_message_id
                   )
                 )
             )::int AS thought_unread_count,
             max(m.created_at) AS last_message_at,
             stream.status AS thought_stream_status,
             stream.current_epoch_ordinal AS thought_epoch_ordinal,
             stream.committed_message_at AS thought_committed_message_at
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      LEFT JOIN thought_streams AS stream
        ON stream.agent_id = c.agent_id AND stream.conversation_id = c.id
      WHERE c.agent_id = 'agent-asuka' AND c.channel = 'napcat'
      GROUP BY c.id, stream.id
      ORDER BY last_message_at DESC NULLS LAST, c.updated_at DESC
    `,
  ]);

  const selectedId = conversationId &&
    conversationRows.some((row) => row.id === conversationId)
    ? conversationId
    : conversationRows[0]?.id ?? null;
  const messageRows = selectedId
    ? await sql`
        SELECT * FROM (
          SELECT m.id, m.conversation_id, m.role, m.content,
                 COALESCE(
                   m.read_at,
                   CASE
                     WHEN stream.committed_message_at IS NOT NULL
                       AND (m.created_at, m.id) <= (
                         stream.committed_message_at,
                         stream.committed_message_id
                       )
                     THEN stream.updated_at
                     ELSE NULL
                   END
                 ) AS read_at,
                 m.created_at, m.sender_id,
                 COALESCE(
                   NULLIF(m.sender_display_name, ''),
                   participant.display_name,
                   m.sender_id,
                   CASE WHEN m.role = 'assistant' THEN 'Asuka Agent' ELSE '未知成员' END
                 ) AS sender_name
          FROM messages m
          LEFT JOIN thought_streams AS stream
            ON stream.conversation_id = m.conversation_id
           AND stream.agent_id = 'agent-asuka'
          LEFT JOIN conversation_participants AS participant
            ON participant.conversation_id = m.conversation_id
           AND participant.participant_id = m.sender_id
          WHERE m.conversation_id = ${selectedId}
          ORDER BY m.created_at DESC
          LIMIT 200
        ) recent
        ORDER BY created_at ASC
      `
    : [];

  const conversationsByChannel = new Map();
  for (const conversation of conversationRows) {
    const items = conversationsByChannel.get(conversation.channel_id) ?? [];
    items.push(conversation);
    conversationsByChannel.set(conversation.channel_id, items);
  }

  return {
    channels: channelRows.map((channel) => {
      const conversations = conversationsByChannel.get(channel.id) ?? [];
      return {
        ...channel,
        unread_count: conversations.reduce(
          (total, item) => total + item.unread_count,
          0,
        ),
        conversations,
      };
    }),
    selectedConversationId: selectedId,
    messages: messageRows,
  };
}

async function listThoughtRuns() {
  return sql`
    SELECT thought.id, thought.conversation_id, conversation.title AS conversation_title,
           thought.job_run_id, thought.correlation_id, thought.trigger_type,
           thought.trigger_reason, thought.status, thought.decision,
           thought.summary, thought.started_at, thought.completed_at,
           thought.created_at, job.job_type, thought.turn_ordinal,
           epoch.ordinal AS context_epoch_ordinal,
           stream.status AS stream_status,
           stream.current_epoch_ordinal,
           stream.committed_message_at, stream.updated_at AS stream_updated_at,
           COALESCE(call_stats.call_count, 0)::int AS call_count,
           COALESCE(call_stats.input_tokens, 0)::int AS input_tokens,
           COALESCE(call_stats.output_tokens, 0)::int AS output_tokens,
           COALESCE(call_stats.latency_ms, 0)::int AS latency_ms,
           COALESCE(output_stats.thought_count, 0)::int AS thought_count,
           COALESCE(output_stats.candidate_count, 0)::int AS candidate_count
    FROM thought_runs thought
    JOIN conversations conversation ON conversation.id = thought.conversation_id
    JOIN thought_streams stream ON stream.id = thought.stream_id
    JOIN thought_stream_epochs epoch ON epoch.id = thought.epoch_id
    JOIN job_runs run ON run.id = thought.job_run_id
    JOIN jobs job ON job.id = run.job_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS call_count,
             sum(COALESCE(input_tokens, 0)) AS input_tokens,
             sum(COALESCE(output_tokens, 0)) AS output_tokens,
             sum(COALESCE(latency_ms, 0)) AS latency_ms
      FROM llm_calls call
      WHERE call.thought_run_id = thought.id
    ) call_stats ON true
    LEFT JOIN LATERAL (
      SELECT
        (SELECT count(*) FROM operational_thoughts output
         WHERE output.thought_run_id = thought.id) AS thought_count,
        (SELECT count(*) FROM memory_candidates candidate
         WHERE candidate.thought_run_id = thought.id) AS candidate_count
    ) output_stats ON true
    WHERE thought.agent_id = 'agent-asuka'
    ORDER BY thought.created_at DESC
    LIMIT 100
  `;
}

async function getThoughtRunDetail(thoughtRunId) {
  const runs = await sql`
    SELECT thought.*, conversation.title AS conversation_title,
           conversation.external_id, job.name AS job_name, job.job_type,
           epoch.ordinal AS context_epoch_ordinal,
           stream.status AS stream_status,
           stream.current_epoch_ordinal,
           stream.committed_message_at, stream.updated_at AS stream_updated_at
    FROM thought_runs thought
    JOIN conversations conversation ON conversation.id = thought.conversation_id
    JOIN thought_streams stream ON stream.id = thought.stream_id
    JOIN thought_stream_epochs epoch ON epoch.id = thought.epoch_id
    JOIN job_runs run ON run.id = thought.job_run_id
    JOIN jobs job ON job.id = run.job_id
    WHERE thought.id = ${thoughtRunId} AND thought.agent_id = 'agent-asuka'
    LIMIT 1
  `;
  if (!runs[0]) throw new RequestError("thought_run_not_found", "思绪运行不存在", 404);
  const [calls, outputs, candidates, proposals, participants] = await Promise.all([
    sql`
      SELECT call.id, call.sequence_number, call.purpose, call.profile, call.provider,
             call.model, call.prompt_version, call.status, call.error_code,
             call.latency_ms, call.input_tokens, call.output_tokens,
             call.request_context, call.response_json, call.created_at,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'id', item.id,
                   'ordinal', item.ordinal,
                   'itemType', item.item_type,
                   'referenceId', item.reference_id,
                   'title', item.title,
                   'content', item.content,
                   'metadata', item.metadata
                 ) ORDER BY item.ordinal
               ) FILTER (WHERE item.id IS NOT NULL),
               '[]'::jsonb
             ) AS context_items
      FROM llm_calls call
      LEFT JOIN llm_call_context_items item ON item.llm_call_id = call.id
      WHERE call.thought_run_id = ${thoughtRunId}
      GROUP BY call.id
      ORDER BY call.sequence_number
    `,
    sql`
      SELECT id, intent, basis, evidence_message_ids, confidence_millis,
             risk, decision, expires_at, prompt_version, created_at
      FROM operational_thoughts
      WHERE thought_run_id = ${thoughtRunId}
      ORDER BY created_at
    `,
    sql`
      SELECT id, operation, subject_id, source_speaker_id, claim,
             evidence_message_ids, confidence_millis, attribution_status,
             target_candidate_id, status, prompt_version, created_at
      FROM memory_candidates
      WHERE thought_run_id = ${thoughtRunId}
      ORDER BY created_at
    `,
    sql`
      SELECT id, compiler_llm_call_id, ordinal, proposal_type, status,
             idempotency_key, payload, evidence_references, policy_reasons,
             created_at, updated_at
      FROM action_proposals
      WHERE thought_run_id = ${thoughtRunId}
      ORDER BY ordinal
    `,
    sql`
      SELECT participant_id, display_name, aliases
      FROM conversation_participants
      WHERE conversation_id = ${runs[0].conversation_id}
      ORDER BY first_seen_at, participant_id
    `,
  ]);
  return { run: runs[0], calls, outputs, candidates, proposals, participants };
}

async function listMemoryCandidates() {
  return sql`
    SELECT candidate.id, candidate.operation, candidate.subject_id,
           candidate.source_speaker_id, candidate.claim,
           candidate.evidence_message_ids, candidate.confidence_millis,
           candidate.attribution_status, candidate.target_candidate_id,
           candidate.status, candidate.prompt_version, candidate.created_at,
           candidate.updated_at, candidate.thought_run_id,
           thought.summary AS thought_summary,
           thought.trigger_type, thought.trigger_reason,
           conversation.id AS conversation_id,
           conversation.title AS conversation_title,
           COALESCE(participant.display_name, candidate.source_speaker_id)
             AS source_speaker_name
    FROM memory_candidates candidate
    JOIN thought_runs thought ON thought.id = candidate.thought_run_id
    JOIN conversations conversation ON conversation.id = candidate.conversation_id
    LEFT JOIN conversation_participants participant
      ON participant.conversation_id = candidate.conversation_id
     AND participant.participant_id = candidate.source_speaker_id
    WHERE candidate.agent_id = 'agent-asuka'
    ORDER BY candidate.created_at DESC
    LIMIT 200
  `;
}

const server = http.createServer(async (request, response) => {
  const origin = allowedOrigin(request.headers.origin);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
      "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    });
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      await sql`SELECT 1`;
      sendJson(response, 200, { status: "ok", service: "asuka-control-api" }, origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/im") {
      sendJson(
        response,
        200,
        await getImSnapshot(url.searchParams.get("conversationId")),
        origin,
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/im/read") {
      const payload = await readJson(request);
      if (!payload.conversationId) {
        throw new RequestError("conversation_required", "缺少 conversationId");
      }
      const updated = await sql`
        UPDATE messages
        SET read_at = now()
        WHERE conversation_id = ${String(payload.conversationId)}
          AND role = 'user'
          AND read_at IS NULL
        RETURNING id
      `;
      sendJson(response, 200, { updated: updated.length }, origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/jobs") {
      sendJson(response, 200, { jobs: await jobsService.listJobs() }, origin);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/outbound") {
      sendJson(response, 200, await outboundService.snapshot(), origin);
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/outbound/policy") {
      sendJson(
        response,
        200,
        { policy: await outboundService.savePolicy(await readJson(request)) },
        origin,
      );
      return;
    }
    const speechFeedbackRoute = url.pathname.match(
      /^\/api\/outbound\/decisions\/([^/]+)\/feedback$/,
    );
    if (speechFeedbackRoute && request.method === "POST") {
      sendJson(
        response,
        200,
        {
          feedback: await outboundService.saveFeedback(
            decodeURIComponent(speechFeedbackRoute[1]),
            await readJson(request),
          ),
        },
        origin,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/thought-runs") {
      sendJson(response, 200, { thoughtRuns: await listThoughtRuns() }, origin);
      return;
    }
    const thoughtStreamResetRoute = url.pathname.match(
      /^\/api\/thought-streams\/([^/]+)\/reset$/,
    );
    if (thoughtStreamResetRoute && request.method === "POST") {
      sendJson(
        response,
        200,
        {
          stream: await thoughtStreams.resetConversation(
            decodeURIComponent(thoughtStreamResetRoute[1]),
          ),
        },
        origin,
      );
      return;
    }
    const thoughtRunRoute = url.pathname.match(/^\/api\/thought-runs\/([^/]+)$/);
    if (thoughtRunRoute && request.method === "GET") {
      sendJson(
        response,
        200,
        await getThoughtRunDetail(decodeURIComponent(thoughtRunRoute[1])),
        origin,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memories") {
      sendJson(response, 200, { memories: await listMemoryCandidates() }, origin);
      return;
    }
    const jobRunsRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/runs$/);
    if (jobRunsRoute && request.method === "GET") {
      sendJson(
        response,
        200,
        { runs: await jobsService.listRuns(decodeURIComponent(jobRunsRoute[1])) },
        origin,
      );
      return;
    }
    const jobTriggerRoute = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (jobTriggerRoute && request.method === "POST") {
      sendJson(
        response,
        202,
        { run: await jobsService.trigger(decodeURIComponent(jobTriggerRoute[1])) },
        origin,
      );
      return;
    }
    const jobRunRoute = url.pathname.match(/^\/api\/job-runs\/([^/]+)$/);
    if (jobRunRoute && request.method === "GET") {
      sendJson(
        response,
        200,
        await jobsService.getRun(decodeURIComponent(jobRunRoute[1])),
        origin,
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/llm/settings") {
      sendJson(response, 200, await llmSettings.listProfiles(), origin);
      return;
    }
    const llmRoute = url.pathname.match(
      /^\/api\/llm\/settings\/(primary|fast)(?:\/(test|key))?$/,
    );
    if (llmRoute) {
      const [, profile, action] = llmRoute;
      if (request.method === "PUT" && !action) {
        sendJson(
          response,
          200,
          { profile: await llmSettings.saveProfile(profile, await readJson(request)) },
          origin,
        );
        return;
      }
      if (request.method === "POST" && action === "test") {
        sendJson(
          response,
          200,
          { result: await llmSettings.testProfile(profile) },
          origin,
        );
        return;
      }
      if (request.method === "DELETE" && action === "key") {
        const payload = await readJson(request);
        sendJson(
          response,
          200,
          {
            profile: await llmSettings.deleteApiKey(
              profile,
              payload.confirmation,
            ),
          },
          origin,
        );
        return;
      }
    }
    sendJson(response, 404, { error: "接口不存在" }, origin);
  } catch (error) {
    const expected = error instanceof LlmConfigurationError ||
      error instanceof RequestError ||
      error instanceof JobRequestError ||
      error instanceof OutboundRequestError ||
      error instanceof ThoughtStreamRequestError;
    console.error("control API request failed", {
      code: expected ? error.code : "internal_error",
      message: expected ? error.message : "unexpected request failure",
    });
    sendJson(
      response,
      expected ? error.status : 500,
      {
        error: expected ? error.message : "服务端处理请求失败",
        code: expected ? error.code : "internal_error",
      },
      origin,
    );
  }
});

await sql`SELECT 1`;
server.listen(port, host, () => {
  console.log(`Asuka control API listening on http://${host}:${port}`);
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await sql.end();
}

process.once("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
