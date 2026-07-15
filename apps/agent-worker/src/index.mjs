import { randomUUID } from "node:crypto";
import { databaseConfig, positiveInteger } from "@asuka-agent/config";
import { errorMessage } from "@asuka-agent/shared";
import postgres from "postgres";

const database = databaseConfig(process.env, "the inbound worker");
const sql = postgres(database.url, { ssl: database.ssl });
const batchSize = positiveInteger(process.env, "AGENT_INBOUND_BATCH_SIZE", 20);
const pollMs = positiveInteger(process.env, "AGENT_INBOUND_POLL_MS", 5_000);
const watch = process.argv.includes("--watch");
let stopping = false;

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

async function processBatch() {
  return sql.begin(async (tx) => {
    const deliveries = await tx`
      SELECT id, channel_id, external_conversation_id, sender_id, content,
             sent_at, received_at
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
          id, conversation_id, role, content, citations_json, correlation_id,
          read_at, created_at
        ) VALUES (
          ${delivery.id}, ${conversationId}, 'user', ${content}, '[]'::jsonb,
          ${correlationId}, NULL, ${messageTime}
        )
        ON CONFLICT (id) DO NOTHING
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
      await tx`
        INSERT INTO job_runs (
          id, job_id, status, trigger_type, idempotency_key, started_at,
          completed_at, error_code, error_message, metrics
        ) VALUES (
          ${randomUUID()}, 'job-inbound-projection', ${status},
          ${watch ? "schedule" : "manual"}, ${randomUUID()}, ${startedAt},
          ${completedAt}, ${error ? "INBOUND_PROCESSING_FAILED" : null},
          ${error ? errorMessage(error).slice(0, 1000) : null},
          ${sql.json({ deliveryCount: count })}
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
    while (!stopping) {
      try {
        await executeBatch();
      } catch (error) {
        console.error("inbound worker batch failed", error);
      }
      if (!stopping) await delay(pollMs);
    }
  } else {
    await executeBatch();
  }
} finally {
  await sql.end();
}
