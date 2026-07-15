import {
  assertLlmProfile,
  decryptApiKey,
  encryptApiKey,
  LLM_PROFILE_DEFAULTS,
  LLM_PROFILES,
  LlmConfigurationError,
  OpenAiCompatibleProvider,
  parseEncryptionKey,
  validateLlmSettings,
} from "@asuka-agent/llm/runtime";

function availability(row) {
  if (!row) return "missing_configuration";
  if (!row.enabled) return "disabled";
  if (!row.encrypted_api_key && !row.key_configured) return "missing_key";
  if (row.last_test_status === "success") return "healthy";
  if (row.last_test_status === "failed") return "error";
  return "ready_untested";
}

function publicProfile(profile, row) {
  const defaults = LLM_PROFILE_DEFAULTS[profile];
  const keyConfigured = Boolean(row?.encrypted_api_key ?? row?.key_configured);
  return {
    profile,
    displayName: row?.display_name ?? defaults.displayName,
    baseUrl: row?.base_url ?? "",
    modelId: row?.model_id ?? "",
    contextWindow: row?.context_window ?? defaults.contextWindow,
    enabled: row?.enabled ?? false,
    keyConfigured,
    keyMask: keyConfigured ? "••••••••" : null,
    availability: availability(row),
    lastTest: row?.last_tested_at
      ? {
          status: row.last_test_status,
          latencyMs: row.last_test_latency_ms,
          errorCode: row.last_test_error_code,
          testedAt: row.last_tested_at,
        }
      : null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function createLlmSettingsService({
  repository,
  encryptionKey,
  fetchImpl = globalThis.fetch,
  agentId = "agent-asuka",
}) {
  async function listProfiles() {
    const rows = await repository.list(agentId);
    const byProfile = new Map(rows.map((row) => [row.profile, row]));
    return {
      profiles: LLM_PROFILES.map((profile) => publicProfile(profile, byProfile.get(profile))),
      fallback: {
        strategy: "none",
        message: "模型不可用时不会自动切换档位；调用方必须明确停止、排队或改用另一档。",
      },
    };
  }

  async function saveProfile(profile, input) {
    assertLlmProfile(profile);
    const normalized = validateLlmSettings(profile, input);
    const existing = await repository.get(agentId, profile);
    const encryptedApiKey = normalized.apiKey
      ? encryptApiKey(normalized.apiKey, parseEncryptionKey(encryptionKey))
      : existing?.encrypted_api_key ?? null;
    if (normalized.enabled && !encryptedApiKey) {
      throw new LlmConfigurationError(
        "api_key_missing",
        "启用模型前需要先填写 API Key",
      );
    }
    const row = await repository.upsert(agentId, {
      ...normalized,
      encryptedApiKey,
    });
    return publicProfile(profile, row);
  }

  async function deleteApiKey(profile, confirmation) {
    assertLlmProfile(profile);
    if (confirmation !== "DELETE") {
      throw new LlmConfigurationError(
        "confirmation_required",
        "删除 API Key 需要明确确认",
      );
    }
    const existing = await repository.get(agentId, profile);
    if (!existing) {
      throw new LlmConfigurationError("profile_missing", "模型配置不存在", 404);
    }
    const row = await repository.clearApiKey(agentId, profile);
    return publicProfile(profile, row);
  }

  async function testProfile(profile) {
    assertLlmProfile(profile);
    const row = await repository.get(agentId, profile);
    if (!row) {
      throw new LlmConfigurationError("profile_missing", "请先保存模型配置", 404);
    }
    if (!row.encrypted_api_key) {
      throw new LlmConfigurationError("api_key_missing", "请先配置 API Key");
    }
    let apiKey;
    try {
      apiKey = decryptApiKey(row.encrypted_api_key, parseEncryptionKey(encryptionKey));
      const provider = new OpenAiCompatibleProvider({
        fetchImpl,
        loadProfile: async () => ({
          enabled: true,
          baseUrl: row.base_url,
          modelId: row.model_id,
          apiKey,
        }),
      });
      const result = await provider.complete({
        profile,
        messages: [{ role: "user", content: "Respond with OK." }],
        // A two-token cap can be consumed before reasoning models emit their
        // final answer, producing a valid response with null text.
        maxOutputTokens: 64,
      });
      await repository.recordTest(agentId, profile, {
        status: "success",
        latencyMs: result.latencyMs,
        errorCode: null,
      });
      return {
        profile,
        status: "success",
        latencyMs: result.latencyMs,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
    } catch (error) {
      const safeError = error instanceof LlmConfigurationError
        ? error
        : new LlmConfigurationError("connection_test_failed", "模型连接测试失败", 502);
      await repository.recordTest(agentId, profile, {
        status: "failed",
        latencyMs: null,
        errorCode: safeError.code,
      });
      throw safeError;
    } finally {
      apiKey = undefined;
    }
  }

  return { deleteApiKey, listProfiles, saveProfile, testProfile };
}
