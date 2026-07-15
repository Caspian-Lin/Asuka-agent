export type LlmProfile = "primary" | "fast";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmRequest = {
  profile: LlmProfile;
  messages: LlmMessage[];
  maxOutputTokens?: number;
  responseSchema?: Record<string, unknown>;
};

export type LlmResponse = {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
};

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
