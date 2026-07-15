import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export const LLM_PROFILES = Object.freeze(["primary", "fast"]);

export const LLM_PROFILE_DEFAULTS = Object.freeze({
  primary: Object.freeze({
    displayName: "主模型",
    contextWindow: 128_000,
  }),
  fast: Object.freeze({
    displayName: "快速小模型",
    contextWindow: 32_000,
  }),
});

export class LlmConfigurationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "LlmConfigurationError";
    this.code = code;
    this.status = status;
  }
}

export function assertLlmProfile(profile) {
  if (!LLM_PROFILES.includes(profile)) {
    throw new LlmConfigurationError("invalid_profile", "未知的模型配置档位");
  }
  return profile;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new LlmConfigurationError("invalid_settings", `${label}不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new LlmConfigurationError("invalid_settings", `${label}过长`);
  }
  return normalized;
}

export function normalizeBaseUrl(value) {
  const raw = requiredText(value, "Base URL", 2_048);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LlmConfigurationError("invalid_base_url", "Base URL 不是有效网址");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new LlmConfigurationError("invalid_base_url", "Base URL 仅支持 http 或 https");
  }
  if (parsed.username || parsed.password) {
    throw new LlmConfigurationError("invalid_base_url", "Base URL 不得包含用户名或密码");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateLlmSettings(profile, input) {
  assertLlmProfile(profile);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LlmConfigurationError("invalid_settings", "模型配置格式无效");
  }
  const contextWindow = Number(input.contextWindow);
  if (!Number.isSafeInteger(contextWindow) || contextWindow < 1_024 || contextWindow > 2_000_000) {
    throw new LlmConfigurationError(
      "invalid_context_window",
      "上下文长度必须是 1,024 到 2,000,000 之间的整数",
    );
  }
  if (typeof input.enabled !== "boolean") {
    throw new LlmConfigurationError("invalid_settings", "启用状态必须是布尔值");
  }
  let apiKey;
  if (Object.hasOwn(input, "apiKey")) {
    if (typeof input.apiKey !== "string" || input.apiKey.length > 8_192) {
      throw new LlmConfigurationError("invalid_api_key", "API Key 格式无效");
    }
    apiKey = input.apiKey.trim() || undefined;
  }
  return {
    profile,
    displayName: requiredText(input.displayName, "显示名称", 80),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    modelId: requiredText(input.modelId, "模型 ID", 200),
    contextWindow,
    enabled: input.enabled,
    ...(apiKey ? { apiKey } : {}),
  };
}

export function parseEncryptionKey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new LlmConfigurationError(
      "encryption_key_missing",
      "服务端尚未配置 SETTINGS_ENCRYPTION_KEY",
      503,
    );
  }
  const raw = value.trim();
  const key = /^[a-f\d]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new LlmConfigurationError(
      "encryption_key_invalid",
      "SETTINGS_ENCRYPTION_KEY 必须是 32 字节的 Base64 或 64 位十六进制值",
      503,
    );
  }
  return key;
}

export function encryptApiKey(apiKey, encryptionKey) {
  const key = Buffer.isBuffer(encryptionKey)
    ? encryptionKey
    : parseEncryptionKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(requiredText(apiKey, "API Key", 8_192), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptApiKey(envelope, encryptionKey) {
  const key = Buffer.isBuffer(encryptionKey)
    ? encryptionKey
    : parseEncryptionKey(encryptionKey);
  const [version, iv, tag, ciphertext, extra] = String(envelope ?? "").split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || extra) {
    throw new LlmConfigurationError("encrypted_key_invalid", "已保存的 API Key 无法解密", 500);
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new LlmConfigurationError("encrypted_key_invalid", "已保存的 API Key 无法解密", 500);
  }
}

export function openAiCompatibleDialect(baseUrl) {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "openai";
  }
  return (/^dashscope(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(hostname) ||
      hostname.endsWith(".maas.aliyuncs.com"))
    ? "dashscope-chat"
    : "openai";
}

function structuredOutputParameters(baseUrl, responseSchema) {
  if (!responseSchema) return {};
  if (openAiCompatibleDialect(baseUrl) === "dashscope-chat") {
    // DashScope Chat Completions accepts JSON Object mode rather than
    // OpenAI's json_schema mode. Qwen 3.6 enables thinking by default, while
    // DashScope rejects JSON mode when thinking is enabled.
    return {
      response_format: { type: "json_object" },
      enable_thinking: false,
    };
  }
  return {
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "asuka_response",
        strict: true,
        schema: responseSchema,
      },
    },
  };
}

function structuredOutputMessages(baseUrl, responseSchema, messages) {
  if (!responseSchema || openAiCompatibleDialect(baseUrl) !== "dashscope-chat") {
    return messages;
  }
  // DashScope's json_object mode guarantees JSON syntax, but it does not accept
  // OpenAI's json_schema payload or enforce the requested fields. Put the exact
  // schema in the prompt so Qwen does not have to infer the business contract.
  return [
    {
      role: "system",
      content: [
        "Return only one valid JSON object.",
        "It must match this JSON Schema exactly; include every required field, use only allowed enum values, and do not add fields:",
        JSON.stringify(responseSchema),
      ].join("\n"),
    },
    ...messages,
  ];
}

function redactProviderDetail(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 300) : null;
}

function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.map((toolCall, index) => {
    const id = typeof toolCall?.id === "string" && toolCall.id
      ? toolCall.id
      : `tool-call-${index + 1}`;
    const name = toolCall?.function?.name;
    const argumentsText = toolCall?.function?.arguments;
    if (typeof name !== "string" || !name || typeof argumentsText !== "string") {
      throw new LlmConfigurationError(
        "provider_invalid_tool_call",
        "模型服务返回了无效工具调用",
        502,
      );
    }
    return {
      id,
      type: "function",
      function: { name, arguments: argumentsText },
    };
  });
}

async function providerErrorDetail(response) {
  try {
    const payload = await response.json();
    return redactProviderDetail(
      payload?.error?.message ?? payload?.message ?? payload?.error_description,
    );
  } catch {
    return null;
  }
}

export class OpenAiCompatibleProvider {
  constructor({ loadProfile, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
    this.loadProfile = loadProfile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async complete(request) {
    const profile = assertLlmProfile(request?.profile);
    const configuration = await this.loadProfile(profile);
    if (!configuration) {
      throw new LlmConfigurationError("profile_missing", `${profile} 模型尚未配置`, 503);
    }
    if (!configuration.enabled) {
      throw new LlmConfigurationError("profile_disabled", `${profile} 模型尚未启用`, 503);
    }
    if (!configuration.apiKey) {
      throw new LlmConfigurationError("api_key_missing", `${profile} 模型缺少 API Key`, 503);
    }
    const requestMessages = structuredOutputMessages(
      configuration.baseUrl,
      request.responseSchema,
      request.messages,
    );
    const startedAt = performance.now();
    let response;
    try {
      response = await this.fetchImpl(
        `${configuration.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuration.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: configuration.modelId,
            messages: requestMessages,
            ...(Array.isArray(request.tools) && request.tools.length
              ? { tools: request.tools }
              : {}),
            ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
            ...(request.maxOutputTokens
              ? { max_tokens: request.maxOutputTokens }
              : {}),
            ...structuredOutputParameters(
              configuration.baseUrl,
              request.responseSchema,
            ),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      const code = error?.name === "TimeoutError" ? "provider_timeout" : "provider_unreachable";
      throw new LlmConfigurationError(
        code,
        code === "provider_timeout" ? "模型服务连接超时" : "无法连接模型服务",
        502,
      );
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    if (!response.ok) {
      const detail = await providerErrorDetail(response);
      throw new LlmConfigurationError(
        `provider_http_${response.status}`,
        response.status === 401 || response.status === 403
          ? "模型服务拒绝了 API Key"
          : `模型服务返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`,
        502,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new LlmConfigurationError("provider_invalid_response", "模型服务返回了无效 JSON", 502);
    }
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);
    if ((typeof content !== "string" || !content.trim()) && toolCalls.length === 0) {
      if (choice?.finish_reason === "length") {
        throw new LlmConfigurationError(
          "provider_output_exhausted",
          "模型服务在生成文本前耗尽了输出预算",
          502,
        );
      }
      throw new LlmConfigurationError("provider_invalid_response", "模型服务响应缺少文本内容", 502);
    }
    return {
      content: typeof content === "string" ? content : "",
      toolCalls,
      finishReason: typeof choice?.finish_reason === "string"
        ? choice.finish_reason
        : undefined,
      model: typeof payload.model === "string" ? payload.model : configuration.modelId,
      inputTokens: Number.isFinite(payload?.usage?.prompt_tokens)
        ? payload.usage.prompt_tokens
        : undefined,
      outputTokens: Number.isFinite(payload?.usage?.completion_tokens)
        ? payload.usage.completion_tokens
        : undefined,
      latencyMs,
      requestMessages,
    };
  }
}
