import assert from "node:assert/strict";
import test from "node:test";

import { createLlmSettingsService } from "../src/llm-settings-service.mjs";

const encryptionKey = Buffer.alloc(32, 4).toString("base64");

function createRepository() {
  const rows = new Map();
  return {
    async list() {
      return [...rows.values()];
    },
    async get(_agentId, profile) {
      return rows.get(profile) ?? null;
    },
    async upsert(agentId, input) {
      const row = {
        agent_id: agentId,
        profile: input.profile,
        display_name: input.displayName,
        base_url: input.baseUrl,
        model_id: input.modelId,
        encrypted_api_key: input.encryptedApiKey,
        context_window: input.contextWindow,
        enabled: input.enabled,
        last_test_status: null,
        last_test_latency_ms: null,
        last_test_error_code: null,
        last_tested_at: null,
        updated_at: new Date().toISOString(),
      };
      rows.set(input.profile, row);
      return row;
    },
    async clearApiKey(_agentId, profile) {
      const row = rows.get(profile);
      Object.assign(row, { encrypted_api_key: null, enabled: false });
      return row;
    },
    async recordTest(_agentId, profile, result) {
      Object.assign(rows.get(profile), {
        last_test_status: result.status,
        last_test_latency_ms: result.latencyMs,
        last_test_error_code: result.errorCode,
        last_tested_at: new Date().toISOString(),
      });
    },
    rows,
  };
}

const validInput = {
  displayName: "主模型",
  baseUrl: "https://models.example/v1",
  modelId: "asuka-primary",
  contextWindow: 128_000,
  enabled: true,
  apiKey: "sk-browser-secret",
};

test("profile API responses expose only key status and preserve an empty key update", async () => {
  const repository = createRepository();
  const service = createLlmSettingsService({ repository, encryptionKey });
  const saved = await service.saveProfile("primary", validInput);
  assert.equal(saved.keyConfigured, true);
  assert.equal(saved.keyMask, "••••••••");
  assert.equal(JSON.stringify(saved).includes("sk-browser-secret"), false);
  assert.equal(JSON.stringify(await service.listProfiles()).includes("sk-browser-secret"), false);

  await service.saveProfile("primary", { ...validInput, apiKey: "" });
  assert.equal(repository.rows.get("primary").encrypted_api_key.includes("sk-browser-secret"), false);
});

test("enabled profiles require a key and deletion is a separate confirmed action", async () => {
  const repository = createRepository();
  const service = createLlmSettingsService({ repository, encryptionKey });
  await assert.rejects(
    service.saveProfile("fast", { ...validInput, apiKey: undefined }),
    /API Key/,
  );
  await service.saveProfile("fast", { ...validInput, displayName: "快速模型" });
  await assert.rejects(service.deleteApiKey("fast", "yes"), /明确确认/);
  const deleted = await service.deleteApiKey("fast", "DELETE");
  assert.equal(deleted.keyConfigured, false);
  assert.equal(deleted.keyMask, null);
  assert.equal(deleted.enabled, false);
});

test("connection tests return audit metadata without response content", async () => {
  const repository = createRepository();
  let requestBody;
  const service = createLlmSettingsService({
    repository,
    encryptionKey,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        model: "asuka-primary-2026",
        choices: [{ message: { content: "OK secret response" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await service.saveProfile("primary", validInput);
  const result = await service.testProfile("primary");
  assert.equal(result.status, "success");
  assert.equal(result.model, "asuka-primary-2026");
  assert.equal(requestBody.max_tokens, 64);
  assert.equal(Object.hasOwn(result, "content"), false);
  assert.equal(repository.rows.get("primary").last_test_status, "success");
});

test("failed connection tests persist only an actionable error code", async () => {
  const repository = createRepository();
  const service = createLlmSettingsService({
    repository,
    encryptionKey,
    fetchImpl: async () => new Response(
      JSON.stringify({ error: "provider echoed sk-browser-secret" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    ),
  });
  await service.saveProfile("primary", validInput);
  await assert.rejects(service.testProfile("primary"), /拒绝了 API Key/);
  const row = repository.rows.get("primary");
  assert.equal(row.last_test_status, "failed");
  assert.equal(row.last_test_error_code, "provider_http_401");
  assert.equal(JSON.stringify(await service.listProfiles()).includes("sk-browser-secret"), false);
});
