import http from "node:http";
import { databaseConfig, positiveInteger } from "@asuka-agent/config";
import { LlmConfigurationError } from "@asuka-agent/llm/runtime";
import postgres from "postgres";
import { createLlmSettingsService } from "./llm-settings-service.mjs";

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
               WHERE m.role = 'user' AND m.read_at IS NULL
             )::int AS unread_count,
             max(m.created_at) AS last_message_at
      FROM conversations c
      LEFT JOIN messages m ON m.conversation_id = c.id
      WHERE c.agent_id = 'agent-asuka' AND c.channel = 'napcat'
      GROUP BY c.id
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
          SELECT m.id, m.conversation_id, m.role, m.content, m.read_at,
                 m.created_at, d.sender_id,
                 COALESCE(
                   NULLIF(d.raw_payload -> 'sender' ->> 'card', ''),
                   NULLIF(d.raw_payload -> 'sender' ->> 'nickname', ''),
                   d.sender_id,
                   CASE WHEN m.role = 'assistant' THEN 'Asuka Agent' ELSE '未知成员' END
                 ) AS sender_name
          FROM messages m
          LEFT JOIN inbound_deliveries d ON d.id = m.id
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

async function getJobs() {
  return sql`
    SELECT j.id, j.job_type, j.name, j.description, j.schedule_type,
           j.schedule_expression, j.timezone, j.configurable, j.enabled,
           j.status, j.config, j.last_run_at, j.next_run_at, j.updated_at,
           latest.status AS latest_run_status,
           latest.started_at AS latest_run_started_at,
           latest.completed_at AS latest_run_completed_at,
           latest.error_code AS latest_run_error_code,
           latest.metrics AS latest_run_metrics
    FROM jobs j
    LEFT JOIN LATERAL (
      SELECT status, started_at, completed_at, error_code, metrics
      FROM job_runs
      WHERE job_id = j.id
      ORDER BY started_at DESC
      LIMIT 1
    ) latest ON true
    WHERE j.agent_id = 'agent-asuka'
    ORDER BY CASE j.status WHEN 'active' THEN 0 ELSE 1 END, j.name
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
      sendJson(response, 200, { jobs: await getJobs() }, origin);
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
    const expected = error instanceof LlmConfigurationError || error instanceof RequestError;
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
