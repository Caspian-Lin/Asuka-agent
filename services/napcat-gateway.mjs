import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

const required = ["DATABASE_URL", "NAPCAT_WS_URL"];
for (const key of required) {
  if (!process.env[key] || process.env[key].includes("CHANGE_ME")) {
    throw new Error(`Set ${key} in .env before starting the QQ gateway.`);
  }
}

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === "true" ? "require" : false,
});
const reconnectMs = 5_000;

function messageSegments(event) {
  if (Array.isArray(event.message)) return event.message;
  if (typeof event.raw_message === "string") {
    return [{ type: "text", data: { text: event.raw_message } }];
  }
  return [];
}

function normalize(event) {
  if (event.post_type !== "message") return null;
  if (event.message_type !== "private" && event.message_type !== "group") return null;

  const externalMessageId = String(event.message_id ?? "");
  const senderId = String(event.user_id ?? event.sender?.user_id ?? "");
  if (!externalMessageId || !senderId) return null;

  const conversationId =
    event.message_type === "group"
      ? `group:${String(event.group_id ?? "")}`
      : `private:${senderId}`;
  if (conversationId.endsWith(":")) return null;

  return {
    externalConversationId: conversationId,
    externalMessageId,
    senderId,
    messageType: event.message_type,
    content: messageSegments(event),
    sentAt: Number.isFinite(event.time)
      ? new Date(event.time * 1000).toISOString()
      : null,
  };
}

async function saveEvent(event) {
  const inbound = normalize(event);
  if (!inbound) return;
  const accountId = String(process.env.NAPCAT_ACCOUNT_ID || event.self_id || "default");
  const [channel] = await sql`
    INSERT INTO channels (id, agent_id, provider, account_id, enabled, config, created_at, updated_at)
    VALUES (${`napcat:${accountId}`}, 'agent-purr', 'napcat', ${accountId}, true, '{}'::jsonb, now(), now())
    ON CONFLICT (provider, account_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
    RETURNING id
  `;
  const raw = JSON.stringify(event);
  const rawHash = createHash("sha256").update(raw).digest("hex");
  const inserted = await sql`
    INSERT INTO inbound_deliveries (
      id, channel_id, external_conversation_id, external_message_id, sender_id,
      message_type, content, raw_payload, raw_hash, sent_at, received_at, status
    ) VALUES (
      ${randomUUID()}, ${channel.id}, ${inbound.externalConversationId}, ${inbound.externalMessageId}, ${inbound.senderId},
      ${inbound.messageType}, ${sql.json(inbound.content)}, ${sql.json(event)}, ${rawHash},
      ${inbound.sentAt}, now(), 'received'
    ) ON CONFLICT (channel_id, external_message_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) {
    console.log(`stored ${inbound.messageType} ${inbound.externalMessageId}`);
  }
}

function connect() {
  const url = new URL(process.env.NAPCAT_WS_URL);
  if (process.env.NAPCAT_ACCESS_TOKEN) {
    url.searchParams.set("access_token", process.env.NAPCAT_ACCESS_TOKEN);
  }
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => console.log(`connected to ${url.origin}`));
  socket.addEventListener("message", async ({ data }) => {
    try {
      await saveEvent(JSON.parse(String(data)));
    } catch (error) {
      console.error("failed to persist NapCat event", error);
    }
  });
  socket.addEventListener("close", () => {
    console.warn(`NapCat connection closed; retrying in ${reconnectMs}ms`);
    setTimeout(connect, reconnectMs);
  });
  socket.addEventListener("error", (error) => console.error("NapCat socket error", error));
}

process.on("SIGINT", async () => {
  await sql.end();
  process.exit(0);
});

connect();
