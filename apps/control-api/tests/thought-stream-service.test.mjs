import assert from "node:assert/strict";
import test from "node:test";

import { createThoughtStreamService } from "../src/thought-stream-service.mjs";

function serviceFor(result) {
  const requests = [];
  return {
    requests,
    service: createThoughtStreamService({
      repository: {
        async resetConversation(input) {
          requests.push(input);
          return result;
        },
      },
      randomId: () => "reset-1",
      clock: () => new Date("2026-07-17T08:00:00Z"),
    }),
  };
}

test("conversation reset opens an empty epoch without changing the message watermark", async () => {
  const fixture = serviceFor({
    outcome: "reset",
    stream: {
      conversationId: "conversation-1",
      previousEpochOrdinal: 2,
      currentEpochOrdinal: 3,
      committedMessageId: "message-9",
    },
  });
  const stream = await fixture.service.resetConversation("conversation-1");
  assert.equal(stream.currentEpochOrdinal, 3);
  assert.equal(stream.committedMessageId, "message-9");
  assert.deepEqual(fixture.requests[0], {
    conversationId: "conversation-1",
    resetId: "reset-1",
    now: new Date("2026-07-17T08:00:00Z"),
  });
});

test("conversation reset rejects missing, busy, and unknown streams", async () => {
  const missingInput = serviceFor({ outcome: "reset", stream: {} }).service;
  await assert.rejects(
    missingInput.resetConversation(" "),
    (error) => error.code === "conversation_required" && error.status === 400,
  );

  const busy = serviceFor({ outcome: "busy" }).service;
  await assert.rejects(
    busy.resetConversation("conversation-1"),
    (error) => error.code === "thought_stream_busy" && error.status === 409,
  );

  const unknown = serviceFor({ outcome: "not_found" }).service;
  await assert.rejects(
    unknown.resetConversation("conversation-2"),
    (error) => error.code === "thought_stream_not_found" && error.status === 404,
  );
});
