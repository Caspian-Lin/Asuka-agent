import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptApiKey,
  encryptApiKey,
  LlmConfigurationError,
  openAiCompatibleRequestPayload,
  OpenAiCompatibleProvider,
  openAiCompatibleDialect,
  parseEncryptionKey,
  validateLlmSettings,
} from "../src/runtime.mjs";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

test("API keys survive AES-GCM encryption without appearing in the envelope", () => {
  const encrypted = encryptApiKey("sk-secret-value", encryptionKey);
  assert.doesNotMatch(encrypted, /sk-secret-value/);
  assert.equal(decryptApiKey(encrypted, encryptionKey), "sk-secret-value");
  assert.throws(
    () => decryptApiKey(encrypted, Buffer.alloc(32, 8)),
    (error) => error instanceof LlmConfigurationError && error.code === "encrypted_key_invalid",
  );
});

test("encryption keys must contain exactly 32 bytes", () => {
  assert.equal(parseEncryptionKey(encryptionKey).length, 32);
  assert.throws(() => parseEncryptionKey("short"), /32 字节/);
});

test("settings validation rejects unsafe URLs and invalid context windows", () => {
  const valid = validateLlmSettings("primary", {
    displayName: "主模型",
    baseUrl: "http://127.0.0.1:11434/v1/",
    modelId: "model-primary",
    contextWindow: 32_768,
    enabled: true,
  });
  assert.equal(valid.baseUrl, "http://127.0.0.1:11434/v1");
  assert.throws(
    () => validateLlmSettings("fast", { ...valid, baseUrl: "file:///tmp/model" }),
    /http 或 https/,
  );
  assert.throws(
    () => validateLlmSettings("fast", { ...valid, contextWindow: 1 }),
    /1,024/,
  );
  assert.throws(
    () => validateLlmSettings("background", valid),
    /未知的模型配置档位/,
  );
});

