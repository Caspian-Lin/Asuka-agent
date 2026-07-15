import assert from "node:assert/strict";
import test from "node:test";

import { buildLlmSettingsPayload } from "../app/components/llm-settings-form.ts";

function settingsForm(apiKey = "") {
  const values = new FormData();
  values.set("displayName", "主模型");
  values.set("baseUrl", "https://models.example/v1");
  values.set("modelId", "asuka-primary");
  values.set("contextWindow", "128000");
  values.set("enabled", "on");
  values.set("apiKey", apiKey);
  return values;
}

test("LLM settings interaction omits a blank key so the stored key is preserved", () => {
  const payload = buildLlmSettingsPayload(settingsForm());
  assert.equal(Object.hasOwn(payload, "apiKey"), false);
  assert.equal(payload.enabled, true);
  assert.equal(payload.contextWindow, 128_000);
});

test("LLM settings interaction includes a newly entered key only for submission", () => {
  const payload = buildLlmSettingsPayload(settingsForm("sk-transient"));
  assert.equal(payload.apiKey, "sk-transient");
});
