import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { databaseConfig, positiveInteger } from "@asuka-agent/config";
import { errorMessage } from "@asuka-agent/shared";
import postgres from "postgres";
import { createCognitionWorker } from "./cognition-worker.mjs";

const database = databaseConfig(process.env, "the inbound worker");
const sql = postgres(database.url, { ssl: database.ssl });
const batchSize = positiveInteger(process.env, "AGENT_INBOUND_BATCH_SIZE", 20);
const pollMs = positiveInteger(process.env, "AGENT_INBOUND_POLL_MS", 5_000);
const cognitionPollMs = positiveInteger(
  process.env,
  "AGENT_COGNITION_POLL_MS",
  10_000,
);
const cognitionLeaseMs = positiveInteger(
  process.env,
  "AGENT_COGNITION_LEASE_MS",
  90_000,
);
const watch = process.argv.includes("--watch");
let stopping = false;

const cognitionWorker = createCognitionWorker({
  sql,
  encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY,
  leaseOwner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
  leaseMs: cognitionLeaseMs,
});

function textFromSegments(segments) {
  if (!Array.isArray(segments)) return "";
  return segments
    .filter((segment) => segment?.type === "text")
    .map((segment) => String(segment.data?.text ?? ""))
    .join("")
    .trim();
}

function conversationTitle(externalId) {
  const value = String(externalId);
  if (value.startsWith("private:")) {
    return `QQ私聊 ${value.slice("private:".length)}`;
  }
  return `QQ群 ${value.replace(/^group:/, "")}`;
}

function senderDisplayName(delivery) {
  return String(
    delivery.raw_payload?.sender?.card ||
    delivery.raw_payload?.sender?.nickname ||
    delivery.sender_id,
  ).trim();
}

function replyToExternalMessageId(segments) {
  if (!Array.isArray(segments)) return null;
  const reply = segments.find((segment) => segment?.type === "reply");
  const id = reply?.data?.id;
  return id == null || String(id).trim() === "" ? null : String(id);
}

async function processBatch() {
  return sql.begin(async (tx) => {
    const deliveries = await tx`
      SELECT id, channel_id, external_conversation_id, external_message_id,
             sender_id, content, raw_payload, sent_at, received_at
      FROM inbound_deliveries
      WHERE status = 'received'
      ORDER BY received_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `;

    for (const delivery of deliveries) {
      const content = textFromSegments(delivery.content);
      if (!content) {
        await tx`
          UPDATE inbound_deliveries
          SET status = 'ignored', processed_at = now(), attempts = attempts + 1
          WHERE id = ${delivery.id}
        `;
        continue;
      }

      const conversationId = `napcat:${delivery.channel_id}:${delivery.external_conversation_id}`;
      const correlationId = `inbound:${delivery.id}`;
      const messageTime = delivery.sent_at ?? delivery.received_at;
      const displayName = senderDisplayName(delivery);
      const replyTo = replyToExternalMessageId(delivery.content);
      const eventPayload = {
        deliveryId: String(delivery.id),
        senderId: String(delivery.sender_id),
        channelId: String(delivery.channel_id),
      };
      await tx`
        INSERT INTO conversations (
          id, agent_id, channel, channel_id, external_id, title, status,
          created_at, updated_at
        ) VALUES (
          ${conversationId}, 'agent-asuka', 'napcat', ${delivery.channel_id},
          ${delivery.external_conversation_id},
          ${conversationTitle(delivery.external_conversation_id)},
          'active', ${messageTime}, ${messageTime}
        )
        ON CONFLICT (id) DO UPDATE SET
          channel_id = EXCLUDED.channel_id,
          title = EXCLUDED.title,
          updated_at = GREATEST(conversations.updated_at, EXCLUDED.updated_at)
      `;
      await tx`
        INSERT INTO messages (
          id, conversation_id, role, author_kind, direction, content,
          sender_id, sender_display_name, reply_to_external_message_id,
          external_message_id, external_receipt, citations_json,
          correlation_id, read_at, created_at
        ) VALUES (
          ${delivery.id}, ${conversationId}, 'user', 'user', 'inbound',
          ${content}, ${delivery.sender_id}, ${displayName}, ${replyTo},
          ${delivery.external_message_id}, ${tx.json({})}, '[]'::jsonb,
          ${correlationId}, NULL, ${messageTime}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO conversation_participants (
          conversation_id, participant_id, display_name, aliases,
          first_seen_at, last_seen_at
        ) VALUES (
          ${conversationId}, ${delivery.sender_id}, ${displayName},
          ${tx.json([displayName])}, ${messageTime}, ${messageTime}
        )
        ON CONFLICT (conversation_id, participant_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          aliases = (
            SELECT jsonb_agg(alias ORDER BY alias)
            FROM (
              SELECT DISTINCT jsonb_array_elements_text(
                conversation_participants.aliases || EXCLUDED.aliases
              ) AS alias
            ) merged_aliases
          ),
          first_seen_at = LEAST(
            conversation_participants.first_seen_at,
            EXCLUDED.first_seen_at
          ),
          last_seen_at = GREATEST(
            conversation_participants.last_seen_at,
            EXCLUDED.last_seen_at
          )
      `;
      await tx`
        INSERT INTO events (
          id, conversation_id, event_type, source_type, payload_json,
          correlation_id, created_at
        ) VALUES (
          ${`event:${delivery.id}`}, ${conversationId}, 'message_received', 'user',
          ${tx.json(eventPayload)},
          ${correlationId}, ${messageTime}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        UPDATE inbound_deliveries
        SET status = 'processed', attempts = attempts + 1, claimed_at = now(),
            processed_at = now(), last_error = NULL
        WHERE id = ${delivery.id}
      `;
    }
    return deliveries.length;
  });
}

