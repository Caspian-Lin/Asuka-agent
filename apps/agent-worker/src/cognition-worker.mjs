import { randomUUID } from "node:crypto";
import {
  buildSpeakerContext,
  CognitionValidationError,
  cognitionRequest,
  outputIdempotencyKey,
  parseStructuredOutput,
  stableHash,
  validateMemoryOutput,
  validateThoughtOutput,
} from "@asuka-agent/agent-core/scheduled-cognition";
import {
  projectThoughtContext,
  selectInitializationHistory,
  shouldUseInitializationHistory,
  ThoughtContextError,
} from "@asuka-agent/agent-core/thought-context";
import {
  parsePrimaryToolCall,
  PRIMARY_THOUGHT_PROMPT_VERSION,
  PRIMARY_THOUGHT_SYSTEM_PROMPT,
  PRIMARY_THOUGHT_TOOLS,
  PrimaryThoughtError,
  primaryThoughtRequest,
  primaryToolCallKey,
  runPrimaryToolLoop,
} from "@asuka-agent/agent-core/primary-thought";
import {
  ActionCompilerError,
  ACTION_COMPILER_PROMPT_VERSION,
  actionCompilerRequest,
  actionProposalIdempotencyKey,
  buildCompilerInput,
  parseActionCompilerContent,
  primaryRevisionRequest,
  selectReusableCompilerCall,
  validateCompilerOutput,
} from "@asuka-agent/agent-core/action-compiler";
import {
  evaluateSpeechPolicy,
  speechContentHash,
} from "@asuka-agent/agent-core/outbound-policy";
import {
  decryptApiKey,
  LlmConfigurationError,
  OpenAiCompatibleProvider,
  parseEncryptionKey,
} from "@asuka-agent/llm/runtime";
import { errorMessage } from "@asuka-agent/shared";

const cognitionJobTypes = new Set(["thought_tick", "memory_consolidation"]);

export function nextRunAt(job, now = new Date()) {
  if (job.job_type === "thought_tick") {
    const intervalSeconds = Number(job.config?.intervalSeconds ?? 900);
    const safeSeconds = Number.isSafeInteger(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds
      : 900;
    const scheduled = job.next_run_at ? new Date(job.next_run_at) : now;
    return new Date(Math.max(now.getTime(), scheduled.getTime()) + safeSeconds * 1_000);
  }
  const dailyHour = Number(job.config?.dailyHour ?? 3);
  const safeHour = Number.isSafeInteger(dailyHour) && dailyHour >= 0 && dailyHour <= 23
    ? dailyHour
    : 3;
  const shanghaiNow = new Date(now.getTime() + 8 * 60 * 60_000);
  let target = new Date(Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate(),
    safeHour - 8,
  ));
  if (target <= now) target = new Date(target.getTime() + 24 * 60 * 60_000);
  return target;
}

export function retryDelayMs(attemptCount) {
  return Math.min(5 * 60_000, 15_000 * (2 ** Math.max(0, attemptCount - 1)));
}

export function cognitionError(error) {
  if (error instanceof CognitionValidationError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof ThoughtContextError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof ActionCompilerError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof LlmConfigurationError) {
    const retryable = error.code === "provider_timeout" ||
      error.code === "provider_unreachable" ||
      /^provider_http_5\d\d$/.test(error.code) ||
      error.code === "provider_invalid_response";
    return { code: error.code, message: error.message, retryable };
  }
  return {
    code: "cognition_internal_error",
    message: errorMessage(error).slice(0, 500),
    retryable: false,
  };
}

export function thoughtRunIdFor(runId, conversationId) {
  return `thought-run:${stableHash({ jobRunId: runId, conversationId })}`;
}

export function thoughtStreamIdFor(agentId, conversationId) {
  return `thought-stream:${stableHash({ agentId, conversationId })}`;
}

export function thoughtEpochIdFor(streamId, ordinal) {
  return `thought-epoch:${stableHash({ streamId, ordinal })}`;
}

export function cognitionTriggerReason(run) {
  const source = run.trigger_type === "manual" ? "手动触发" : "定时计划到期";
  return run.job_type === "memory_consolidation"
    ? `${source}：整理新增会话证据并生成待审记忆候选`
    : `${source}：检查新增会话证据并决定是否形成可执行思绪`;
}

