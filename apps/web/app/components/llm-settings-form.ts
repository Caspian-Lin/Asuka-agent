export type LlmSettingsPayload = {
  displayName: string;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  enabled: boolean;
  apiKey?: string;
};

export function buildLlmSettingsPayload(values: FormData): LlmSettingsPayload {
  const apiKey = String(values.get("apiKey") ?? "");
  return {
    displayName: String(values.get("displayName") ?? ""),
    baseUrl: String(values.get("baseUrl") ?? ""),
    modelId: String(values.get("modelId") ?? ""),
    contextWindow: Number(values.get("contextWindow")),
    enabled: values.get("enabled") === "on",
    ...(apiKey ? { apiKey } : {}),
  };
}
