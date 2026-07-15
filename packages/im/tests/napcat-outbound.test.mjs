import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNapCatSendAction,
  parseNapCatActionResponse,
} from "../src/napcat-outbound.mjs";

test("group and private actions follow NapCat OneBot WebSocket contracts", () => {
  assert.deepEqual(buildNapCatSendAction({
    externalConversationId: "group:808607473",
    message: "大家好",
    echo: "outbound:decision-1",
  }), {
    action: "send_group_msg",
    params: { group_id: "808607473", message: "大家好" },
    echo: "outbound:decision-1",
  });
  assert.equal(buildNapCatSendAction({
    externalConversationId: "private:2849189094",
    message: "你好",
    echo: "outbound:decision-2",
  }).action, "send_private_msg");
});

test("action responses retain echo and string message IDs", () => {
  assert.deepEqual(parseNapCatActionResponse({
    status: "ok",
    retcode: 0,
    data: { message_id: 5678 },
    echo: "outbound:decision-1",
  }), {
    echo: "outbound:decision-1",
    ok: true,
    retcode: 0,
    externalMessageId: "5678",
    errorMessage: null,
    raw: {
      status: "ok",
      retcode: 0,
      data: { message_id: 5678 },
      echo: "outbound:decision-1",
    },
  });
  assert.equal(parseNapCatActionResponse({ post_type: "message", echo: null }), null);
});

test("definite NapCat errors are distinguishable from uncertain transport loss", () => {
  const response = parseNapCatActionResponse({
    status: "failed",
    retcode: 1200,
    wording: "group unavailable",
    echo: "outbound:decision-3",
  });
  assert.equal(response.ok, false);
  assert.equal(response.retcode, 1200);
  assert.match(response.errorMessage, /group unavailable/);
});
