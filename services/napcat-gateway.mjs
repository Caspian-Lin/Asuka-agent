import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  normalizeNapCatMessage,
  parseGroupWhitelist,
} from "../lib/napcat-ingress.mjs";

const required = ["DATABASE_URL", "NAPCAT_WS_URL"];
for (const key of required) {
  if (!process.env[key] || process.env[key].includes("CHANGE_ME")) {
    throw new Error(`Set ${key} in .env before starting the QQ gateway.`);
  }
}

const sql = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === "true" ? "require" : false,
});
const allowedGroups = parseGroupWhitelist(process.env.NAPCAT_GROUP_WHITELIST);
const allowedPrivateUsers = parseGroupWhitelist(
  process.env.NAPCAT_PRIVATE_USER_WHITELIST,
);
const reconnectMs = 5_000;
let currentSocket;
let currentAccountId = null;
let stopped = false;

if (allowedGroups.size === 0 && allowedPrivateUsers.size === 0) {
  console.warn("QQ whitelists are empty; no QQ messages will be stored.");
} else {
  console.log(
    `QQ whitelist loaded (${allowedGroups.size} group(s), ${allowedPrivateUsers.size} private user(s)).`,
  );
}

async function ensureChannel(accountId, seen = false) {
  const config = {
    groupWhitelist: [...allowedGroups],
    privateUserWhitelist: [...allowedPrivateUsers],
  };
  const [channel] = await sql`
    INSERT INTO channels (
      id, agent_id, provider, account_id, enabled, last_seen_at, config,
      created_at, updated_at
    ) VALUES (
      ${`napcat:${accountId}`}, 'agent-asuka', 'napcat', ${accountId}, true,
      ${seen ? new Date() : null}, ${sql.json(config)}, now(), now()
    )
    ON CONFLICT (provider, account_id) DO UPDATE SET
      agent_id = EXCLUDED.agent_id,
      enabled = true,
      last_seen_at = COALESCE(EXCLUDED.last_seen_at, channels.last_seen_at),
      config = EXCLUDED.config,
      updated_at = EXCLUDED.updated_at
    RETURNING id
  `;
  return channel.id;
}

async function saveEvent(event) {
  const inbound = normalizeNapCatMessage(
    event,
    allowedGroups,
    allowedPrivateUsers,
  );
  if (!inbound) return;

  const accountId = String(
    event.self_id || currentAccountId || process.env.NAPCAT_ACCOUNT_ID || "default",
  );
  const channelId = await ensureChannel(accountId, true);
  const raw = JSON.stringify(event);
  const rawHash = createHash("sha256").update(raw).digest("hex");
  const inserted = await sql`
    INSERT INTO inbound_deliveries (
      id, channel_id, external_conversation_id, external_message_id, sender_id,
      message_type, content, raw_payload, raw_hash, sent_at, received_at, status
    ) VALUES (
      ${randomUUID()}, ${channelId}, ${inbound.externalConversationId},
      ${inbound.externalMessageId}, ${inbound.senderId}, ${inbound.messageType},
      ${sql.json(inbound.content)}, ${sql.json(event)}, ${rawHash},
      ${inbound.sentAt}, now(), 'received'
    )
    ON CONFLICT (channel_id, external_message_id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length) {
    console.log(`stored ${inbound.messageType} message ${inbound.externalMessageId}`);
  }
}

function connect() {
  const url = new URL(process.env.NAPCAT_WS_URL);
  if (process.env.NAPCAT_ACCESS_TOKEN) {
    url.searchParams.set("access_token", process.env.NAPCAT_ACCESS_TOKEN);
  }

  let authenticated = false;
  const socket = new WebSocket(url);
  currentSocket = socket;

  socket.addEventListener("open", () => {
    console.log(`NapCat WebSocket opened at ${url.origin}; awaiting lifecycle event.`);
  });
  socket.addEventListener("message", async ({ data }) => {
    try {
      const event = JSON.parse(String(data));
      if (event?.retcode === 1403) {
        console.error("NapCat authentication failed; check NAPCAT_ACCESS_TOKEN.");
        return;
      }
      if (!authenticated) {
        authenticated = true;
        const accountId = String(
          event.self_id || process.env.NAPCAT_ACCOUNT_ID || "default",
        );
        currentAccountId = accountId;
        await ensureChannel(accountId, true);
        console.log(`NapCat authenticated for account ${accountId}.`);
      }
      await saveEvent(event);
    } catch (error) {
      console.error("failed to handle NapCat event", error);
    }
  });
  socket.addEventListener("close", ({ code, reason }) => {
    const detail = reason ? `: ${reason}` : "";
    console.warn(`NapCat connection closed (${code})${detail}.`);
    if (!stopped) {
      console.warn(`Retrying in ${reconnectMs}ms.`);
      setTimeout(connect, reconnectMs);
    }
  });
  socket.addEventListener("error", () => {
    console.error("NapCat WebSocket transport error.");
  });
}

const presenceTimer = setInterval(async () => {
  if (currentSocket?.readyState !== WebSocket.OPEN) return;
  const accountId = currentAccountId;
  if (!accountId) return;
  try {
    await ensureChannel(accountId, true);
  } catch (error) {
    console.error("failed to update channel presence", error);
  }
}, 30_000);

async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(presenceTimer);
  currentSocket?.close(1000, "gateway shutdown");
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

connect();