async function recordRun(status, startedAt, count, error) {
  const completedAt = new Date();
  await sql.begin(async (tx) => {
    await tx`
      UPDATE jobs
      SET last_run_at = ${completedAt},
          next_run_at = ${watch ? new Date(Date.now() + pollMs) : null},
          updated_at = ${completedAt}
      WHERE id = 'job-inbound-projection'
    `;
    if (!watch || count > 0 || error) {
      const runId = randomUUID();
      await tx`
        INSERT INTO job_runs (
          id, job_id, status, trigger_type, idempotency_key, correlation_id,
          scheduled_for, available_at, attempt_count, max_attempts, started_at,
          completed_at, error_code, error_message, metrics, created_at
        ) VALUES (
          ${runId}, 'job-inbound-projection', ${status},
          ${watch ? "schedule" : "manual"}, ${randomUUID()},
          ${`job-run:${runId}`}, ${startedAt}, ${startedAt}, 1, 1,
          ${startedAt}, ${completedAt},
          ${error ? "INBOUND_PROCESSING_FAILED" : null},
          ${error ? errorMessage(error).slice(0, 1000) : null},
          ${sql.json({ deliveryCount: count })}, ${startedAt}
        )
      `;
    }
  });
}

async function executeBatch() {
  const startedAt = new Date();
  try {
    const count = await processBatch();
    await recordRun("succeeded", startedAt, count, null);
    console.log(`processed ${count} inbound ${count === 1 ? "delivery" : "deliveries"}`);
    return count;
  } catch (error) {
    try {
      await recordRun("failed", startedAt, 0, error);
    } catch (recordError) {
      console.error("failed to record inbound worker failure", recordError);
    }
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  if (watch) {
    console.log(`watching PostgreSQL inbox every ${pollMs}ms`);
    console.log(`watching cognition jobs every ${cognitionPollMs}ms`);
    const inboundLoop = async () => {
      while (!stopping) {
        try {
          await executeBatch();
        } catch (error) {
          console.error("inbound worker batch failed", error);
        }
        if (!stopping) await delay(pollMs);
      }
    };
    const cognitionLoop = async () => {
      while (!stopping) {
        try {
          await cognitionWorker.runCycle();
        } catch (error) {
          console.error("cognition scheduler cycle failed", {
            message: errorMessage(error),
          });
        }
        if (!stopping) await delay(cognitionPollMs);
      }
    };
    await Promise.all([inboundLoop(), cognitionLoop()]);
  } else {
    await executeBatch();
    await cognitionWorker.runCycle();
  }
} finally {
  await sql.end();
}
