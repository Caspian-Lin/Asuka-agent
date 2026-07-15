import { createHash } from "node:crypto";

export const ACTION_COMPILER_PROMPT_VERSION = "asuka-action-compiler-v1";
export const PRIMARY_REVISION_PROMPT_VERSION = "asuka-primary-revision-v1";

export const ACTION_COMPILER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "revisionReasons", "actions"],
  properties: {
    status: { type: "string", enum: ["accepted", "needs_revision"] },
    revisionReasons: {
      type: "array",
      maxItems: 4,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
    actions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "content",
          "targetConversationId",
          "replyToMessageId",
          "subjectId",
          "sourceSpeakerId",
          "evidenceReferences",
          "sensitivity",
        ],
        properties: {
          type: { type: "string", enum: ["reply", "memory", "task", "no_action"] },
          content: { type: "string", maxLength: 4_000 },
          targetConversationId: { type: ["string", "null"] },
          replyToMessageId: { type: ["string", "null"] },
          subjectId: { type: ["string", "null"] },
          sourceSpeakerId: { type: ["string", "null"] },
          evidenceReferences: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "id"],
              properties: {
                type: { type: "string", enum: ["message", "memory", "source"] },
                id: { type: "string" },
              },
            },
          },
          sensitivity: {
            type: "string",
            enum: ["public", "normal", "sensitive", "restricted"],
          },
        },
      },
    },
  },
});

const COMPILER_SYSTEM_PROMPT = `You are a deterministic action compiler. Convert Asuka's completed natural cognition journal into the supplied strict JSON schema.

You do not think on Asuka's behalf, add facts, improve style, or rewrite a reply. For reply, memory, and task proposals, content must be copied as one exact contiguous substring from primaryOutput. If the journal lacks an exact usable draft, identity, evidence, or target required by an action, return needs_revision with concrete short reasons and no actions.

Use only IDs in referenceManifest and participants. A reply can target only policy.targetConversationId. Distinguish sourceSpeakerId (who uttered evidence) from subjectId (who the memory is about). Ambiguous identity stays null. no_action is a successful accepted result and must be the only action. You only compile proposals; you never execute effects.`;

export class ActionCompilerError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "ActionCompilerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function stableHash(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(value),
  ).digest("hex");
}

export function buildCompilerInput({
  thoughtRunId,
  primaryOutput,
  conversation,
  participants,
  references,
  policy = {},
}) {
  if (typeof primaryOutput !== "string" || !primaryOutput.trim()) {
    throw new ActionCompilerError("primary_output_missing", "primary output 不能为空");
  }
  const referenceManifest = [...new Map((references ?? []).map((reference) => [
    `${reference.type}:${reference.id}`,
    {
      type: String(reference.type),
      id: String(reference.id),
      senderId: reference.senderId == null ? null : String(reference.senderId),
      subjectId: reference.subjectId == null ? null : String(reference.subjectId),
      sensitivity: String(reference.sensitivity ?? "normal"),
    },
  ])).values()].sort((left, right) => (
    `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`)
  ));
  return {
    version: ACTION_COMPILER_PROMPT_VERSION,
    thoughtRunId: String(thoughtRunId),
    primaryOutput: primaryOutput.trim(),
    conversation: {
      id: String(conversation.id),
      type: String(conversation.type),
    },
    participants: (participants ?? []).map((participant) => ({
      id: String(participant.id),
      displayName: String(participant.displayName ?? participant.id),
    })),
    referenceManifest,
    policy: {
      ...policy,
      targetConversationId: String(conversation.id),
      allowedActionTypes: policy.allowedActionTypes ?? [
        "reply", "memory", "task", "no_action",
      ],
      maxActions: Math.min(8, Math.max(1, Number(policy.maxActions ?? 4))),
      effectsEnabled: false,
    },
  };
}

export function actionCompilerRequest(input) {
  return {
    profile: "fast",
    purpose: "compiler",
    promptVersion: ACTION_COMPILER_PROMPT_VERSION,
    responseSchema: ACTION_COMPILER_SCHEMA,
    maxOutputTokens: 2_048,
    messages: [
      { role: "system", content: COMPILER_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ],
  };
}

export function parseActionCompilerContent(content) {
  if (typeof content !== "string") {
    throw new ActionCompilerError("compiler_invalid_json", "compiler 结果不是文本");
  }
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ActionCompilerError("compiler_invalid_json", "compiler 返回了无效 JSON");
  }
}

