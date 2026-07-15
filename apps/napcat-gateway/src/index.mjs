import { createHash, randomUUID } from "node:crypto";
import { databaseConfig, napcatConfig, positiveInteger } from "@asuka-agent/config";
import {
  normalizeNapCatMessage,
  parseGroupWhitelist,
} from "@asuka-agent/im";
import {
  buildNapCatSendAction,
  parseNapCatActionResponse,
} from "@asuka-agent/im/napcat-outbound";
import postgres from "postgres";

const database = databaseConfig(process.env, "the QQ gateway");
const napcat = napcatConfig(process.env);
const sql = postgres(database.url, { ssl: database.ssl });
const allowedGroups = parseGroupWhitelist(napcat.groupWhitelist);
const allowedPrivateUsers = parseGroupWhitelist(
  napcat.privateUserWhitelist,
);
const reconnectMs = 5_000;
const outboundPollMs = positiveInteger(process.env, "NAPCAT_OUTBOUND_POLL_MS", 500);
const outboundResponseTimeoutMs = positiveInteger(
  process.env,
  "NAPCAT_OUTBOUND_RESPONSE_TIMEOUT_MS",
  30_000,
);
const gatewayOwner = `napcat-gateway:${randomUUID()}`;
let currentSocket;
let currentAccountId = null;
let stopped = false;
let outboundBusy = false;

function outboundTargetAllowlisted(externalConversationId) {
  const value = String(externalConversationId ?? "");
  if (value.startsWith("group:")) return allowedGroups.has(value.slice("group:".length));
  if (value.startsWith("private:")) {
    return allowedPrivateUsers.has(value.slice("private:".length));
  }
  return false;
}

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
    event.self_id || currentAccountId || napcat.accountId || "default",
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

async function claimOutbound(channelId) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + outboundResponseTimeoutMs);
  return sql.begin(async (tx) => {
    const rows = await tx`
      SELECT delivery.id, delivery.echo, delivery.external_conversation_id,
             delivery.attempt_count, delivery.max_attempts,
             message.content, message.correlation_id
      FROM outbound_deliveries AS delivery
      JOIN messages AS message ON message.id = delivery.message_id
      JOIN speech_decisions AS decision ON decision.id = delivery.speech_decision_id
      JOIN outbound_policies AS policy ON policy.agent_id = decision.agent_id
      JOIN agents AS agent ON agent.id = decision.agent_id
      JOIN channels AS channel ON channel.id = delivery.channel_id
      WHERE delivery.channel_id = ${channelId}
        AND policy.enabled = true AND agent.mode = 'active' AND channel.enabled = true
        AND decision.created_at >= policy.updated_at
        AND decision.created_at >= (
          ${now} - policy.freshness_seconds * interval '1 second'
        )
        AND delivery.status IN ('queued', 'retry_wait')
        AND delivery.available_at <= ${now}
        AND (delivery.lease_expires_at IS NULL OR delivery.lease_expires_at <= ${now})
      ORDER BY delivery.created_at
      FOR UPDATE OF delivery SKIP LOCKED
      LIMIT 1
    `;
    const delivery = rows[0];
    if (!delivery) return null;
    const updated = await tx`
      UPDATE outbound_deliveries
      SET status = 'sending', attempt_count = attempt_count + 1,
          lease_owner = ${gatewayOwner}, lease_expires_at = ${leaseExpiresAt},
          updated_at = ${now}
      WHERE id = ${delivery.id}
        AND status IN ('queued', 'retry_wait')
      RETURNING id
    `;
    return updated.length ? delivery : null;
  });
}

