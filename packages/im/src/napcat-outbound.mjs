export class NapCatOutboundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NapCatOutboundError";
    this.code = code;
  }
}

export function buildNapCatSendAction({ externalConversationId, message, echo }) {
  const conversation = String(externalConversationId ?? "");
  const text = String(message ?? "").trim();
  const correlation = String(echo ?? "").trim();
  if (!text) throw new NapCatOutboundError("outbound_message_empty", "外发消息不能为空");
  if (!correlation) throw new NapCatOutboundError("outbound_echo_missing", "NapCat echo 不能为空");
  if (conversation.startsWith("group:")) {
    const groupId = conversation.slice("group:".length);
    if (!groupId) throw new NapCatOutboundError("outbound_target_invalid", "群号无效");
    return {
      action: "send_group_msg",
      params: { group_id: groupId, message: text },
      echo: correlation,
    };
  }
  if (conversation.startsWith("private:")) {
    const userId = conversation.slice("private:".length);
    if (!userId) throw new NapCatOutboundError("outbound_target_invalid", "私聊 QQ 号无效");
    return {
      action: "send_private_msg",
      params: { user_id: userId, message: text },
      echo: correlation,
    };
  }
  throw new NapCatOutboundError("outbound_target_invalid", "仅支持 QQ 群聊或私聊外发");
}

export function parseNapCatActionResponse(payload) {
  if (!payload || payload.post_type || payload.echo == null) return null;
  const echo = String(payload.echo);
  if (!echo.startsWith("outbound:")) return null;
  const retcode = Number(payload.retcode);
  const ok = payload.status === "ok" && retcode === 0;
  const messageId = payload.data?.message_id;
  return {
    echo,
    ok,
    retcode: Number.isFinite(retcode) ? retcode : null,
    externalMessageId: messageId == null ? null : String(messageId),
    errorMessage: ok
      ? null
      : String(payload.wording || payload.message || "NapCat send action failed").slice(0, 500),
    raw: payload,
  };
}