function requiredString(value, label, maximum = 4_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ActionCompilerError("compiler_invalid_action", `${label}不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new ActionCompilerError("compiler_invalid_action", `${label}过长`);
  }
  return normalized;
}

function nullableString(value) {
  return value == null ? null : String(value);
}

export function validateCompilerOutput(output, input) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new ActionCompilerError("compiler_invalid_output", "compiler 输出必须是对象");
  }
  if (output.status === "needs_revision") {
    if (!Array.isArray(output.revisionReasons) || output.revisionReasons.length < 1 ||
        output.revisionReasons.length > 4 || output.actions?.length) {
      throw new ActionCompilerError(
        "compiler_invalid_revision",
        "needs_revision 必须包含 1-4 条原因且不能包含 actions",
      );
    }
    return {
      status: "needs_revision",
      revisionReasons: output.revisionReasons.map((reason) => requiredString(
        reason,
        "revision reason",
        300,
      )),
      actions: [],
    };
  }
  if (output.status !== "accepted" || !Array.isArray(output.actions) ||
      output.actions.length < 1 || output.actions.length > input.policy.maxActions) {
    throw new ActionCompilerError("compiler_invalid_output", "accepted actions 数量无效");
  }
  if (!Array.isArray(output.revisionReasons) || output.revisionReasons.length) {
    throw new ActionCompilerError("compiler_invalid_output", "accepted 不得包含 revision reasons");
  }
  const participantIds = new Set(input.participants.map((participant) => participant.id));
  const references = new Map(input.referenceManifest.map((reference) => [
    `${reference.type}:${reference.id}`,
    reference,
  ]));
  const allowedTypes = new Set(input.policy.allowedActionTypes);
  const actions = output.actions.map((action) => {
    const type = String(action?.type ?? "");
    if (!allowedTypes.has(type)) {
      throw new ActionCompilerError("compiler_action_forbidden", `action ${type} 未获允许`);
    }
    const evidenceReferences = Array.isArray(action.evidenceReferences)
      ? action.evidenceReferences.map((reference) => ({
          type: String(reference?.type ?? ""),
          id: String(reference?.id ?? ""),
        }))
      : [];
    if (evidenceReferences.some((reference) => !references.has(
      `${reference.type}:${reference.id}`,
    ))) {
      throw new ActionCompilerError("compiler_reference_outside_manifest", "action 引用了 manifest 外来源");
    }
    const subjectId = nullableString(action.subjectId);
    const sourceSpeakerId = nullableString(action.sourceSpeakerId);
    const targetConversationId = nullableString(action.targetConversationId);
    const replyToMessageId = nullableString(action.replyToMessageId);
    const sensitivity = String(action.sensitivity ?? "");
    if (!["public", "normal", "sensitive", "restricted"].includes(sensitivity)) {
      throw new ActionCompilerError("compiler_invalid_action", "sensitivity 无效");
    }
    if (subjectId && !participantIds.has(subjectId)) {
      throw new ActionCompilerError("compiler_invalid_identity", "subject 不在参与者表");
    }
    if (sourceSpeakerId && !participantIds.has(sourceSpeakerId)) {
      throw new ActionCompilerError("compiler_invalid_identity", "source speaker 不在参与者表");
    }
    if (replyToMessageId && !references.has(`message:${replyToMessageId}`)) {
      throw new ActionCompilerError("compiler_reference_outside_manifest", "reply target 不在 manifest");
    }
    if (type === "no_action") {
      if (output.actions.length !== 1 || action.content !== "" || targetConversationId ||
          replyToMessageId || subjectId || sourceSpeakerId || evidenceReferences.length) {
        throw new ActionCompilerError("compiler_invalid_action", "no_action 必须是唯一空动作");
      }
      return {
        type,
        content: "",
        targetConversationId: null,
        replyToMessageId: null,
        subjectId: null,
        sourceSpeakerId: null,
        evidenceReferences: [],
        sensitivity,
      };
    }
    const content = requiredString(action.content, `${type} content`);
    if (!input.primaryOutput.includes(content)) {
      throw new ActionCompilerError(
        "compiler_content_rewritten",
        `${type} content 不是 primary output 的连续原文`,
      );
    }
    if (evidenceReferences.length < 1) {
      throw new ActionCompilerError("compiler_evidence_missing", `${type} 缺少证据`);
    }
    if (type === "reply" && targetConversationId !== input.policy.targetConversationId) {
      throw new ActionCompilerError("compiler_target_invalid", "reply target conversation 无效");
    }
    if (type !== "reply" && targetConversationId !== null) {
      throw new ActionCompilerError("compiler_target_invalid", `${type} 不得指定 target conversation`);
    }
    if (type === "memory") {
      if (!sourceSpeakerId) {
        throw new ActionCompilerError("compiler_invalid_identity", "memory 缺少 source speaker");
      }
      const sourceEvidence = evidenceReferences
        .map((reference) => references.get(`${reference.type}:${reference.id}`))
        .filter((reference) => reference?.type === "message");
      if (!sourceEvidence.some((reference) => reference.senderId === sourceSpeakerId)) {
        throw new ActionCompilerError(
          "compiler_invalid_identity",
          "memory source speaker 没有实际说出 message evidence",
        );
      }
    }
    return {
      type,
      content,
      targetConversationId,
      replyToMessageId,
      subjectId,
      sourceSpeakerId,
      evidenceReferences,
      sensitivity,
    };
  });
  return { status: "accepted", revisionReasons: [], actions };
}

export function actionProposalIdempotencyKey(thoughtRunId, ordinal, action) {
  return `proposal:${stableHash({ thoughtRunId, ordinal, action })}`;
}

export function selectReusableCompilerCall(calls, invalidCallIds, sourceOutputHash) {
  const rejected = invalidCallIds instanceof Set
    ? invalidCallIds
    : new Set(invalidCallIds ?? []);
  return [...(calls ?? [])].reverse().find((call) => (
    !rejected.has(String(call.id)) &&
    call.response_json?.metadata?.sourceOutputHash === sourceOutputHash
  )) ?? null;
}

export function primaryRevisionRequest({ requestContext, currentOutput, revisionReasons }) {
  if (!Array.isArray(requestContext) || requestContext.length === 0) {
    throw new ActionCompilerError("revision_context_missing", "primary revision 缺少原始上下文");
  }
  return {
    profile: "primary",
    purpose: "revision",
    promptVersion: PRIMARY_REVISION_PROMPT_VERSION,
    responseSchema: undefined,
    maxOutputTokens: 4_096,
    messages: [
      ...requestContext,
      { role: "assistant", content: currentOutput },
      {
        role: "user",
        content: [
          "Revise your inspectable cognition journal only to address these compiler gaps:",
          ...revisionReasons.map((reason) => `- ${reason}`),
          "Keep it natural Markdown, preserve correct content, and include exact usable drafts and visible evidence IDs. Do not output JSON.",
        ].join("\n"),
      },
    ],
  };
}