test("provider routes by explicit profile and returns audit metadata", async () => {
  const calls = [];
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async (profile) => ({
      enabled: true,
      baseUrl: "https://models.example/v1",
      modelId: `${profile}-model`,
      apiKey: "never-log-this",
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        model: "fast-model-2026",
        choices: [{ message: { content: "OK" } }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const response = await provider.complete({
    profile: "fast",
    messages: [{ role: "user", content: "ping" }],
    maxOutputTokens: 1,
  });
  assert.equal(calls[0].url, "https://models.example/v1/chat/completions");
  assert.equal(JSON.parse(calls[0].init.body).model, "fast-model");
  assert.deepEqual(
    {
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cachedInputTokens: response.cachedInputTokens,
    },
    {
      model: "fast-model-2026",
      inputTokens: 4,
      outputTokens: 1,
      cachedInputTokens: 3,
    },
  );
  assert.deepEqual(response.requestPayload, JSON.parse(calls[0].init.body));
});

test("DashScope adds one distinct format contract per stateless structured request", async () => {
  const calls = [];
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async () => ({
      enabled: true,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelId: "qwen3.6-flash-2026-04-16",
      apiKey: "never-log-this",
    }),
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const messages = [
    { role: "system", content: "You are a deterministic action compiler." },
    { role: "user", content: "Return the requested result." },
  ];
  const request = {
    profile: "fast",
    messages,
    responseSchema: {
      type: "object",
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  };
  const result = await provider.complete(request);
  await provider.complete(request);
  assert.equal(openAiCompatibleDialect(
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
  ), "dashscope-chat");
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
  assert.equal(calls[0].enable_thinking, false);
  assert.equal(Object.hasOwn(calls[0].response_format, "json_schema"), false);
  assert.match(calls[0].messages[0].content, /JSON/);
  assert.match(calls[0].messages[0].content, /"additionalProperties":false/);
  assert.match(calls[0].messages[0].content, /"required":\["ok"\]/);
  assert.deepEqual(result.requestMessages, calls[0].messages);
  assert.deepEqual(result.requestPayload, calls[0]);
  assert.equal(calls[0].messages[1].content, "You are a deterministic action compiler.");
  assert.equal(calls[0].messages[2].content, "Return the requested result.");
  assert.equal(calls[0].messages.filter((message) => message.role === "system").length, 2);
  assert.equal(calls[1].messages.filter((message) => message.role === "system").length, 2);
  assert.deepEqual(messages, [
    { role: "system", content: "You are a deterministic action compiler." },
    { role: "user", content: "Return the requested result." },
  ]);
});

test("OpenAI structured requests preserve the projected message array", async () => {
  let requestBody;
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async () => ({
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      modelId: "test-model",
      apiKey: "test-key",
    }),
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const messages = [
    { role: "system", content: "stable" },
    { role: "user", content: "actual projected context" },
  ];
  const result = await provider.complete({
    profile: "fast",
    messages,
    responseSchema: {
      type: "object",
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
  });
  assert.deepEqual(requestBody.messages, messages);
  assert.deepEqual(result.requestMessages, messages);
  assert.deepEqual(result.requestPayload, requestBody);
});

test("provider HTTP errors retain a redacted actionable detail", async () => {
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async () => ({
      enabled: true,
      baseUrl: "https://models.example/v1",
      modelId: "model",
      apiKey: "never-log-this",
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "Unknown response_format for sk-secret-credential" },
    }), { status: 400, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    provider.complete({ profile: "fast", messages: [] }),
    (error) => error.code === "provider_http_400" &&
      error.message.includes("Unknown response_format") &&
      !error.message.includes("sk-secret-credential"),
  );
});

test("provider never falls back to another profile", async () => {
  const loaded = [];
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async (profile) => {
      loaded.push(profile);
      return null;
    },
  });
  await assert.rejects(
    provider.complete({ profile: "fast", messages: [] }),
    (error) => error.code === "profile_missing",
  );
  assert.deepEqual(loaded, ["fast"]);
});

test("provider reports exhausted output budgets separately from malformed responses", async () => {
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async () => ({
      enabled: true,
      baseUrl: "https://models.example/v1",
      modelId: "reasoning-model",
      apiKey: "never-log-this",
    }),
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{
        finish_reason: "length",
        message: { content: null, reasoning: "internal reasoning" },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });

  await assert.rejects(
    provider.complete({ profile: "primary", messages: [] }),
    (error) => error.code === "provider_output_exhausted",
  );
});

test("provider forwards native read-only tools and accepts a tool-only assistant turn", async () => {
  let requestBody;
  const provider = new OpenAiCompatibleProvider({
    loadProfile: async () => ({
      enabled: true,
      baseUrl: "https://models.example/v1",
      modelId: "tool-model",
      apiKey: "never-log-this",
    }),
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: {
                name: "search_conversation_messages",
                arguments: "{\"query\":\"露营\",\"limit\":5}",
              },
            }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const tools = [{
    type: "function",
    function: {
      name: "search_conversation_messages",
      parameters: { type: "object" },
    },
  }];
  const result = await provider.complete({
    profile: "primary",
    messages: [{ role: "user", content: "查一下" }],
    tools,
    toolChoice: "auto",
  });
  assert.deepEqual(requestBody.tools, tools);
  assert.equal(requestBody.tool_choice, "auto");
  assert.deepEqual(result.requestPayload, requestBody);
  assert.equal(result.content, "");
  assert.equal(result.toolCalls[0].function.name, "search_conversation_messages");
  assert.equal(result.finishReason, "tool_calls");
});

test("provider request payload is the exact secret-free JSON body", () => {
  const tools = [{
    type: "function",
    function: {
      name: "recall_memories",
      description: "Read reviewed memories",
      parameters: { type: "object", properties: {} },
    },
  }];
  const payload = openAiCompatibleRequestPayload({
    baseUrl: "https://models.example/v1",
    modelId: "primary-model",
    apiKey: "must-not-appear",
  }, {
    messages: [{ role: "user", content: "回忆一下" }],
    tools,
    toolChoice: "auto",
    maxOutputTokens: 4_096,
  });

  assert.deepEqual(payload, {
    model: "primary-model",
    messages: [{ role: "user", content: "回忆一下" }],
    tools,
    tool_choice: "auto",
    max_tokens: 4_096,
  });
  assert.doesNotMatch(JSON.stringify(payload), /must-not-appear/);
});

test("tool-free compression requests explicitly disable tool selection", () => {
  const payload = openAiCompatibleRequestPayload({
    baseUrl: "https://models.example/v1",
    modelId: "primary-model",
  }, {
    messages: [{ role: "user", content: "压缩" }],
    tools: [],
    toolChoice: "none",
    maxOutputTokens: 2_048,
  });
  assert.equal(Object.hasOwn(payload, "tools"), false);
  assert.equal(payload.tool_choice, "none");
});
