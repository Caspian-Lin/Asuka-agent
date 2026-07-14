import postgres from "postgres";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("CHANGE_ME")) {
  throw new Error("Set a real DATABASE_URL in .env before starting the inbound worker.");
}

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === "true" ? "require" : false,
});
const batchSize = Number(process.env.AGENT_INBOUND_BATCH_SIZE ?? 20);

function textFromSegments(segments) {
  if (!Array.isArray(segments)) return "";
  return segments
    .filter((segment) => segment?.type === "text")
    .map((segment) => String(segment.data?.text ?? ""))
    .join("")
    .trim();
}

async function processBatch() {
  return sql.begin(async (tx) => {
    const deliveries = await tx`
      SELECT id, channel_id, external_conversation_id, sender_id, content
      FROM inbound_deliveries
      WHERE status = 'received'
      ORDER BY received_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `;
    for (const delivery of deliveries) {
      const content = textFromSegments(delivery.content);
      if (!content) {
        await tx`UPDATE inbound_deliveries SET status = 'ignored', processed_at = now() WHERE id = ${delivery.id}`;
        continue;
      }
      const conversationId = `napcat:${delivery.channel_id}:${delivery.external_conversation_id}`;
      const correlationId = `inbound:${delivery.id}`;
      await tx`
        INSERT INTO conversations (id, agent_id, channel, external_id, title, status, created_at, updated_at)
        VALUES (${conversationId}, 'agent-purr', 'napcat', ${delivery.external_conversation_id}, ${delivery.external_conversation_id}, 'active', now(), now())
        ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at
      `;
      await tx`
        INSERT INTO messages (id, conversation_id, role, content, citations_json, correlation_id, created_at)
        VALUES (${delivery.id}, ${conversationId}, 'user', ${content}, '[]'::jsonb, ${correlationId}, now())
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO events (id, conversation_id, event_type, source_type, payload_json, correlation_id, created_at)
        VALUES (
          ${`event:${delivery.id}`}, ${conversationId}, 'message_received', 'user',
          jsonb_build_object('deliveryId', ${delivery.id}, 'senderId', ${delivery.sender_id}), ${correlationId}, now()
        ) ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        UPDATE inbound_deliveries
        SET status = 'processed', attempts = attempts + 1, claimed_at = now(), processed_at = now(), last_error = NULL
        WHERE id = ${delivery.id}
      `;
    }
    return deliveries.length;
  });
}

try {
  const count = await processBatch();
  console.log(`processed ${count} inbound ${count === 1 ? "delivery" : "deliveries"}`);
} finally {
  await sql.end();
}
