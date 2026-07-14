import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeNapCatMessage,
  parseGroupWhitelist,
} from "../lib/napcat-ingress.mjs";

const groupEvent = {
  post_type: "message",
  message_type: "group",
  self_id: 10000,
  user_id: 20000,
  group_id: 30000,
  message_id: 40000,
  time: 1_720_000_000,
  message: [{ type: "text", data: { text: "hello" } }],
};

test("group whitelist parsing removes empty and duplicate values", () => {
  assert.deepEqual([...parseGroupWhitelist("30000, 40000,30000,")], [
    "30000",
    "40000",
  ]);
});

test("only allowlisted group messages are normalized", () => {
  const normalized = normalizeNapCatMessage(
    groupEvent,
    parseGroupWhitelist("30000"),
  );
  assert.equal(normalized?.externalConversationId, "group:30000");
  assert.equal(normalized?.externalMessageId, "40000");
  assert.deepEqual(normalized?.content, groupEvent.message);

  assert.equal(
    normalizeNapCatMessage(groupEvent, parseGroupWhitelist("99999")),
    null,
  );
});

test("only allowlisted private users are normalized", () => {
  const normalized = normalizeNapCatMessage(
    {
      ...groupEvent,
      message_type: "private",
      user_id: 2849189094,
    },
    parseGroupWhitelist("30000"),
    parseGroupWhitelist("2849189094"),
  );
  assert.equal(normalized?.externalConversationId, "private:2849189094");
  assert.equal(normalized?.messageType, "private");

  assert.equal(
    normalizeNapCatMessage(
      { ...groupEvent, message_type: "private", user_id: 99999 },
      parseGroupWhitelist("30000"),
      parseGroupWhitelist("2849189094"),
    ),
    null,
  );
});

test("self-authored messages are rejected", () => {
  const whitelist = parseGroupWhitelist("30000");
  assert.equal(
    normalizeNapCatMessage(
      { ...groupEvent, user_id: groupEvent.self_id },
      whitelist,
    ),
    null,
  );
});
