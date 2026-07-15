export function parseGroupWhitelist(value = "") {
  return new Set(
    String(value)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function messageSegments(event) {
  if (Array.isArray(event.message)) return event.message;
  if (typeof event.raw_message === "string") {
    return [{ type: "text", data: { text: event.raw_message } }];
  }
  return [];
}

/** Normalize only explicitly allowlisted group messages. */
export function normalizeNapCatMessage(
  event,
  allowedGroups,
  allowedPrivateUsers = new Set(),
) {
  if (event?.post_type !== "message") return null;

  const externalMessageId = String(event.message_id ?? "");
  const senderId = String(event.user_id ?? event.sender?.user_id ?? "");
  const selfId = String(event.self_id ?? "");
  if (!externalMessageId || !senderId || senderId === selfId) return null;

  let externalConversationId;
  if (event.message_type === "group") {
    const groupId = String(event.group_id ?? "");
    if (!groupId || !allowedGroups.has(groupId)) return null;
    externalConversationId = `group:${groupId}`;
  } else if (event.message_type === "private") {
    if (!allowedPrivateUsers.has(senderId)) return null;
    externalConversationId = `private:${senderId}`;
  } else {
    return null;
  }

  return {
    externalConversationId,
    externalMessageId,
    senderId,
    messageType: event.message_type,
    content: messageSegments(event),
    sentAt: Number.isFinite(event.time)
      ? new Date(event.time * 1000).toISOString()
      : null,
  };
}
