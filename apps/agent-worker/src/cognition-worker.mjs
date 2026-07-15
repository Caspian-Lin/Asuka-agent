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
    await sql`
      UPDATE job_runs
      SET heartbeat_at = ${now}, lease_expires_at = ${new Date(now.getTime() + leaseMs)}
      WHERE id = ${runId} AND status = 'running' AND lease_owner = ${leaseOwner}
    `;
  }

  async function loadProfile(profile) {
    const rows = await sql`
      SELECT enabled, base_url, model_id, encrypted_api_key
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
      apiKey: row.encrypted_api_key
        ? decryptApiKey(row.encrypted_api_key, parseEncryptionKey(encryptionKey))
        : null,
    };
  }

  async function eligibleConversations(run) {
    return sql`
      SELECT c.id, c.title, c.channel, c.external_id,
             watermark.last_message_at, watermark.last_message_id
      FROM conversations AS c
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
            AND message.sender_id IS NOT NULL
            AND (
              watermark.last_message_at IS NULL
              OR (message.created_at, message.id) >
                 (watermark.last_message_at, watermark.last_message_id)
            )
        )
      ORDER BY c.updated_at
    `;
  }

  async function loadContext(run, conversation) {
    const maxMessages = Math.min(200, Math.max(1, Number(run.config?.maxMessages ?? 50)));
    const messages = await sql`
      SELECT id, sender_id, sender_display_name, reply_to_external_message_id,
             content, created_at
      FROM messages
      WHERE conversation_id = ${conversation.id}
        AND sender_id IS NOT NULL
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
        SELECT id, current_epoch_ordinal
        FROM thought_streams
        WHERE agent_id = ${run.agent_id} AND conversation_id = ${conversation.id}
        FOR UPDATE
      `;
      const stream = streams[0];
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
        SELECT id
        FROM thought_runs
        WHERE job_run_id = ${run.id} AND conversation_id = ${conversation.id}
        LIMIT 1
      `;
      if (existing[0]) {
        await tx`
          UPDATE thought_runs
          SET status = 'running', processing_stage = 'primary', completed_at = NULL
          WHERE id = ${existing[0].id}
        `;
        return existing[0].id;
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
      return rows[0].id;
    });
  }

  async function recordLlmCall({
    run,
    thoughtRunId,
    context,
    request,
    configuration,
    result,
    error,
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
          sequence_number, request_context, response_json, created_at
        ) VALUES (
          ${callId}, ${run.id}, ${thoughtRunId},
          ${context.conversation.conversation_id}, ${run.correlation_id},
          ${request.profile}, ${provider},
          ${result?.model ?? configuration?.modelId ?? null},
          ${request.promptVersion}, ${stableHash(requestMessages)},
          ${result ? stableHash(result.content) : null},
          ${failure ? "failed" : "succeeded"}, ${failure?.code ?? null},
          ${result?.latencyMs ?? null}, ${result?.inputTokens ?? null},
          ${result?.outputTokens ?? null}, ${sequenceRows[0].next_sequence},
          ${tx.json(requestMessages)},
          ${result ? tx.json({ content: result.content }) : null}, ${now}
        )
      `;
      const contextItems = [
        ...context.messages.map((message) => ({
          itemType: "message",
          referenceId: message.message_id,
          title: `${message.sender_display_name || message.sender_id} · ${message.sent_at}`,
          content: message.content,
          metadata: {
            senderId: message.sender_id,
            replyTo: message.reply_to,
          },
        })),
        ...context.existing_candidates.map((candidate) => ({
          itemType: "memory_candidate",
          referenceId: candidate.candidate_id,
          title: `候选记忆 · ${candidate.attribution_status}`,
          content: candidate.claim,
          metadata: {
            subjectId: candidate.subject_id,
            sourceSpeakerId: candidate.source_speaker_id,
            status: candidate.status,
          },
        })),
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
            ON CONFLICT (idempotency_key) DO NOTHING
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
    });
    return metrics;
  }

  async function processConversation(run, conversation) {
    const context = await loadContext(run, conversation);
    const request = cognitionRequest(run.job_type, context);
    const thoughtRunId = await ensureThoughtRun(run, conversation, context);
    let configuration;
    let result;
    let callRecorded = false;
    try {
      configuration = await loadProfile(request.profile);
      const provider = new OpenAiCompatibleProvider({
        fetchImpl,
        loadProfile: async () => configuration,
        timeoutMs: 60_000,
      });
      result = await provider.complete(request);
      await recordLlmCall({
        run,
        thoughtRunId,
        context,
        request,
        configuration,
        result,
      });
      callRecorded = true;
      const output = parseStructuredOutput(result.content);
      const persisted = await persistConversationResult({
        run,
        thoughtRunId,
        context,
        request,
        output,
        now: clock(),
      });
      return {
        messageCount: context.messages.length,
        llmCallCount: 1,
        ...persisted,
      };
    } catch (error) {
      if (!callRecorded) {
        await recordLlmCall({
          run,
          thoughtRunId,
          context,
          request,
          configuration,
          result,
          error,
        });
      }
      const failure = cognitionError(error);
      await sql`
        UPDATE thought_runs
        SET status = 'failed', processing_stage = 'failed',
            summary = ${failure.message}, completed_at = ${clock()}
        WHERE id = ${thoughtRunId}
      `;
      throw error;
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