async function retryOrFailBeforeSend(delivery, error) {
  const now = new Date();
  const nextAttempt = Number(delivery.attempt_count) + 1;
  const code = String(error?.code ?? "transport_send_failed");
  const retry = !code.startsWith("outbound_") &&
    nextAttempt < Number(delivery.max_attempts);
  const message = String(error?.message ?? error).slice(0, 500);
  await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE outbound_deliveries
      SET status = ${retry ? "retry_wait" : "failed"},
          available_at = ${retry ? new Date(now.getTime() + 5_000) : now},
          lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = ${code},
          last_error_message = ${message}, updated_at = ${now}
      WHERE id = ${delivery.id} AND status = 'sending'
      RETURNING message_id, speech_decision_id, conversation_id
    `;
    if (retry || !rows[0]) return;
    const failed = rows[0];
    const messages = await tx`
      UPDATE messages
      SET external_receipt = ${tx.json({
        status: "failed",
        outboundDeliveryId: delivery.id,
      })}
      WHERE id = ${failed.message_id}
      RETURNING correlation_id
    `;
    await tx`
      UPDATE action_proposals AS proposal
      SET status = 'failed', updated_at = ${now}
      FROM speech_decisions AS decision
      WHERE decision.id = ${failed.speech_decision_id}
        AND proposal.id = decision.proposal_id
    `;
    await tx`
      INSERT INTO events (
        id, conversation_id, event_type, source_type, payload_json,
        correlation_id, created_at
      ) VALUES (
        ${`event:outbound-before-send-failed:${delivery.id}`},
        ${failed.conversation_id}, 'outbound_message_failed', 'napcat',
        ${tx.json({ deliveryId: delivery.id, code })},
        ${messages[0]?.correlation_id ?? delivery.id}, ${now}
      ) ON CONFLICT (id) DO NOTHING
    `;
  });
}

async function handleOutboundResponse(response) {
  const now = new Date();
  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT delivery.id, delivery.message_id, delivery.speech_decision_id,
             delivery.conversation_id, delivery.status, message.correlation_id
      FROM outbound_deliveries AS delivery
      JOIN messages AS message ON message.id = delivery.message_id
      WHERE delivery.echo = ${response.echo}
      FOR UPDATE OF delivery
      LIMIT 1
    `;
    const delivery = rows[0];
    if (!delivery || ![
      "sending",
      "awaiting_response",
      "failed_uncertain",
    ].includes(delivery.status)) return;
    const status = response.ok ? "sent" : "failed";
    await tx`
      UPDATE outbound_deliveries
      SET status = ${status}, external_message_id = ${response.externalMessageId},
          response_json = ${tx.json(response.raw)},
          last_error_code = ${response.ok ? null : `napcat_${response.retcode ?? "unknown"}`},
          last_error_message = ${response.errorMessage}, sent_at = ${response.ok ? now : null},
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ${now}
      WHERE id = ${delivery.id}
    `;
    await tx`
      UPDATE messages
      SET external_message_id = ${response.externalMessageId},
          external_receipt = ${tx.json({
            status,
            outboundDeliveryId: delivery.id,
            retcode: response.retcode,
          })}
      WHERE id = ${delivery.message_id}
    `;
    await tx`
      UPDATE action_proposals AS proposal
      SET status = ${response.ok ? "executed" : "failed"}, updated_at = ${now}
      FROM speech_decisions AS decision
      WHERE decision.id = ${delivery.speech_decision_id}
        AND proposal.id = decision.proposal_id
    `;
    await tx`
      INSERT INTO events (
        id, conversation_id, event_type, source_type, payload_json,
        correlation_id, created_at
      ) VALUES (
        ${`event:outbound-response:${delivery.id}`}, ${delivery.conversation_id},
        ${response.ok ? "outbound_message_sent" : "outbound_message_failed"},
        'napcat', ${tx.json({
          deliveryId: delivery.id,
          speechDecisionId: delivery.speech_decision_id,
          externalMessageId: response.externalMessageId,
          retcode: response.retcode,
        })}, ${delivery.correlation_id}, ${now}
      ) ON CONFLICT (id) DO NOTHING
    `;
    console.log(
      response.ok
        ? `sent QQ message ${response.externalMessageId ?? delivery.id}`
        : `NapCat rejected outbound ${delivery.id} (${response.retcode ?? "unknown"})`,
    );
  });
}

async function expireUncertainOutbound() {
  const now = new Date();
  await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE outbound_deliveries
      SET status = 'failed_uncertain', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = 'response_timeout',
          last_error_message = 'NapCat 响应超时；为避免重复发送，不会自动重试',
          updated_at = ${now}
      WHERE status IN ('sending', 'awaiting_response') AND lease_expires_at <= ${now}
      RETURNING id, message_id, speech_decision_id, conversation_id
    `;
    for (const delivery of rows) {
      const messages = await tx`
        UPDATE messages
        SET external_receipt = ${tx.json({
          status: "failed_uncertain",
          outboundDeliveryId: delivery.id,
        })}
        WHERE id = ${delivery.message_id}
        RETURNING correlation_id
      `;
      await tx`
        UPDATE action_proposals AS proposal
        SET status = 'failed', updated_at = ${now}
        FROM speech_decisions AS decision
        WHERE decision.id = ${delivery.speech_decision_id}
          AND proposal.id = decision.proposal_id
      `;
      await tx`
        INSERT INTO events (
          id, conversation_id, event_type, source_type, payload_json,
          correlation_id, created_at
        ) VALUES (
          ${`event:outbound-uncertain:${delivery.id}`}, ${delivery.conversation_id},
          'outbound_message_uncertain', 'napcat',
          ${tx.json({ deliveryId: delivery.id })},
          ${messages[0]?.correlation_id ?? delivery.id}, ${now}
        ) ON CONFLICT (id) DO NOTHING
      `;
    }
  });
}

async function flushOutbound() {
  if (outboundBusy || currentSocket?.readyState !== WebSocket.OPEN || !currentAccountId) return;
  outboundBusy = true;
  try {
    await expireUncertainOutbound();
    const channelId = await ensureChannel(currentAccountId, true);
    const delivery = await claimOutbound(channelId);
    if (!delivery) return;
    try {
      if (!outboundTargetAllowlisted(delivery.external_conversation_id)) {
        const error = new Error("目标会话已不在当前 QQ 白名单中");
        error.code = "outbound_target_not_allowlisted";
        throw error;
      }
      const action = buildNapCatSendAction({
        externalConversationId: delivery.external_conversation_id,
        message: delivery.content,
        echo: delivery.echo,
      });
      currentSocket.send(JSON.stringify(action));
      await sql`
        UPDATE outbound_deliveries
        SET status = 'awaiting_response', updated_at = now()
        WHERE id = ${delivery.id} AND status = 'sending'
      `;
    } catch (error) {
      await retryOrFailBeforeSend(delivery, error);
      console.error(`failed to send outbound ${delivery.id}`, error);
    }
  } finally {
    outboundBusy = false;
  }
}

function connect() {
  const url = new URL(napcat.wsUrl);
  if (napcat.accessToken) {
    url.searchParams.set("access_token", napcat.accessToken);
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
      const outboundResponse = parseNapCatActionResponse(event);
      if (outboundResponse) {
        await handleOutboundResponse(outboundResponse);
        return;
      }
      if (event?.retcode === 1403) {
        console.error("NapCat authentication failed; check NAPCAT_ACCESS_TOKEN.");
        return;
      }
      if (!authenticated) {
        authenticated = true;
        const accountId = String(
          event.self_id || napcat.accountId || "default",
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

const outboundTimer = setInterval(() => {
  void flushOutbound().catch((error) => {
    console.error("outbound delivery cycle failed", error);
  });
}, outboundPollMs);
outboundTimer.unref();

async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(presenceTimer);
  clearInterval(outboundTimer);
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