export function createCognitionWorker({
  sql,
  encryptionKey,
  leaseOwner,
  leaseMs = 90_000,
  maxRunsPerCycle = 2,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
  logger = console,
}) {
  async function scheduleDueRuns() {
    const now = clock();
    return sql.begin(async (tx) => {
      const dueJobs = await tx`
        SELECT id, job_type, next_run_at, config
        FROM jobs
        WHERE agent_id = 'agent-asuka'
          AND enabled = true
          AND status = 'active'
          AND job_type IN ('thought_tick', 'memory_consolidation')
          AND next_run_at IS NOT NULL
          AND next_run_at <= ${now}
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
      `;
      let queued = 0;
      for (const job of dueJobs) {
        const runId = randomUUID();
        const scheduledFor = new Date(job.next_run_at);
        const configuredMaxAttempts = Number(job.config?.maxAttempts ?? 3);
        const maxAttempts = Number.isSafeInteger(configuredMaxAttempts) &&
          configuredMaxAttempts > 0 && configuredMaxAttempts <= 10
          ? configuredMaxAttempts
          : 3;
        const inserted = await tx`
          INSERT INTO job_runs (
            id, job_id, status, trigger_type, idempotency_key, correlation_id,
            scheduled_for, available_at, attempt_count, max_attempts,
            started_at, completed_at, metrics, created_at
          ) VALUES (
            ${runId}, ${job.id}, 'queued', 'schedule',
            ${`scheduled:${job.id}:${scheduledFor.toISOString()}`},
            ${`job-run:${runId}`}, ${scheduledFor}, ${now}, 0,
            ${maxAttempts}, NULL, NULL,
            ${tx.json({})}, ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `;
        queued += inserted.length;
        await tx`
          UPDATE jobs
          SET next_run_at = ${nextRunAt(job, now)}, updated_at = ${now}
          WHERE id = ${job.id}
        `;
      }
      await tx`
        UPDATE job_runs
        SET status = 'dead_letter', completed_at = ${now},
            error_code = 'lease_attempts_exhausted',
            error_message = '任务租约过期且已达到最大尝试次数',
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
        WHERE status = 'running'
          AND lease_expires_at < ${now}
          AND attempt_count >= max_attempts
      `;
      return queued;
    });
  }

  async function claimRun() {
    const now = clock();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    return sql.begin(async (tx) => {
      const claimed = await tx`
        WITH candidate AS (
          SELECT id
          FROM job_runs
          WHERE (
            (status IN ('queued', 'retry_wait') AND available_at <= ${now})
            OR (status = 'running' AND lease_expires_at < ${now})
          )
            AND attempt_count < max_attempts
            AND job_id IN ('job-thought-tick', 'job-memory-consolidation')
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE job_runs AS run
        SET status = 'running', lease_owner = ${leaseOwner},
            lease_expires_at = ${leaseExpiresAt}, heartbeat_at = ${now},
            started_at = COALESCE(started_at, ${now}),
            attempt_count = attempt_count + 1,
            error_code = NULL, error_message = NULL
        FROM candidate
        WHERE run.id = candidate.id
        RETURNING run.*
      `;
      if (!claimed[0]) return null;
      const rows = await tx`
        SELECT run.*, job.agent_id, job.job_type, job.config
        FROM job_runs AS run
        JOIN jobs AS job ON job.id = run.job_id
        WHERE run.id = ${claimed[0].id}
      `;
      return rows[0] ?? null;
    });
  }

  async function heartbeat(runId) {
    const now = clock();
    const expiresAt = new Date(now.getTime() + leaseMs);
    await sql.begin(async (tx) => {
      await tx`
        UPDATE job_runs
        SET heartbeat_at = ${now}, lease_expires_at = ${expiresAt}
        WHERE id = ${runId} AND status = 'running' AND lease_owner = ${leaseOwner}
      `;
      await tx`
        UPDATE thought_streams AS stream
        SET heartbeat_at = ${now}, lease_expires_at = ${expiresAt}, updated_at = ${now}
        WHERE stream.lease_owner = ${leaseOwner}
          AND EXISTS (
            SELECT 1 FROM thought_runs thought
            WHERE thought.stream_id = stream.id AND thought.job_run_id = ${runId}
          )
      `;
    });
  }

  async function releaseThoughtStream(thoughtRunId) {
    const now = clock();
    await sql`
      UPDATE thought_streams AS stream
      SET lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ${now},
          updated_at = ${now}
      FROM thought_runs AS thought
      WHERE thought.id = ${thoughtRunId}
        AND stream.id = thought.stream_id
        AND stream.lease_owner = ${leaseOwner}
    `;
  }

  async function loadProfile(profile) {
    const rows = await sql`
      SELECT enabled, base_url, model_id, encrypted_api_key, context_window
      FROM llm_profile_settings
      WHERE agent_id = 'agent-asuka' AND profile = ${profile}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      enabled: row.enabled,
      baseUrl: row.base_url,
      modelId: row.model_id,
      contextWindow: Number(row.context_window),
      apiKey: row.encrypted_api_key
        ? decryptApiKey(row.encrypted_api_key, parseEncryptionKey(encryptionKey))
        : null,
    };
  }

  async function eligibleConversations(run) {
    return sql`
      SELECT c.id, c.title, c.channel, c.external_id,
             CASE WHEN ${run.job_type} = 'thought_tick'
               THEN stream.committed_message_at
               ELSE watermark.last_message_at
             END AS last_message_at,
             CASE WHEN ${run.job_type} = 'thought_tick'
               THEN stream.committed_message_id
               ELSE watermark.last_message_id
             END AS last_message_id
      FROM conversations AS c
      LEFT JOIN thought_streams AS stream
        ON stream.agent_id = c.agent_id
       AND stream.conversation_id = c.id
       AND stream.status = 'active'
      LEFT JOIN job_conversation_watermarks AS watermark
        ON watermark.job_id = ${run.job_id}
       AND watermark.conversation_id = c.id
      WHERE c.agent_id = ${run.agent_id}
        AND c.channel = 'napcat'
        AND c.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM messages AS message
          WHERE message.conversation_id = c.id
            AND message.author_kind = 'user'
            AND message.direction = 'inbound'
            AND message.sender_id IS NOT NULL
            AND (
              (CASE WHEN ${run.job_type} = 'thought_tick'
                THEN stream.committed_message_at
                ELSE watermark.last_message_at
              END) IS NULL
              OR (message.created_at, message.id) >
                 (
                   CASE WHEN ${run.job_type} = 'thought_tick'
                     THEN stream.committed_message_at
                     ELSE watermark.last_message_at
                   END,
                   CASE WHEN ${run.job_type} = 'thought_tick'
                     THEN stream.committed_message_id
                     ELSE watermark.last_message_id
                   END
                 )
            )
        )
      ORDER BY c.updated_at
    `;
  }

  async function loadContext(run, conversation) {
    const maxMessages = Math.min(
      1_000,
      Math.max(1, Number(run.config?.maxBatchMessages ?? 500)),
    );
    const messages = await sql`
      SELECT id, author_kind, direction, sender_id, sender_display_name,
             reply_to_external_message_id, content, created_at
      FROM messages
      WHERE conversation_id = ${conversation.id}
        AND (
          ${conversation.last_message_at}::timestamptz IS NULL
          OR (created_at, id) >
             (${conversation.last_message_at}::timestamptz, ${conversation.last_message_id})
        )
      ORDER BY created_at, id
      LIMIT ${maxMessages}
    `;
    const [participants, existingCandidates] = await Promise.all([
      sql`
        SELECT participant_id, display_name, aliases
        FROM conversation_participants
        WHERE conversation_id = ${conversation.id}
        ORDER BY first_seen_at, participant_id
      `,
      sql`
        SELECT id, subject_id, source_speaker_id, claim, attribution_status, status
        FROM memory_candidates
        WHERE conversation_id = ${conversation.id}
          AND status = 'pending_review'
        ORDER BY created_at DESC
        LIMIT 50
      `,
    ]);
    return buildSpeakerContext({
      conversation: {
        id: conversation.id,
        title: conversation.title,
        channel: conversation.channel,
        externalId: conversation.external_id,
      },
      participants: participants.map((participant) => ({
        participantId: participant.participant_id,
        displayName: participant.display_name,
        aliases: participant.aliases,
      })),
      messages: messages.map((message) => ({
        id: message.id,
        authorKind: message.author_kind,
        direction: message.direction,
        senderId: message.sender_id,
        senderDisplayName: message.sender_display_name,
        replyTo: message.reply_to_external_message_id,
        content: message.content,
        createdAt: message.created_at,
      })),
      existingCandidates: existingCandidates.map((candidate) => ({
        id: candidate.id,
        subjectId: candidate.subject_id,
        sourceSpeakerId: candidate.source_speaker_id,
        claim: candidate.claim,
        attributionStatus: candidate.attribution_status,
        status: candidate.status,
      })),
    });
  }

  async function ensureThoughtRun(run, conversation, context) {
    const id = thoughtRunIdFor(run.id, conversation.id);
    const streamId = thoughtStreamIdFor(run.agent_id, conversation.id);
    const firstMessage = context.messages[0];
    const lastMessage = context.messages.at(-1);
    const now = clock();
    const streamLeaseExpiresAt = new Date(now.getTime() + leaseMs);
    return sql.begin(async (tx) => {
      await tx`
        INSERT INTO thought_streams (
          id, agent_id, conversation_id, status, current_epoch_ordinal,
          version, created_at, updated_at
        ) VALUES (
          ${streamId}, ${run.agent_id}, ${conversation.id}, 'active', 1,
          0, ${now}, ${now}
        )
        ON CONFLICT (agent_id, conversation_id) DO NOTHING
      `;
      const streams = await tx`
        SELECT id, status, current_epoch_ordinal, lease_owner, lease_expires_at
        FROM thought_streams
        WHERE agent_id = ${run.agent_id} AND conversation_id = ${conversation.id}
        FOR UPDATE
      `;
      const stream = streams[0];
      if (stream.status !== "active") {
        throw new CognitionValidationError(
          "stream_inactive",
          "当前会话 Thought Stream 未启用",
        );
      }
      if (stream.lease_owner && stream.lease_owner !== leaseOwner &&
          stream.lease_expires_at && new Date(stream.lease_expires_at) > now) {
        throw new CognitionValidationError(
          "stream_busy",
          "当前会话 Thought Stream 正由另一个 worker 处理",
          true,
        );
      }
      await tx`
        UPDATE thought_streams
        SET lease_owner = ${leaseOwner}, lease_expires_at = ${streamLeaseExpiresAt},
            heartbeat_at = ${now}, updated_at = ${now}
        WHERE id = ${stream.id}
      `;
      const epochId = thoughtEpochIdFor(stream.id, stream.current_epoch_ordinal);
      await tx`
        INSERT INTO thought_stream_epochs (
          id, stream_id, ordinal, status, started_at, created_at
        ) VALUES (
          ${epochId}, ${stream.id}, ${stream.current_epoch_ordinal},
          'active', ${now}, ${now}
        )
        ON CONFLICT (stream_id, ordinal) DO NOTHING
      `;
      const existing = await tx`
        SELECT id, conversation_id, stream_id, epoch_id, turn_ordinal,
               new_message_end_at, new_message_end_id, primary_output
        FROM thought_runs
        WHERE job_run_id = ${run.id} AND conversation_id = ${conversation.id}
        LIMIT 1
      `;
      if (existing[0]) {
        if (existing[0].epoch_id !== epochId) {
          throw new CognitionValidationError(
            "thought_epoch_reset",
            "该会话的短期上下文已由操作员重置",
          );
        }
        await tx`
          UPDATE thought_runs
          SET status = CASE WHEN primary_output IS NULL THEN 'running' ELSE status END,
              processing_stage = CASE
                WHEN primary_output IS NULL THEN 'primary'
                ELSE processing_stage
              END,
              completed_at = CASE WHEN primary_output IS NULL THEN NULL ELSE completed_at END,
              new_message_end_at = CASE
                WHEN primary_output IS NULL THEN ${lastMessage.sent_at}
                ELSE new_message_end_at
              END,
              new_message_end_id = CASE
                WHEN primary_output IS NULL THEN ${lastMessage.message_id}
                ELSE new_message_end_id
              END
          WHERE id = ${existing[0].id}
        `;
        return {
          id: existing[0].id,
          streamId: existing[0].stream_id,
          epochId: existing[0].epoch_id,
          turnOrdinal: Number(existing[0].turn_ordinal),
          conversationId: existing[0].conversation_id,
          newMessageEndAt: existing[0].primary_output == null
            ? lastMessage.sent_at
            : existing[0].new_message_end_at,
          newMessageEndId: existing[0].primary_output == null
            ? lastMessage.message_id
            : existing[0].new_message_end_id,
        };
      }
      const ordinals = await tx`
        SELECT COALESCE(max(turn_ordinal), 0)::int + 1 AS next_ordinal
        FROM thought_runs
        WHERE stream_id = ${stream.id}
      `;
      const rows = await tx`
        INSERT INTO thought_runs (
          id, agent_id, conversation_id, stream_id, epoch_id, turn_ordinal,
          job_run_id, correlation_id, trigger_type, trigger_reason, status,
          processing_stage, new_message_start_at, new_message_start_id,
          new_message_end_at, new_message_end_id, started_at, created_at
        ) VALUES (
          ${id}, ${run.agent_id}, ${conversation.id}, ${stream.id}, ${epochId},
          ${ordinals[0].next_ordinal}, ${run.id}, ${run.correlation_id},
          ${run.trigger_type}, ${cognitionTriggerReason(run)}, 'running',
          'primary', ${firstMessage.sent_at}, ${firstMessage.message_id},
          ${lastMessage.sent_at}, ${lastMessage.message_id}, ${now}, ${now}
        )
        RETURNING id
      `;
      return {
        id: rows[0].id,
        streamId: stream.id,
        epochId,
        turnOrdinal: Number(ordinals[0].next_ordinal),
        conversationId: conversation.id,
        newMessageEndAt: lastMessage.sent_at,
        newMessageEndId: lastMessage.message_id,
      };
    });
  }

  function sourceFromRow(row, conversationType) {
    return {
      message_id: String(row.id),
      author_kind: String(row.author_kind),
      direction: String(row.direction),
      sender_id: row.sender_id == null ? null : String(row.sender_id),
      sender_display_name: row.sender_display_name == null
        ? null
        : String(row.sender_display_name),
      reply_to: row.reply_to_external_message_id == null
        ? null
        : String(row.reply_to_external_message_id),
      sent_at: new Date(row.created_at).toISOString(),
      conversation_type: conversationType,
      content: String(row.content),
    };
  }

  async function loadProjectionContext(run, conversation, context, thoughtRun) {
    const firstMessage = context.messages[0];
    const lastMessage = context.messages.at(-1);
    const conversationType = context.conversation.type;
    const historyCount = Math.min(100, Math.max(0, Number(run.config?.historyMessages ?? 20)));
    const historyMinutes = Math.min(
      24 * 60,
      Math.max(0, Number(run.config?.historyMinutes ?? 30)),
    );
    const [epochRows, historyRows, committedRows] = await Promise.all([
      sql`
        SELECT id, ordinal, compression_output, compression_prompt_version
        FROM thought_stream_epochs
        WHERE id = ${thoughtRun.epochId}
        LIMIT 1
      `,
      sql`
        SELECT id, author_kind, direction, sender_id, sender_display_name,
               reply_to_external_message_id, content, created_at
        FROM messages
        WHERE conversation_id = ${conversation.id}
          AND (created_at, id) < (${firstMessage.sent_at}, ${firstMessage.message_id})
        ORDER BY created_at DESC, id DESC
        LIMIT 500
      `,
      sql`
        SELECT thought.id, thought.turn_ordinal, thought.new_message_start_at,
               thought.new_message_start_id, thought.new_message_end_at,
               thought.new_message_end_id,
               COALESCE(call.response_json ->> 'content', thought.primary_output) AS primary_output,
               proposal.proposal_state AS action_state
        FROM thought_runs AS thought
        LEFT JOIN LATERAL (
          SELECT response_json
          FROM llm_calls
          WHERE thought_run_id = thought.id
            AND purpose IN ('primary', 'tool_continuation', 'revision')
            AND status = 'succeeded'
            AND NULLIF(BTRIM(response_json ->> 'content'), '') IS NOT NULL
            AND jsonb_array_length(COALESCE(response_json -> 'toolCalls', '[]'::jsonb)) = 0
          ORDER BY sequence_number DESC
          LIMIT 1
        ) AS call ON true
        LEFT JOIN LATERAL (
          SELECT string_agg(status::text, ',' ORDER BY ordinal) AS proposal_state
          FROM action_proposals
          WHERE thought_run_id = thought.id
        ) AS proposal ON true
        WHERE thought.stream_id = ${thoughtRun.streamId}
          AND thought.epoch_id = ${thoughtRun.epochId}
          AND thought.turn_ordinal < ${thoughtRun.turnOrdinal}
          AND thought.status = 'completed'
        ORDER BY thought.turn_ordinal
      `,
    ]);
    const committedTurns = await Promise.all(committedRows.map(async (turn) => {
      const rows = await sql`
        SELECT id, author_kind, direction, sender_id, sender_display_name,
               reply_to_external_message_id, content, created_at
        FROM messages
        WHERE conversation_id = ${conversation.id}
          AND (created_at, id) >= (${turn.new_message_start_at}, ${turn.new_message_start_id})
          AND (created_at, id) <= (${turn.new_message_end_at}, ${turn.new_message_end_id})
        ORDER BY created_at, id
      `;
      return {
        thoughtRunId: String(turn.id),
        turnOrdinal: Number(turn.turn_ordinal),
        newMessages: rows.map((row) => sourceFromRow(row, conversationType)),
        primaryOutput: turn.primary_output == null ? null : String(turn.primary_output),
        actionState: turn.action_state == null ? null : String(turn.action_state),
      };
    }));
    const candidates = historyRows
      .map((row) => sourceFromRow(row, conversationType))
      .reverse();
    const initializationHistory = shouldUseInitializationHistory({
      epochOrdinal: epoch?.ordinal ?? 1,
      committedTurnCount: committedTurns.length,
      hasCompression: Boolean(epoch?.compression_output),
    })
      ? selectInitializationHistory({
          messages: candidates,
          maxCount: historyCount,
          recentMinutes: historyMinutes,
          anchorAt: lastMessage.sent_at,
        })
      : [];
    const epoch = epochRows[0];
    return {
      compression: epoch?.compression_output
        ? {
            epochId: epoch.id,
            ordinal: Number(epoch.ordinal),
            output: String(epoch.compression_output),
            promptVersion: epoch.compression_prompt_version,
          }
        : null,
      initializationHistory,
      committedTurns,
      recalledMemories: [],
    };
  }

  async function executePrimaryTool(conversationId, toolCall) {
    let parsed;
    try {
      parsed = parsePrimaryToolCall(toolCall);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code ?? "invalid_tool_call",
          message: errorMessage(error).slice(0, 300),
        },
      };
    }
    if (parsed.name === "recall_memories") {
      return {
        ok: true,
        query: parsed.arguments.query,
        memories: [],
        notice: "Reviewed Agent-global memory store is not available in this MVP.",
      };
    }
    if (parsed.name === "search_conversation_messages") {
      const rows = await sql`
        SELECT id, author_kind, sender_id, sender_display_name,
               reply_to_external_message_id, content, created_at
        FROM messages
        WHERE conversation_id = ${conversationId}
          AND content ILIKE ${`%${parsed.arguments.query}%`}
        ORDER BY created_at DESC, id DESC
        LIMIT ${parsed.arguments.limit}
      `;
      return {
        ok: true,
        query: parsed.arguments.query,
        messages: rows.reverse().map((row) => ({
          message_id: String(row.id),
          author_kind: String(row.author_kind),
          sender_id: row.sender_id == null ? null : String(row.sender_id),
          sender_display_name: row.sender_display_name == null
            ? null
            : String(row.sender_display_name),
          reply_to: row.reply_to_external_message_id == null
            ? null
            : String(row.reply_to_external_message_id),
          sent_at: new Date(row.created_at).toISOString(),
          content: String(row.content),
        })),
      };
    }
    const rows = await sql`
      SELECT id, author_kind, sender_id, sender_display_name,
             reply_to_external_message_id, content, created_at
      FROM messages
      WHERE conversation_id = ${conversationId}
        AND id = ANY(${parsed.arguments.messageIds}::text[])
    `;
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return {
      ok: true,
      messages: parsed.arguments.messageIds.flatMap((messageId) => {
        const row = byId.get(messageId);
        return row ? [{
          message_id: messageId,
          author_kind: String(row.author_kind),
          sender_id: row.sender_id == null ? null : String(row.sender_id),
          sender_display_name: row.sender_display_name == null
            ? null
            : String(row.sender_display_name),
          reply_to: row.reply_to_external_message_id == null
            ? null
            : String(row.reply_to_external_message_id),
          sent_at: new Date(row.created_at).toISOString(),
          content: String(row.content),
        }] : [];
      }),
      missingMessageIds: parsed.arguments.messageIds.filter((id) => !byId.has(id)),
    };
  }

  async function ensurePrimaryToolResults({ run, thoughtRunId, llmCallId, toolCalls }) {
    const messages = [];
    for (const toolCall of toolCalls) {
      const resultId = `tool-result:${stableHash({
        llmCallId,
        key: primaryToolCallKey(thoughtRunId, toolCall),
      })}`;
      let rows = await sql`
        SELECT content, metadata
        FROM llm_call_context_items
        WHERE id = ${resultId}
        LIMIT 1
      `;
      if (!rows[0]) {
        await heartbeat(run.id);
        const result = await executePrimaryTool(
          run.conversation_id,
          toolCall,
        );
        const content = JSON.stringify(result).slice(0, 20_000);
        const parsed = (() => {
          try {
            return parsePrimaryToolCall(toolCall);
          } catch {
            return null;
          }
        })();
        await sql.begin(async (tx) => {
          const ordinals = await tx`
            SELECT COALESCE(max(ordinal), -1)::int + 1 AS next_ordinal
            FROM llm_call_context_items
            WHERE llm_call_id = ${llmCallId}
          `;
          await tx`
            INSERT INTO llm_call_context_items (
              id, llm_call_id, ordinal, item_type, reference_id, title,
              content, metadata, created_at
            ) VALUES (
              ${resultId}, ${llmCallId}, ${ordinals[0].next_ordinal},
              'tool_result', ${toolCall.id},
              ${`Tool result · ${toolCall.function.name}`}, ${content},
              ${tx.json({
                section: "tool_result",
                toolCallId: toolCall.id,
                toolName: toolCall.function.name,
                arguments: parsed?.arguments ?? null,
                ok: result.ok === true,
              })}, ${clock()}
            )
            ON CONFLICT (id) DO NOTHING
          `;
        });
        rows = await sql`
          SELECT content, metadata
          FROM llm_call_context_items
          WHERE id = ${resultId}
          LIMIT 1
        `;
      }
      messages.push({
        role: "tool",
        tool_call_id: String(toolCall.id),
        name: String(toolCall.function.name),
        content: String(rows[0].content),
      });
    }
    return messages;
  }

  async function primaryCallHistory(thoughtRunId) {
    const rows = await sql`
      SELECT id, request_context, response_json, input_tokens, output_tokens,
             sequence_number
      FROM llm_calls
      WHERE thought_run_id = ${thoughtRunId}
        AND purpose IN ('primary', 'tool_continuation')
        AND status = 'succeeded'
      ORDER BY sequence_number
    `;
    return rows.map((row) => ({
      id: String(row.id),
      requestContext: row.request_context,
      response: row.response_json ?? {},
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      sequenceNumber: Number(row.sequence_number),
    }));
  }

  async function loadPrimaryState(thoughtRunId) {
    const rows = await sql`
      SELECT primary_state, primary_output, primary_output_hash,
             primary_stop_reason, started_at
      FROM thought_runs
      WHERE id = ${thoughtRunId}
      LIMIT 1
    `;
    const row = rows[0];
    return {
      state: row?.primary_state && typeof row.primary_state === "object"
        ? row.primary_state
        : {},
      output: row?.primary_output == null ? null : String(row.primary_output),
      outputHash: row?.primary_output_hash == null ? null : String(row.primary_output_hash),
      stopReason: row?.primary_stop_reason == null ? null : String(row.primary_stop_reason),
      startedAt: row?.started_at ? new Date(row.started_at) : clock(),
    };
  }

  async function savePrimaryChunk(thoughtRunId, chunkIndex, output) {
    const now = clock();
    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT primary_state
        FROM thought_runs
        WHERE id = ${thoughtRunId}
        FOR UPDATE
      `;
      const state = rows[0]?.primary_state && typeof rows[0].primary_state === "object"
        ? rows[0].primary_state
        : {};
      const completedChunks = Array.isArray(state.completedChunks)
        ? [...state.completedChunks]
        : [];
      const existing = completedChunks.find((chunk) => chunk.chunkIndex === chunkIndex);
      const outputHash = stableHash(output);
      if (existing && existing.outputHash !== outputHash) {
        throw new CognitionValidationError(
          "primary_output_conflict",
          "已保存的 primary chunk 与本次结果不一致",
        );
      }
      if (!existing) {
        completedChunks.push({ chunkIndex, output, outputHash, completedAt: now.toISOString() });
        completedChunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
      }
      await tx`
        UPDATE thought_runs
        SET primary_state = ${tx.json({ ...state, completedChunks })}
        WHERE id = ${thoughtRunId}
      `;
    });
  }

  function assistantToolMessage(result) {
    return {
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    };
  }

  async function stopPrimary(thoughtRunId, code, message) {
    await sql`
      UPDATE thought_runs
      SET primary_stop_reason = ${code}, status = 'failed',
          processing_stage = 'failed', summary = ${message}, completed_at = ${clock()}
      WHERE id = ${thoughtRunId}
    `;
    throw new CognitionValidationError(code, message);
  }

  async function executePrimaryChunk({
    run,
    thoughtRun,
    chunk,
    chunkCount,
    initialMessages,
    provider,
    configuration,
    projection,
    limits,
    activeStartedAt,
  }) {
    const calls = await primaryCallHistory(thoughtRun.id);
    const chunkCalls = calls.filter((call) => (
      Number(call.response?.metadata?.chunkIndex) === chunk.chunkIndex
    ));
    const latest = chunkCalls.at(-1);
    if (latest && !(latest.response.toolCalls?.length) &&
        typeof latest.response.content === "string" && latest.response.content.trim()) {
      return { output: latest.response.content.trim(), callsCreated: 0 };
    }
    let messages = initialMessages;
    let purpose = "primary";
    if (latest?.response?.toolCalls?.length) {
      const toolMessages = await ensurePrimaryToolResults({
        run: { ...run, conversation_id: projection.conversationId },
        thoughtRunId: thoughtRun.id,
        llmCallId: latest.id,
        toolCalls: latest.response.toolCalls,
      });
      messages = [
        ...latest.requestContext,
        assistantToolMessage(latest.response),
        ...toolMessages,
      ];
      purpose = "tool_continuation";
    }
    try {
      return await runPrimaryToolLoop({
        initialMessages: messages,
        initialPurpose: purpose,
        limits,
        readUsage: async () => {
          const history = await primaryCallHistory(thoughtRun.id);
          return {
            rounds: history.length,
            tokens: history.reduce(
              (total, call) => total + call.inputTokens + call.outputTokens,
              0,
            ),
            toolCalls: history.reduce(
              (total, call) => total + (call.response.toolCalls?.length ?? 0),
              0,
            ),
          };
        },
        elapsedMs: () => performance.now() - activeStartedAt,
        invokeModel: async ({ messages: roundMessages, purpose: roundPurpose, round }) => {
          await heartbeat(run.id);
          const request = {
            ...primaryThoughtRequest(roundMessages),
            purpose: roundPurpose,
          };
          let result;
          let callRecorded = false;
          try {
            result = await provider.complete(request);
            const llmCallId = await recordLlmCall({
              run,
              thoughtRunId: thoughtRun.id,
              context: projection.context,
              projection: chunk,
              request,
              configuration,
              result,
              responseMetadata: {
                chunkIndex: chunk.chunkIndex,
                chunkCount,
                round,
              },
            });
            callRecorded = true;
            return { result, llmCallId };
          } catch (error) {
            if (!callRecorded) {
              await recordLlmCall({
                run,
                thoughtRunId: thoughtRun.id,
                context: projection.context,
                projection: chunk,
                request,
                configuration,
                result,
                error,
                responseMetadata: {
                  chunkIndex: chunk.chunkIndex,
                  chunkCount,
                  round,
                },
              });
            }
            throw error;
          }
        },
        executeTools: ({ llmCallId, toolCalls }) => ensurePrimaryToolResults({
          run: { ...run, conversation_id: projection.conversationId },
          thoughtRunId: thoughtRun.id,
          llmCallId,
          toolCalls,
        }),
      });
    } catch (error) {
      if (error instanceof PrimaryThoughtError && error.code.startsWith("primary_")) {
        return stopPrimary(thoughtRun.id, error.code, error.message);
      }
      throw error;
    }
  }

  async function finalizePrimary(run, thoughtRunId, conversationId, outputs) {
    const output = outputs.length === 1
      ? outputs[0]
      : outputs.map((part, index) => (
          `## Input chunk ${index + 1}/${outputs.length}\n\n${part}`
        )).join("\n\n---\n\n");
    const outputHash = stableHash(output);
    const now = clock();
    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT primary_output_hash
        FROM thought_runs
        WHERE id = ${thoughtRunId}
        FOR UPDATE
      `;
      if (rows[0]?.primary_output_hash && rows[0].primary_output_hash !== outputHash) {
        throw new CognitionValidationError(
          "primary_output_conflict",
          "immutable primary output 已存在且内容不一致",
        );
      }
      await tx`
        UPDATE thought_runs
        SET primary_output = COALESCE(primary_output, ${output}),
            primary_output_hash = COALESCE(primary_output_hash, ${outputHash}),
            primary_prompt_version = ${PRIMARY_THOUGHT_PROMPT_VERSION},
            primary_stop_reason = 'completed', primary_completed_at = ${now},
            status = 'primary_completed', processing_stage = 'compiler',
            summary = ${output.replace(/\s+/g, " ").slice(0, 300)},
            completed_at = ${now}
        WHERE id = ${thoughtRunId}
      `;
      await tx`
        INSERT INTO events (
          id, conversation_id, event_type, source_type, payload_json,
          correlation_id, created_at
        ) VALUES (
          ${`event:primary-thought:${thoughtRunId}`}, ${conversationId},
          'primary_thought_completed', 'agent',
          ${tx.json({
            thoughtRunId,
            jobRunId: run.id,
            promptVersion: PRIMARY_THOUGHT_PROMPT_VERSION,
            outputHash,
            chunkCount: outputs.length,
          })}, ${run.correlation_id}, ${now}
        )
        ON CONFLICT (id) DO NOTHING
      `;
    });
    return output;
  }

  async function loadCompilerReferences(thoughtRunId) {
    const rows = await sql`
      SELECT item.item_type, item.reference_id, item.content, item.metadata
      FROM llm_call_context_items AS item
      JOIN llm_calls AS call ON call.id = item.llm_call_id
      WHERE call.thought_run_id = ${thoughtRunId}
        AND item.item_type IN ('message', 'memory', 'tool_result', 'external_source')
      ORDER BY call.sequence_number, item.ordinal
    `;
    const references = [];
    for (const row of rows) {
      const metadata = row.metadata ?? {};
      if (row.item_type === "message" && row.reference_id) {
        references.push({
          type: "message",
          id: String(row.reference_id),
          senderId: metadata.sender_id ?? metadata.senderId ?? null,
          subjectId: null,
          sensitivity: "normal",
        });
      } else if (row.item_type === "memory" && row.reference_id) {
        references.push({
          type: "memory",
          id: String(row.reference_id),
          senderId: metadata.sourceSpeakerId ?? null,
          subjectId: metadata.subjectId ?? null,
          sensitivity: metadata.sensitivity ?? "normal",
        });
      } else if (row.reference_id) {
        references.push({
          type: "source",
          id: String(row.reference_id),
          sensitivity: "normal",
        });
        try {
          const payload = JSON.parse(String(row.content ?? "{}"));
          for (const message of payload.messages ?? []) {
            if (!message?.message_id) continue;
            references.push({
              type: "message",
              id: String(message.message_id),
              senderId: message.sender_id ?? null,
              subjectId: null,
              sensitivity: "normal",
            });
          }
          for (const memory of payload.memories ?? []) {
            if (!memory?.memory_id) continue;
            references.push({
              type: "memory",
              id: String(memory.memory_id),
              senderId: memory.source_speaker_id ?? null,
              subjectId: memory.subject_id ?? null,
              sensitivity: memory.sensitivity ?? "normal",
            });
          }
        } catch {
          // The source itself remains referenceable even if its payload is not JSON.
        }
      }
    }
    return references;
  }

  async function loadCompilerProgress(thoughtRunId) {
    const [thoughtRows, callRows] = await Promise.all([
      sql`
        SELECT primary_output, compiler_state, compiler_attempt_count,
               revision_count
        FROM thought_runs
        WHERE id = ${thoughtRunId}
        LIMIT 1
      `,
      sql`
        SELECT id, purpose, request_context, response_json, sequence_number
        FROM llm_calls
        WHERE thought_run_id = ${thoughtRunId}
          AND purpose IN ('primary', 'tool_continuation', 'revision', 'compiler')
          AND status = 'succeeded'
        ORDER BY sequence_number
      `,
    ]);
    const thought = thoughtRows[0];
    const revisionCalls = callRows.filter((call) => (
      call.purpose === "revision" &&
      typeof call.response_json?.content === "string" &&
      call.response_json.content.trim()
    ));
    const finalNaturalCall = [...callRows].reverse().find((call) => (
      ["primary", "tool_continuation", "revision"].includes(call.purpose) &&
      typeof call.response_json?.content === "string" &&
      call.response_json.content.trim() &&
      !(call.response_json?.toolCalls?.length)
    ));
    return {
      currentOutput: revisionCalls.at(-1)?.response_json.content.trim() ??
        String(thought?.primary_output ?? "").trim(),
      requestContext: finalNaturalCall?.request_context ?? [],
      compilerCalls: callRows.filter((call) => call.purpose === "compiler"),
      invalidCallIds: new Set(
        Array.isArray(thought?.compiler_state?.invalidCallIds)
          ? thought.compiler_state.invalidCallIds.map(String)
          : [],
      ),
      compilerAttemptCount: Number(thought?.compiler_attempt_count ?? 0),
      revisionCount: Math.max(
        Number(thought?.revision_count ?? 0),
        revisionCalls.length,
      ),
    };
  }

  async function recordCompilerAttempt(thoughtRunId) {
    const rows = await sql`
      UPDATE thought_runs
      SET compiler_attempt_count = compiler_attempt_count + 1,
          compiler_prompt_version = ${ACTION_COMPILER_PROMPT_VERSION},
          compiler_status = 'running', processing_stage = 'compiler'
      WHERE id = ${thoughtRunId}
      RETURNING compiler_attempt_count
    `;
    return Number(rows[0].compiler_attempt_count);
  }

  async function rejectCompilerCall(thoughtRunId, callId, error) {
    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT compiler_state
        FROM thought_runs
        WHERE id = ${thoughtRunId}
        FOR UPDATE
      `;
      const state = rows[0]?.compiler_state && typeof rows[0].compiler_state === "object"
        ? rows[0].compiler_state
        : {};
      const invalidCallIds = [...new Set([
        ...(Array.isArray(state.invalidCallIds) ? state.invalidCallIds.map(String) : []),
        String(callId),
      ])];
      await tx`
        UPDATE thought_runs
        SET compiler_state = ${tx.json({
          ...state,
          invalidCallIds,
          lastValidationError: {
            code: error.code ?? "compiler_invalid_output",
            message: error.message,
          },
        })}, compiler_status = 'retrying'
        WHERE id = ${thoughtRunId}
      `;
    });
  }

  function compilerProjection(input) {
    return {
      inputTokens: null,
      contextItems: input.referenceManifest.map((reference) => ({
        itemType: reference.type,
        referenceId: reference.id,
        title: `Compiler reference · ${reference.type}:${reference.id}`,
        content: null,
        metadata: {
          section: "compiler_manifest",
          senderId: reference.senderId,
          subjectId: reference.subjectId,
          sensitivity: reference.sensitivity,
        },
      })),
    };
  }

  async function runPrimaryRevision({
    run,
    thoughtRun,
    context,
    progress,
    revisionReasons,
    references,
    maxRevisions,
  }) {
    if (progress.revisionCount >= maxRevisions) {
      throw new ActionCompilerError(
        "revision_limit_exhausted",
        "primary revision 已达到上限，未生成 proposal",
      );
    }
    const request = primaryRevisionRequest({
      requestContext: progress.requestContext,
      currentOutput: progress.currentOutput,
      revisionReasons,
    });
    const configuration = await loadProfile("primary");
    const provider = new OpenAiCompatibleProvider({
      fetchImpl,
      loadProfile: async () => configuration,
      timeoutMs: 60_000,
    });
    let result;
    let callRecorded = false;
    try {
      await heartbeat(run.id);
      result = await provider.complete(request);
      await recordLlmCall({
        run,
        thoughtRunId: thoughtRun.id,
        context,
        projection: compilerProjection({ referenceManifest: references }),
        request,
        configuration,
        result,
        responseMetadata: {
          revisionReasons,
          sourceOutputHash: stableHash(progress.currentOutput),
          revisionNumber: progress.revisionCount + 1,
        },
      });
      callRecorded = true;
      if (result.toolCalls.length || !result.content.trim()) {
        throw new ActionCompilerError(
          "revision_invalid_output",
          "primary revision 必须直接返回自然文本且不得调用工具",
        );
      }
      await sql`
        UPDATE thought_runs
        SET revision_count = ${progress.revisionCount + 1},
            compiler_status = 'needs_revision', processing_stage = 'revision'
        WHERE id = ${thoughtRun.id}
      `;
      return result.content.trim();
    } catch (error) {
      if (!callRecorded) {
        await recordLlmCall({
          run,
          thoughtRunId: thoughtRun.id,
          context,
          projection: compilerProjection({ referenceManifest: references }),
          request,
          configuration,
          result,
          error,
          responseMetadata: {
            revisionReasons,
            sourceOutputHash: stableHash(progress.currentOutput),
            revisionNumber: progress.revisionCount + 1,
          },
        });
      }
      throw error;
    }
  }

  async function commitCompilerResult({
    run,
    thoughtRun,
    compilerCallId,
    compiled,
  }) {
    const now = clock();
    return sql.begin(async (tx) => {
      const locked = await tx`
        SELECT compiler_status
        FROM thought_runs
        WHERE id = ${thoughtRun.id}
        FOR UPDATE
      `;
      if (locked[0]?.compiler_status === "accepted") {
        const existing = await tx`
          SELECT count(*)::int AS action_count
          FROM action_proposals
          WHERE thought_run_id = ${thoughtRun.id}
        `;
        return { insertedCount: 0, actionCount: Number(existing[0].action_count) };
      }
      let insertedCount = 0;
      for (const [ordinal, action] of compiled.actions.entries()) {
        const idempotencyKey = actionProposalIdempotencyKey(
          thoughtRun.id,
          ordinal,
          action,
        );
        const proposalId = idempotencyKey;
        const inserted = await tx`
          INSERT INTO action_proposals (
            id, thought_run_id, compiler_llm_call_id, ordinal, proposal_type,
            status, idempotency_key, payload, evidence_references,
            policy_reasons, created_at, updated_at
          ) VALUES (
            ${proposalId}, ${thoughtRun.id}, ${compilerCallId}, ${ordinal},
            ${action.type}, 'proposed', ${idempotencyKey},
            ${tx.json({
              content: action.content,
              targetConversationId: action.targetConversationId,
              replyToMessageId: action.replyToMessageId,
              subjectId: action.subjectId,
              sourceSpeakerId: action.sourceSpeakerId,
              sensitivity: action.sensitivity,
            })}, ${tx.json(action.evidenceReferences)}, ${tx.json([])},
            ${now}, ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id
        `;
        insertedCount += inserted.length;
        await tx`
          INSERT INTO events (
            id, conversation_id, event_type, source_type, payload_json,
            correlation_id, created_at
          ) VALUES (
            ${`event:proposal:${proposalId}`}, ${thoughtRun.conversationId},
            'action_proposal_created', 'agent',
            ${tx.json({
              proposalId,
              thoughtRunId: thoughtRun.id,
              type: action.type,
              compilerLlmCallId: compilerCallId,
            })}, ${run.correlation_id}, ${now}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }
      const decision = compiled.actions.map((action) => action.type).join(",");
      await tx`
        UPDATE thought_runs
        SET status = 'completed', processing_stage = 'completed',
            compiler_status = 'accepted', compiler_prompt_version = ${ACTION_COMPILER_PROMPT_VERSION},
            compiler_state = compiler_state || ${tx.json({
              acceptedCompilerCallId: compilerCallId,
              actionCount: compiled.actions.length,
            })}::jsonb,
            decision = ${decision}, compiled_at = ${now}, completed_at = ${now}
        WHERE id = ${thoughtRun.id}
      `;
      await tx`
        UPDATE thought_streams
        SET committed_message_at = ${thoughtRun.newMessageEndAt},
            committed_message_id = ${thoughtRun.newMessageEndId},
            version = version + 1, updated_at = ${now}
        WHERE id = ${thoughtRun.streamId}
      `;
      await tx`
        UPDATE messages
        SET read_at = COALESCE(read_at, ${now})
        WHERE conversation_id = ${thoughtRun.conversationId}
          AND author_kind = 'user'
          AND direction = 'inbound'
          AND (created_at, id) <= (
            ${thoughtRun.newMessageEndAt}, ${thoughtRun.newMessageEndId}
          )
      `;
      await tx`
        INSERT INTO job_conversation_watermarks (
          job_id, conversation_id, last_message_at, last_message_id,
          last_success_run_id, updated_at
        ) VALUES (
          ${run.job_id}, ${thoughtRun.conversationId},
          ${thoughtRun.newMessageEndAt}, ${thoughtRun.newMessageEndId},
          ${run.id}, ${now}
        )
        ON CONFLICT (job_id, conversation_id) DO UPDATE SET
          last_message_at = EXCLUDED.last_message_at,
          last_message_id = EXCLUDED.last_message_id,
          last_success_run_id = EXCLUDED.last_success_run_id,
          updated_at = EXCLUDED.updated_at
      `;
      return { insertedCount, actionCount: compiled.actions.length };
    });
  }

  async function runActionCompiler({ run, thoughtRun, context }) {
    const maxCompilerAttempts = Math.min(
      6,
      Math.max(1, Number(run.config?.maxCompilerAttempts ?? 3)),
    );
    const maxRevisions = Math.min(
      2,
      Math.max(0, Number(run.config?.maxPrimaryRevisions ?? 2)),
    );
    const references = await loadCompilerReferences(thoughtRun.id);
    const participants = [...new Map([
      ...context.participants.map((participant) => ({
        id: participant.participant_id,
        displayName: participant.display_name,
      })),
      { id: "agent-asuka", displayName: "Asuka" },
    ].map((participant) => [participant.id, participant])).values()];
    let progress = await loadCompilerProgress(thoughtRun.id);
    while (true) {
      const input = buildCompilerInput({
        thoughtRunId: thoughtRun.id,
        primaryOutput: progress.currentOutput,
        conversation: {
          id: context.conversation.conversation_id,
          type: context.conversation.type,
        },
        participants,
        references,
        policy: { maxActions: 4, effectsEnabled: false },
      });
      const sourceOutputHash = stableHash(progress.currentOutput);
      let compilerCall = selectReusableCompilerCall(
        progress.compilerCalls,
        progress.invalidCallIds,
        sourceOutputHash,
      );
      let compiled;
      if (compilerCall) {
        try {
          compiled = validateCompilerOutput(
            parseActionCompilerContent(compilerCall.response_json.content),
            input,
          );
        } catch (error) {
          await rejectCompilerCall(thoughtRun.id, compilerCall.id, error);
          compilerCall = null;
          progress = await loadCompilerProgress(thoughtRun.id);
          continue;
        }
      } else {
        if (progress.compilerAttemptCount >= maxCompilerAttempts) {
          throw new ActionCompilerError(
            "compiler_attempts_exhausted",
            "fast compiler 已达到重试上限，未执行任何 effect",
          );
        }
        const request = actionCompilerRequest(input);
        const configuration = await loadProfile("fast");
        const provider = new OpenAiCompatibleProvider({
          fetchImpl,
          loadProfile: async () => configuration,
          timeoutMs: 60_000,
        });
        let result;
        let callRecorded = false;
        try {
          await heartbeat(run.id);
          result = await provider.complete(request);
          const callId = await recordLlmCall({
            run,
            thoughtRunId: thoughtRun.id,
            context,
            projection: compilerProjection(input),
            request,
            configuration,
            result,
            responseMetadata: { sourceOutputHash },
          });
          callRecorded = true;
          await recordCompilerAttempt(thoughtRun.id);
          compilerCall = {
            id: callId,
            response_json: {
              content: result.content,
              metadata: { sourceOutputHash },
            },
          };
          try {
            compiled = validateCompilerOutput(
              parseActionCompilerContent(result.content),
              input,
            );
          } catch (error) {
            await rejectCompilerCall(thoughtRun.id, callId, error);
            progress = await loadCompilerProgress(thoughtRun.id);
            continue;
          }
        } catch (error) {
          if (!callRecorded) {
            await recordLlmCall({
              run,
              thoughtRunId: thoughtRun.id,
              context,
              projection: compilerProjection(input),
              request,
              configuration,
              result,
              error,
              responseMetadata: { sourceOutputHash },
            });
            await recordCompilerAttempt(thoughtRun.id);
          }
          throw error;
        }
      }
      if (compiled.status === "accepted") {
        return commitCompilerResult({
          run,
          thoughtRun,
          compilerCallId: compilerCall.id,
          compiled,
        });
      }
      await runPrimaryRevision({
        run,
        thoughtRun,
        context,
        progress,
        revisionReasons: compiled.revisionReasons,
        references,
        maxRevisions,
      });
      progress = await loadCompilerProgress(thoughtRun.id);
    }
  }

  async function completedThoughtMetrics(thoughtRunId) {
    const rows = await sql`
      SELECT
        (SELECT count(*)::int FROM llm_calls WHERE thought_run_id = ${thoughtRunId})
          AS llm_call_count,
        (SELECT count(*)::int FROM action_proposals
         WHERE thought_run_id = ${thoughtRunId} AND proposal_type = 'memory')
          AS memory_count,
        (SELECT count(*)::int FROM action_proposals WHERE thought_run_id = ${thoughtRunId})
          AS proposal_count
    `;
    return {
      llmCallCount: Number(rows[0].llm_call_count),
      candidateCount: Number(rows[0].memory_count),
      thoughtCount: Number(rows[0].proposal_count) > 0 ? 1 : 0,
    };
  }

  function outboundPolicyFromRow(row) {
    return {
      enabled: row.policy_enabled === true,
      timezone: String(row.policy_timezone ?? "Asia/Shanghai"),
      quietStartMinute: Number(row.quiet_start_minute ?? 0),
      quietEndMinute: Number(row.quiet_end_minute ?? 0),
      dailyBudget: Number(row.daily_budget ?? 10),
      cooldownSeconds: Number(row.cooldown_seconds ?? 300),
      duplicateWindowSeconds: Number(row.duplicate_window_seconds ?? 86_400),
      freshnessSeconds: Number(row.freshness_seconds ?? 1_800),
    };
  }

  function conversationAllowlisted(row) {
    const externalId = String(row.external_conversation_id ?? "");
    const config = row.channel_config ?? {};
    if (externalId.startsWith("group:")) {
      return Array.isArray(config.groupWhitelist) &&
        config.groupWhitelist.map(String).includes(externalId.slice("group:".length));
    }
    if (externalId.startsWith("private:")) {
      return Array.isArray(config.privateUserWhitelist) &&
        config.privateUserWhitelist.map(String).includes(externalId.slice("private:".length));
    }
    return false;
  }

  async function loadSpeechProposalRows({ thoughtRunId = null, deferredOnly = false } = {}) {
    return sql`
      SELECT proposal.id AS proposal_id, proposal.proposal_type,
             proposal.payload, proposal.evidence_references, proposal.created_at,
             thought.id AS thought_run_id, thought.agent_id, thought.compiled_at,
             thought.correlation_id, conversation.id AS conversation_id,
             conversation.external_id AS external_conversation_id,
             conversation.channel_id, channel.enabled AS channel_enabled,
             channel.config AS channel_config, agent.mode AS agent_mode,
             policy.enabled AS policy_enabled, policy.timezone AS policy_timezone,
             policy.quiet_start_minute, policy.quiet_end_minute,
             policy.daily_budget, policy.cooldown_seconds,
             policy.duplicate_window_seconds, policy.freshness_seconds,
             decision.id AS decision_id, decision.outcome AS existing_outcome,
             decision.evaluation_count
      FROM action_proposals AS proposal
      JOIN thought_runs AS thought ON thought.id = proposal.thought_run_id
      JOIN conversations AS conversation ON conversation.id = thought.conversation_id
      JOIN agents AS agent ON agent.id = thought.agent_id
      LEFT JOIN channels AS channel ON channel.id = conversation.channel_id
      LEFT JOIN outbound_policies AS policy ON policy.agent_id = thought.agent_id
      LEFT JOIN speech_decisions AS decision ON decision.proposal_id = proposal.id
      WHERE proposal.proposal_type IN ('reply', 'no_action')
        AND (${thoughtRunId}::text IS NULL OR thought.id = ${thoughtRunId})
        AND (
          (${deferredOnly} = false AND decision.id IS NULL)
          OR (${deferredOnly} = true AND decision.outcome = 'defer'
              AND decision.next_evaluation_at <= ${clock()})
        )
      ORDER BY proposal.created_at
      LIMIT 50
    `;
  }

  async function speechPolicyStats(row, contentHash, policy) {
    const now = clock();
    const duplicateAfter = new Date(
      now.getTime() - Math.max(0, policy.duplicateWindowSeconds) * 1_000,
    );
    const rows = await sql`
      SELECT
        count(*) FILTER (
          WHERE outcome IN ('speak', 'shadow_speak')
            AND created_at >= (
              date_trunc('day', ${now} AT TIME ZONE ${policy.timezone})
              AT TIME ZONE ${policy.timezone}
            )
        )::int AS sent_today,
        max(created_at) FILTER (
          WHERE outcome IN ('speak', 'shadow_speak')
            AND conversation_id = ${row.conversation_id}
        ) AS last_spoken_at,
        bool_or(
          content_hash = ${contentHash}
          AND conversation_id = ${row.conversation_id}
          AND created_at >= ${duplicateAfter}
          AND outcome IN ('speak', 'shadow_speak')
          AND id <> COALESCE(${row.decision_id}, '')
        ) AS duplicate_seen
      FROM speech_decisions
      WHERE agent_id = ${row.agent_id}
    `;
    return {
      sentToday: Number(rows[0].sent_today ?? 0),
      lastSpokenAt: rows[0].last_spoken_at,
      duplicateSeen: rows[0].duplicate_seen === true,
    };
  }

  async function persistSpeechDecision(row, evaluation, policy, stats) {
    const now = clock();
    const draft = String(row.payload?.content ?? "");
    const contentHash = speechContentHash(draft);
    const decisionId = row.decision_id ?? `speech-decision:${row.proposal_id}`;
    const policySnapshot = {
      agentMode: row.agent_mode,
      ...policy,
      channelEnabled: row.channel_enabled === true,
      allowlisted: conversationAllowlisted(row),
      sentToday: stats.sentToday,
      lastSpokenAt: stats.lastSpokenAt,
      duplicateSeen: stats.duplicateSeen,
    };
    return sql.begin(async (tx) => {
      const decisions = await tx`
        INSERT INTO speech_decisions (
          id, agent_id, thought_run_id, proposal_id, conversation_id,
          outcome, reason_code, draft, content_hash, evidence_references,
          policy_snapshot, next_evaluation_at, evaluation_count,
          created_at, updated_at
        ) VALUES (
          ${decisionId}, ${row.agent_id}, ${row.thought_run_id}, ${row.proposal_id},
          ${row.conversation_id}, ${evaluation.outcome}, ${evaluation.reasonCode},
          ${draft}, ${contentHash}, ${tx.json(row.evidence_references ?? [])},
          ${tx.json(policySnapshot)}, ${evaluation.nextEvaluationAt}, 1,
          ${now}, ${now}
        )
        ON CONFLICT (proposal_id) DO UPDATE SET
          outcome = EXCLUDED.outcome,
          reason_code = EXCLUDED.reason_code,
          policy_snapshot = EXCLUDED.policy_snapshot,
          next_evaluation_at = EXCLUDED.next_evaluation_at,
          evaluation_count = speech_decisions.evaluation_count + 1,
          updated_at = EXCLUDED.updated_at
        WHERE speech_decisions.outcome = 'defer'
        RETURNING id, outcome
      `;
      if (!decisions[0]) return null;
      const proposalStatus = evaluation.outcome === "speak" ||
        evaluation.outcome === "shadow_speak"
        ? "policy_approved"
        : evaluation.outcome === "defer"
          ? "proposed"
          : row.proposal_type === "no_action"
            ? "executed"
            : "policy_rejected";
      await tx`
        UPDATE action_proposals
        SET status = ${proposalStatus},
            policy_reasons = ${tx.json([evaluation.reasonCode])}, updated_at = ${now}
        WHERE id = ${row.proposal_id}
      `;
      if (evaluation.outcome === "speak") {
        const messageId = `outbound-message:${row.proposal_id}`;
        const deliveryId = `outbound-delivery:${row.proposal_id}`;
        const echo = `outbound:${decisions[0].id}`;
        await tx`
          INSERT INTO messages (
            id, conversation_id, role, author_kind, direction, content,
            sender_id, sender_display_name, reply_to_external_message_id,
            external_receipt, citations_json, correlation_id, read_at, created_at
          ) VALUES (
            ${messageId}, ${row.conversation_id}, 'assistant', 'agent', 'outbound',
            ${draft}, 'agent-asuka', 'Asuka', ${row.payload?.replyToMessageId ?? null},
            ${tx.json({ status: "queued", outboundDeliveryId: deliveryId })},
            ${tx.json(row.evidence_references ?? [])}, ${row.correlation_id}, ${now}, ${now}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        await tx`
          INSERT INTO outbound_deliveries (
            id, speech_decision_id, channel_id, conversation_id, message_id,
            external_conversation_id, echo, status, available_at,
            attempt_count, max_attempts, created_at, updated_at
          ) VALUES (
            ${deliveryId}, ${decisions[0].id}, ${row.channel_id},
            ${row.conversation_id}, ${messageId}, ${row.external_conversation_id},
            ${echo}, 'queued', ${now}, 0, 3, ${now}, ${now}
          )
          ON CONFLICT (speech_decision_id) DO NOTHING
        `;
      }
      await tx`
        INSERT INTO events (
          id, conversation_id, event_type, source_type, payload_json,
          correlation_id, created_at
        ) VALUES (
          ${`event:speech-decision:${decisions[0].id}:${decisions[0].outcome}`},
          ${row.conversation_id}, 'speech_decision_evaluated', 'policy',
          ${tx.json({
            decisionId: decisions[0].id,
            proposalId: row.proposal_id,
            thoughtRunId: row.thought_run_id,
            outcome: evaluation.outcome,
            reasonCode: evaluation.reasonCode,
          })}, ${row.correlation_id}, ${now}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      return decisions[0];
    });
  }

  async function evaluateSpeechRow(row) {
    const policy = outboundPolicyFromRow(row);
    const draft = String(row.payload?.content ?? "");
    const contentHash = speechContentHash(draft);
    const stats = await speechPolicyStats(row, contentHash, policy);
    const evaluation = evaluateSpeechPolicy({
      proposal: {
        type: row.proposal_type,
        conversationId: row.conversation_id,
        targetConversationId: row.payload?.targetConversationId ?? null,
        draft,
        evidenceReferences: row.evidence_references,
        createdAt: row.compiled_at ?? row.created_at,
      },
      agentMode: row.agent_mode,
      policy,
      channelEnabled: row.channel_enabled === true,
      allowlisted: conversationAllowlisted(row),
      now: clock(),
      ...stats,
    });
    return persistSpeechDecision(row, evaluation, policy, stats);
  }

  async function processSpeechDecisions({ thoughtRunId = null, deferredOnly = false } = {}) {
    const rows = await loadSpeechProposalRows({ thoughtRunId, deferredOnly });
    for (const row of rows) await evaluateSpeechRow(row);
    return rows.length;
  }

  async function recordLlmCall({
    run,
    thoughtRunId,
    context,
    projection,
    request,
    configuration,
    result,
    error,
    responseMetadata = {},
  }) {
    const failure = error ? cognitionError(error) : null;
    const now = clock();
    const callId = randomUUID();
    const requestMessages = result?.requestMessages ?? request.messages;
    let provider = "openai-compatible";
    try {
      provider = new URL(configuration?.baseUrl).host;
    } catch {
      // Keep the generic provider label when the URL is unavailable.
    }
    await sql.begin(async (tx) => {
      const sequenceRows = await tx`
        SELECT COALESCE(max(sequence_number), 0)::int + 1 AS next_sequence
        FROM llm_calls
        WHERE thought_run_id = ${thoughtRunId}
      `;
      await tx`
        INSERT INTO llm_calls (
          id, job_run_id, thought_run_id, conversation_id, correlation_id,
          profile, provider, model, prompt_version, input_hash, output_hash,
          status, error_code, latency_ms, input_tokens, output_tokens,
          sequence_number, purpose, request_context, response_json, created_at
        ) VALUES (
          ${callId}, ${run.id}, ${thoughtRunId},
          ${context.conversation.conversation_id}, ${run.correlation_id},
          ${request.profile}, ${provider},
          ${result?.model ?? configuration?.modelId ?? null},
          ${request.promptVersion}, ${stableHash(requestMessages)},
          ${result ? stableHash(result.content) : null},
          ${failure ? "failed" : "succeeded"}, ${failure?.code ?? null},
          ${result?.latencyMs ?? null}, ${result?.inputTokens ?? projection?.inputTokens ?? null},
          ${result?.outputTokens ?? null}, ${sequenceRows[0].next_sequence},
          ${request.purpose ?? "primary"},
          ${tx.json(requestMessages)},
          ${result ? tx.json({
            content: result.content,
            toolCalls: result.toolCalls ?? [],
            finishReason: result.finishReason ?? null,
            metadata: responseMetadata,
          }) : null}, ${now}
        )
      `;
      const contextItems = [
        ...(projection?.contextItems ?? []),
        ...(request.tools ?? []).map((tool) => ({
          itemType: "tool_definition",
          referenceId: tool.function.name,
          title: `Read-only tool · ${tool.function.name}`,
          content: tool.function.description,
          metadata: {
            section: "tools",
            schema: tool.function.parameters,
          },
        })),
        ...(request.responseSchema ? [{
          itemType: "response_schema",
          referenceId: request.promptVersion,
          title: "Structured output JSON Schema",
          content: JSON.stringify(request.responseSchema),
          metadata: { section: "output_contract" },
        }] : []),
      ];
      for (const [ordinal, item] of contextItems.entries()) {
        await tx`
          INSERT INTO llm_call_context_items (
            id, llm_call_id, ordinal, item_type, reference_id, title,
            content, metadata, created_at
          ) VALUES (
            ${randomUUID()}, ${callId}, ${ordinal}, ${item.itemType},
            ${item.referenceId}, ${item.title}, ${item.content},
            ${tx.json(item.metadata)}, ${now}
          )
        `;
      }
    });
    return callId;
  }

  async function persistConversationResult({
    run,
    thoughtRunId,
    context,
    request,
    output,
    now,
  }) {
    const lastMessage = context.messages.at(-1);
    const metrics = { thoughtCount: 0, candidateCount: 0 };
    await sql.begin(async (tx) => {
      if (run.job_type === "thought_tick") {
        const thought = validateThoughtOutput(output, context, now);
        if (thought) {
          const idempotencyKey = outputIdempotencyKey(
            run.job_type,
            context.conversation.conversation_id,
            lastMessage.message_id,
          );
          const thoughtId = randomUUID();
          const inserted = await tx`
            INSERT INTO operational_thoughts (
              id, agent_id, conversation_id, job_run_id, thought_run_id,
              idempotency_key, intent, basis, evidence_message_ids,
              confidence_millis, risk, decision, expires_at, prompt_version,
              created_at
            ) VALUES (
              ${thoughtId}, ${run.agent_id}, ${context.conversation.conversation_id},
              ${run.id}, ${thoughtRunId}, ${idempotencyKey}, ${thought.intent},
              ${thought.basis}, ${tx.json(thought.evidenceMessageIds)},
              ${thought.confidenceMillis}, ${thought.risk}, ${thought.decision},
              ${thought.expiresAt}, ${request.promptVersion}, ${now}
            )
            ON CONFLICT (thought_run_id) DO NOTHING
            RETURNING id
          `;
          if (inserted.length) {
            metrics.thoughtCount += 1;
            await tx`
              INSERT INTO events (
                id, conversation_id, event_type, source_type, payload_json,
                correlation_id, created_at
              ) VALUES (
                ${`event:thought:${thoughtId}`}, ${context.conversation.conversation_id},
                'operational_thought_created', 'agent',
                ${tx.json({
                  thoughtId,
                  thoughtRunId,
                  jobRunId: run.id,
                  evidenceMessageIds: thought.evidenceMessageIds,
                  decision: thought.decision,
                })}, ${run.correlation_id}, ${now}
              )
            `;
          }
        }
      } else {
        const candidates = validateMemoryOutput(output, context);
        for (const [candidateIndex, candidate] of candidates.entries()) {
          const idempotencyKey = outputIdempotencyKey(
            run.job_type,
            context.conversation.conversation_id,
            lastMessage.message_id,
            candidateIndex,
          );
          const candidateId = randomUUID();
          const inserted = await tx`
            INSERT INTO memory_candidates (
              id, agent_id, conversation_id, job_run_id, thought_run_id,
              idempotency_key, operation, subject_id, source_speaker_id,
              claim, evidence_message_ids, confidence_millis,
              attribution_status, target_candidate_id, status,
              prompt_version, created_at, updated_at
            ) VALUES (
              ${candidateId}, ${run.agent_id}, ${context.conversation.conversation_id},
              ${run.id}, ${thoughtRunId}, ${idempotencyKey},
              ${candidate.operation}, ${candidate.subjectId},
              ${candidate.sourceSpeakerId}, ${candidate.claim},
              ${tx.json(candidate.evidenceMessageIds)},
              ${candidate.confidenceMillis}, ${candidate.attributionStatus},
              ${candidate.targetCandidateId}, 'pending_review',
              ${request.promptVersion}, ${now}, ${now}
            )
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
          `;
          if (inserted.length) {
            metrics.candidateCount += 1;
            await tx`
              INSERT INTO events (
                id, conversation_id, event_type, source_type, payload_json,
                correlation_id, created_at
              ) VALUES (
                ${`event:memory-candidate:${candidateId}`},
                ${context.conversation.conversation_id},
                'memory_candidate_created', 'agent',
                ${tx.json({
                  candidateId,
                  thoughtRunId,
                  jobRunId: run.id,
                  operation: candidate.operation,
                  subjectId: candidate.subjectId,
                  sourceSpeakerId: candidate.sourceSpeakerId,
                  evidenceMessageIds: candidate.evidenceMessageIds,
                })}, ${run.correlation_id}, ${now}
              )
            `;
          }
        }
      }
      await tx`
        INSERT INTO job_conversation_watermarks (
          job_id, conversation_id, last_message_at, last_message_id,
          last_success_run_id, updated_at
        ) VALUES (
          ${run.job_id}, ${context.conversation.conversation_id},
          ${lastMessage.sent_at}, ${lastMessage.message_id}, ${run.id}, ${now}
        )
        ON CONFLICT (job_id, conversation_id) DO UPDATE SET
          last_message_at = EXCLUDED.last_message_at,
          last_message_id = EXCLUDED.last_message_id,
          last_success_run_id = EXCLUDED.last_success_run_id,
          updated_at = EXCLUDED.updated_at
      `;
      const summary = run.job_type === "thought_tick"
        ? output.action === "create"
          ? output.intent
          : "模型检查了本轮上下文，未形成可执行思绪"
        : metrics.candidateCount > 0
          ? `生成 ${metrics.candidateCount} 条待审记忆候选`
          : "模型检查了本轮上下文，未生成记忆候选";
      const decision = run.job_type === "thought_tick"
        ? output.action === "create" ? output.decision : "silent"
        : "memory_review";
      await tx`
        UPDATE thought_runs
        SET status = 'completed', processing_stage = 'completed',
            decision = ${decision}, summary = ${summary}, completed_at = ${now}
        WHERE id = ${thoughtRunId}
      `;
      await tx`
        UPDATE thought_streams AS stream
        SET committed_message_at = ${lastMessage.sent_at},
            committed_message_id = ${lastMessage.message_id},
            version = stream.version + 1,
            updated_at = ${now}
        FROM thought_runs AS thought
        WHERE thought.id = ${thoughtRunId} AND stream.id = thought.stream_id
      `;
      if (run.job_type === "thought_tick") {
        await tx`
          UPDATE messages
          SET read_at = COALESCE(read_at, ${now})
          WHERE conversation_id = ${context.conversation.conversation_id}
            AND author_kind = 'user'
            AND direction = 'inbound'
            AND (created_at, id) <= (${lastMessage.sent_at}, ${lastMessage.message_id})
        `;
      }
    });
    return metrics;
  }

  async function processConversation(run, conversation) {
    const context = await loadContext(run, conversation);
    const isPrimaryThought = run.job_type === "thought_tick";
    const baseRequest = isPrimaryThought
      ? primaryThoughtRequest([{ role: "system", content: PRIMARY_THOUGHT_SYSTEM_PROMPT }])
      : cognitionRequest(run.job_type, context);
    const thoughtRun = await ensureThoughtRun(run, conversation, context);
    let configuration;
    try {
      configuration = await loadProfile(baseRequest.profile);
      if (!configuration) {
        throw new LlmConfigurationError(
          "profile_missing",
          `${baseRequest.profile} 模型尚未配置`,
          503,
        );
      }
      if (isPrimaryThought) {
        const saved = await loadPrimaryState(thoughtRun.id);
        if (saved.output) {
          await runActionCompiler({ run, thoughtRun, context });
          await processSpeechDecisions({ thoughtRunId: thoughtRun.id });
          const completed = await completedThoughtMetrics(thoughtRun.id);
          return {
            messageCount: context.messages.filter((message) => (
              (message.sent_at < new Date(thoughtRun.newMessageEndAt).toISOString()) ||
              (message.sent_at === new Date(thoughtRun.newMessageEndAt).toISOString() &&
                message.message_id <= thoughtRun.newMessageEndId)
            )).length,
            ...completed,
          };
        }
      }
      const persistent = await loadProjectionContext(
        run,
        conversation,
        context,
        thoughtRun,
      );
      const projection = projectThoughtContext({
        systemMessages: [baseRequest.messages[0]],
        compression: persistent.compression,
        initializationHistory: persistent.initializationHistory,
        committedTurns: persistent.committedTurns,
        recalledMemories: persistent.recalledMemories,
        newMessages: context.messages,
        tools: isPrimaryThought ? PRIMARY_THOUGHT_TOOLS : [],
        contextWindow: configuration.contextWindow,
        reservedOutputTokens: baseRequest.maxOutputTokens,
        reservedToolResultTokens: Math.max(
          0,
          Number(run.config?.reservedToolResultTokens ?? 1_024),
        ),
      });
      const provider = new OpenAiCompatibleProvider({
        fetchImpl,
        loadProfile: async () => configuration,
        timeoutMs: 60_000,
      });
      const sourcePool = new Map([
        ...persistent.initializationHistory,
        ...persistent.committedTurns.flatMap((turn) => turn.newMessages),
        ...context.messages,
      ].map((message) => [message.message_id, message]));
      const metrics = {
        messageCount: 0,
        llmCallCount: 0,
        thoughtCount: 0,
        candidateCount: 0,
      };
      if (isPrimaryThought) {
        const saved = await loadPrimaryState(thoughtRun.id);
        const completedChunks = new Map(
          (Array.isArray(saved.state.completedChunks)
            ? saved.state.completedChunks
            : []).map((chunk) => [Number(chunk.chunkIndex), String(chunk.output)]),
        );
        const outputs = [];
        const activeStartedAt = performance.now();
        const configuredRounds = Number(
          run.config?.maxPrimaryRounds ?? projection.chunks.length + 4,
        );
        const configuredTokens = Number(
          run.config?.maxPrimaryTokens ?? configuration.contextWindow * 2,
        );
        const configuredToolCalls = Number(run.config?.maxPrimaryToolCalls ?? 8);
        const configuredActiveMs = Number(run.config?.maxPrimaryActiveMs ?? 120_000);
        const limits = {
          maxRounds: Math.min(
            30,
            Math.max(projection.chunks.length, Number.isSafeInteger(configuredRounds)
              ? configuredRounds
              : projection.chunks.length + 4),
          ),
          maxTokens: Math.min(
            4_000_000,
            Math.max(configuration.contextWindow, Number.isSafeInteger(configuredTokens)
              ? configuredTokens
              : configuration.contextWindow * 2),
          ),
          maxToolCalls: Math.min(
            30,
            Math.max(0, Number.isSafeInteger(configuredToolCalls) ? configuredToolCalls : 8),
          ),
          maxActiveMs: Math.min(
            10 * 60_000,
            Math.max(5_000, Number.isSafeInteger(configuredActiveMs)
              ? configuredActiveMs
              : 120_000),
          ),
        };
        for (const chunk of projection.chunks) {
          const projectedMessages = chunk.contextItems
            .filter((item) => item.itemType === "message")
            .map((item) => sourcePool.get(item.referenceId))
            .filter(Boolean);
          const chunkContext = { ...context, messages: projectedMessages };
          const savedOutput = completedChunks.get(chunk.chunkIndex);
          if (savedOutput) {
            outputs.push(savedOutput);
            continue;
          }
          const newSourceCount = chunk.contextItems.filter(
            (item) => item.itemType === "message" &&
              item.metadata.section === "new_source",
          ).length;
          const prefixLength = chunk.messages.length - newSourceCount;
          const initialMessages = [
            ...chunk.messages.slice(0, prefixLength),
            ...outputs.map((output) => ({ role: "assistant", content: output })),
            ...chunk.messages.slice(prefixLength),
          ];
          const result = await executePrimaryChunk({
            run,
            thoughtRun,
            chunk,
            chunkCount: projection.chunks.length,
            initialMessages,
            provider,
            configuration,
            projection: {
              context: chunkContext,
              conversationId: context.conversation.conversation_id,
            },
            limits,
            activeStartedAt,
          });
          await savePrimaryChunk(thoughtRun.id, chunk.chunkIndex, result.output);
          outputs.push(result.output);
          metrics.llmCallCount += result.callsCreated;
        }
        await finalizePrimary(
          run,
          thoughtRun.id,
          context.conversation.conversation_id,
          outputs,
        );
        await runActionCompiler({ run, thoughtRun, context });
        await processSpeechDecisions({ thoughtRunId: thoughtRun.id });
        return {
          messageCount: context.messages.length,
          ...await completedThoughtMetrics(thoughtRun.id),
        };
      }
      for (const chunk of projection.chunks) {
        const request = {
          ...baseRequest,
          purpose: "primary",
          messages: chunk.messages,
        };
        const projectedMessages = chunk.contextItems
          .filter((item) => item.itemType === "message")
          .map((item) => sourcePool.get(item.referenceId))
          .filter(Boolean);
        const chunkContext = { ...context, messages: projectedMessages };
        let result;
        let callRecorded = false;
        try {
          result = await provider.complete(request);
          await recordLlmCall({
            run,
            thoughtRunId: thoughtRun.id,
            context: chunkContext,
            projection: chunk,
            request,
            configuration,
            result,
          });
          callRecorded = true;
          const output = parseStructuredOutput(result.content);
          const persisted = await persistConversationResult({
            run,
            thoughtRunId: thoughtRun.id,
            context: chunkContext,
            request,
            output,
            now: clock(),
          });
          metrics.llmCallCount += 1;
          metrics.messageCount += chunk.contextItems.filter(
            (item) => item.itemType === "message" &&
              item.metadata.section === "new_source",
          ).length;
          metrics.thoughtCount += persisted.thoughtCount;
          metrics.candidateCount += persisted.candidateCount;
        } catch (error) {
          if (!callRecorded) {
            await recordLlmCall({
              run,
              thoughtRunId: thoughtRun.id,
              context: chunkContext,
              projection: chunk,
              request,
              configuration,
              result,
              error,
            });
          }
          throw error;
        }
      }
      return metrics;
    } catch (error) {
      const failure = cognitionError(error);
      await sql`
        UPDATE thought_runs
        SET status = CASE
              WHEN compiler_status = 'accepted' THEN status
              ELSE 'failed'
            END,
            processing_stage = CASE
              WHEN compiler_status = 'accepted' THEN processing_stage
              ELSE 'failed'
            END,
            compiler_status = CASE
              WHEN compiler_status = 'accepted' THEN compiler_status
              WHEN primary_output IS NOT NULL THEN ${failure.retryable ? "retrying" : "dead_letter"}
              ELSE compiler_status
            END,
            summary = CASE
              WHEN compiler_status = 'accepted' THEN summary
              ELSE ${failure.message}
            END,
            completed_at = CASE
              WHEN compiler_status = 'accepted' THEN completed_at
              ELSE ${clock()}
            END
        WHERE id = ${thoughtRun.id}
      `;
      throw error;
    } finally {
      await releaseThoughtStream(thoughtRun.id);
    }
  }

  async function completeRun(run, metrics) {
    const now = clock();
    await sql.begin(async (tx) => {
      await tx`
        UPDATE job_runs
        SET status = 'succeeded', completed_at = ${now}, metrics = ${tx.json(metrics)},
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ${now},
            error_code = NULL, error_message = NULL
        WHERE id = ${run.id} AND lease_owner = ${leaseOwner}
      `;
      await tx`
        UPDATE jobs SET last_run_at = ${now}, updated_at = ${now}
        WHERE id = ${run.job_id}
      `;
    });
  }

  async function failRun(run, error, metrics) {
    const failure = cognitionError(error);
    const now = clock();
    const retry = failure.retryable && run.attempt_count < run.max_attempts;
    await sql.begin(async (tx) => {
      await tx`
        UPDATE job_runs
        SET status = ${retry ? "retry_wait" : "dead_letter"},
            available_at = ${retry
              ? new Date(now.getTime() + retryDelayMs(run.attempt_count))
              : now},
            completed_at = ${retry ? null : now}, error_code = ${failure.code},
            error_message = ${failure.message.slice(0, 1_000)},
            metrics = ${tx.json(metrics)},
            lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = ${now}
        WHERE id = ${run.id} AND lease_owner = ${leaseOwner}
      `;
      await tx`
        UPDATE jobs SET last_run_at = ${now}, updated_at = ${now}
        WHERE id = ${run.job_id}
      `;
    });
    logger.error(`cognition run ${run.id} ${retry ? "will retry" : "dead-lettered"}`, {
      code: failure.code,
    });
  }

  async function executeRun(run) {
    if (!cognitionJobTypes.has(run.job_type)) {
      throw new CognitionValidationError("unsupported_job", "任务类型不受认知 worker 支持");
    }
    const metrics = {
      conversationCount: 0,
      messageCount: 0,
      llmCallCount: 0,
      thoughtCount: 0,
      candidateCount: 0,
    };
    const heartbeatTimer = setInterval(() => {
      void heartbeat(run.id).catch((error) => {
        logger.error("cognition heartbeat failed", { code: cognitionError(error).code });
      });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    heartbeatTimer.unref();
    try {
      const conversations = await eligibleConversations(run);
      for (const conversation of conversations) {
        const result = await processConversation(run, conversation);
        metrics.conversationCount += 1;
        for (const key of ["messageCount", "llmCallCount", "thoughtCount", "candidateCount"]) {
          metrics[key] += result[key];
        }
      }
      await completeRun(run, metrics);
      logger.log(`completed ${run.job_type} run ${run.id}`, metrics);
    } catch (error) {
      await failRun(run, error, metrics);
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  async function runCycle() {
    await processSpeechDecisions();
    await processSpeechDecisions({ deferredOnly: true });
    await scheduleDueRuns();
    let processed = 0;
    while (processed < maxRunsPerCycle) {
      const run = await claimRun();
      if (!run) break;
      await executeRun(run);
      processed += 1;
    }
    return processed;
  }

  return { runCycle, scheduleDueRuns };
}
