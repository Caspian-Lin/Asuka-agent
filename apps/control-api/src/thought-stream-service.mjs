export class ThoughtStreamRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ThoughtStreamRequestError";
    this.code = code;
    this.status = status;
  }
}

export function createThoughtStreamService({ repository, randomId, clock = () => new Date() }) {
  async function resetConversation(conversationId) {
    const normalizedId = String(conversationId ?? "").trim();
    if (!normalizedId) {
      throw new ThoughtStreamRequestError(
        "conversation_required",
        "缺少 conversationId",
      );
    }
    const result = await repository.resetConversation({
      conversationId: normalizedId,
      resetId: randomId(),
      now: clock(),
    });
    if (result.outcome === "not_found") {
      throw new ThoughtStreamRequestError(
        "thought_stream_not_found",
        "该会话还没有可重置的思绪上下文",
        404,
      );
    }
    if (result.outcome === "busy") {
      throw new ThoughtStreamRequestError(
        "thought_stream_busy",
        "该会话的思绪正在运行，请等待本轮结束后重置",
        409,
      );
    }
    if (result.outcome === "inactive") {
      throw new ThoughtStreamRequestError(
        "thought_stream_inactive",
        "该会话的思绪流当前不可重置",
        409,
      );
    }
    return result.stream;
  }

  return { resetConversation };
}
