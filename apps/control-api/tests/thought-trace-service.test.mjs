import assert from "node:assert/strict";
import test from "node:test";

import {
  createThoughtTraceService,
  REDACTED_CONTENT,
  resolveThoughtTraceAccess,
} from "../src/thought-trace-service.mjs";

function serviceFor({ rows = [], detail = null, access = "redacted" } = {}) {
  return createThoughtTraceService({
    access,
    repository: {
      async listRuns() {
        return rows;
      },
      async getRun() {
        return detail;
      },
    },
  });
}

test("thought trace list contract preserves empty and success states", async () => {
  const empty = await serviceFor().listRuns();
  assert.deepEqual(empty.thoughtRuns, []);
  assert.equal(empty.traceAccess.sensitiveContent, "redacted");

  const success = await serviceFor({
    rows: [{ id: "thought-1", summary: "普通摘要", contains_sensitive_content: false }],
  }).listRuns();
  assert.equal(success.thoughtRuns[0].summary, "普通摘要");
});

test("thought trace contract reports missing detail as a typed 404", async () => {
  await assert.rejects(
    serviceFor().getRun("thought-missing"),
    (error) => error.code === "thought_run_not_found" && error.status === 404,
  );
});

test("redacted trace removes sensitive memory text from every recorded payload", async () => {
  const sensitive = "小林对花生过敏";
  const detail = {
    run: { id: "thought-1", primary_output: `候选记忆：${sensitive}` },
    candidates: [{ sensitivity: "restricted", claim: sensitive }],
    proposals: [{ payload: { sensitivity: "restricted", content: sensitive } }],
    calls: [{
      request_context: [{ role: "user", content: `参考 ${sensitive}` }],
      context_items: [{
        itemType: "memory",
        content: sensitive,
        metadata: { sensitivity: "restricted", disclosureDecision: "allowed" },
      }, {
        itemType: "request_payload",
        content: JSON.stringify({ messages: [{ content: sensitive }], api_key: "never-store-me" }),
        metadata: {},
      }],
    }],
  };

  const result = await serviceFor({ detail }).getRun("thought-1");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /小林对花生过敏|never-store-me/);
  assert.match(result.run.primary_output, new RegExp(REDACTED_CONTENT));
  assert.equal(result.calls[0].context_items[0].metadata.redacted, true);
  assert.equal(result.traceAccess.secrets, "always_redacted");
});

test("full sensitive trace access is explicit and only valid on loopback", async () => {
  assert.equal(resolveThoughtTraceAccess({ configuredAccess: "full", host: "127.0.0.1" }), "full");
  assert.equal(resolveThoughtTraceAccess({ configuredAccess: "full", host: "0.0.0.0" }), "redacted");

  const detail = {
    run: { id: "thought-1" },
    candidates: [{ sensitivity: "restricted", claim: "保留原文" }],
    calls: [],
    proposals: [],
  };
  const result = await serviceFor({ detail, access: "full" }).getRun("thought-1");
  assert.equal(result.candidates[0].claim, "保留原文");
  assert.equal(result.traceAccess.sensitiveContent, "full");
});

test("secret-free provider payload keeps its original bytes", async () => {
  const exactPayload = '{\n  "model": "primary",\n  "messages": []\n}';
  const result = await serviceFor({
    detail: {
      run: { id: "thought-1" },
      candidates: [],
      proposals: [],
      calls: [{
        context_items: [{
          itemType: "request_payload",
          content: exactPayload,
          metadata: {},
        }],
      }],
    },
  }).getRun("thought-1");
  assert.equal(result.calls[0].context_items[0].content, exactPayload);
});

test("sensitive list summaries are redacted without hiding stream metadata", async () => {
  const result = await serviceFor({
    rows: [{
      id: "thought-1",
      conversation_id: "conversation-1",
      summary: "包含敏感事实",
      contains_sensitive_content: true,
    }],
  }).listRuns();
  assert.equal(result.thoughtRuns[0].summary, REDACTED_CONTENT);
  assert.equal(result.thoughtRuns[0].conversation_id, "conversation-1");
});
