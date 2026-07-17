import { createHash } from "node:crypto";
import {
  PRIMARY_THOUGHT_PROMPT_VERSION,
  PRIMARY_THOUGHT_SYSTEM_PROMPT,
  primaryThoughtRequest,
} from "./primary-thought.mjs";
import { buildMemoryProposal } from "./memory-proposal.mjs";

export const THOUGHT_PROMPT_VERSION = PRIMARY_THOUGHT_PROMPT_VERSION;
export const MEMORY_PROMPT_VERSION = "memory-v2-global-disclosure";

const memorySchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "operation",
          "memoryType",
          "subjectId",
          "sourceSpeakerId",
          "claim",
          "evidenceMessageIds",
          "confidence",
          "attributionStatus",
          "sensitivity",
          "disclosurePolicy",
          "validFrom",
          "validTo",
          "targetCandidateId",
        ],
        properties: {
          operation: {
            type: "string",
            enum: ["create", "duplicate", "update", "conflict"],
          },
          memoryType: {
            type: "string",
            enum: ["preference", "goal", "profile", "prospective", "fact", "lesson"],
          },
          subjectId: { type: ["string", "null"] },
          sourceSpeakerId: { type: "string" },
          claim: { type: "string" },
          evidenceMessageIds: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: { type: "string" },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          attributionStatus: { type: "string", enum: ["resolved", "unresolved"] },
          sensitivity: {
            type: "string",
            enum: ["public", "normal", "sensitive", "restricted"],
          },
          disclosurePolicy: {
            type: "object",
            additionalProperties: false,
            required: ["scope", "conversationIds", "participantIds"],
            properties: {
              scope: {
                type: "string",
                enum: ["public", "subject", "private", "allowlist"],
              },
              conversationIds: {
                type: "array",
                maxItems: 100,
                items: { type: "string" },
              },
              participantIds: {
                type: "array",
                maxItems: 100,
                items: { type: "string" },
              },
            },
          },
          validFrom: { type: ["string", "null"] },
          validTo: { type: ["string", "null"] },
          targetCandidateId: { type: ["string", "null"] },
        },
      },
    },
  },
});

const identityProtocol = `
Identity and evidence protocol:
- Treat participant_id as identity. Display names and aliases are presentation only.
- Every message has its own sender_id. Never merge facts from different senders.
- sourceSpeakerId means who uttered the evidence. subjectId means who the claim is about.
- A first-person statement normally has subjectId equal to sourceSpeakerId.
- Reported speech may use different source and subject only when the evidence explicitly identifies the subject.
- If a pronoun, nickname, or target is ambiguous, set subjectId to null and attributionStatus to unresolved. Never guess the current or most recent speaker.
- Cite only message IDs present in the supplied context. Do not invent evidence.
- Return conclusions, not private chain-of-thought or hidden reasoning.
`;

const memoryExamples = `
Examples:
1. A says "我喜欢爵士乐" -> source=A, subject=A, resolved.
2. A says "B 说她喜欢爵士乐" and B is explicitly identified -> source=A, subject=B, resolved.
3. A says "她喜欢爵士乐" with multiple possible people -> source=A, subject=null, unresolved.
4. The same participant_id appears as "小林" and later "Lin" -> one person with aliases, not two people.
`;

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CognitionValidationError("invalid_output", `${label}不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new CognitionValidationError("invalid_output", `${label}过长`);
  }
  return normalized;
}

function confidenceMillis(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CognitionValidationError("invalid_output", "置信度必须位于 0 到 1");
  }
  return Math.round(value * 1_000);
}

function evidenceIds(value, messageById, maximum = 12) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new CognitionValidationError("invalid_evidence", "证据消息数量无效");
  }
  const normalized = [...new Set(value.map(String))];
  if (normalized.length !== value.length || normalized.some((id) => !messageById.has(id))) {
    throw new CognitionValidationError(
      "invalid_evidence",
      "证据必须唯一且来自本次上下文",
    );
  }
  return normalized;
}

function normalizedAliases(value, displayName) {
  const aliases = Array.isArray(value) ? value : [];
  return [...new Set([displayName, ...aliases].map(String).map((item) => item.trim()).filter(Boolean))];
}

export class CognitionValidationError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = "CognitionValidationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function buildSpeakerContext({ conversation, participants, messages, existingCandidates = [] }) {
  if (!conversation?.id || !Array.isArray(messages) || messages.length === 0) {
    throw new CognitionValidationError("empty_context", "会话没有可处理的新消息");
  }
  const normalizedMessages = messages.map((message) => ({
    message_id: String(message.id),
    author_kind: String(message.authorKind ?? "user"),
    direction: String(message.direction ?? "inbound"),
    sender_id: message.senderId == null ? null : String(message.senderId),
    sender_display_name: message.senderDisplayName == null
      ? null
      : String(message.senderDisplayName),
    reply_to: message.replyTo == null ? null : String(message.replyTo),
    sent_at: new Date(message.createdAt).toISOString(),
    conversation_type: String(
      conversation.type ?? (String(conversation.externalId).startsWith("private:")
        ? "private"
        : "group"),
    ),
    content: String(message.content),
  }));
  if (normalizedMessages.some((message) => (
    message.author_kind === "user" && !message.sender_id
  ))) {
    throw new CognitionValidationError(
      "speaker_missing",
      "入站消息缺少稳定 sender_id，不能进入认知任务",
    );
  }
  const participantById = new Map();
  for (const participant of participants ?? []) {
    const participantId = String(participant.participantId);
    const displayName = String(participant.displayName || participantId);
    participantById.set(participantId, {
      participant_id: participantId,
      display_name: displayName,
      aliases: normalizedAliases(participant.aliases, displayName),
    });
  }
  for (const message of normalizedMessages) {
    if (!message.sender_id) continue;
    if (!participantById.has(message.sender_id)) {
      participantById.set(message.sender_id, {
        participant_id: message.sender_id,
        display_name: message.sender_display_name || message.sender_id,
        aliases: normalizedAliases([], message.sender_display_name || message.sender_id),
      });
    }
  }
  return {
    conversation: {
      conversation_id: String(conversation.id),
      title: String(conversation.title),
      channel: String(conversation.channel),
      external_id: conversation.externalId == null ? null : String(conversation.externalId),
      type: String(
        conversation.type ?? (String(conversation.externalId).startsWith("private:")
          ? "private"
          : "group"),
      ),
    },
    participants: [...participantById.values()],
    messages: normalizedMessages,
    existing_candidates: existingCandidates.map((candidate) => ({
      candidate_id: String(candidate.id),
      subject_id: candidate.subjectId == null ? null : String(candidate.subjectId),
      source_speaker_id: String(candidate.sourceSpeakerId),
      claim: String(candidate.claim),
      attribution_status: String(candidate.attributionStatus),
      status: String(candidate.status),
      source_conversation_id: String(
        candidate.sourceConversationId ?? candidate.conversationId ?? conversation.id,
      ),
      memory_type: String(candidate.memoryType ?? "fact"),
      sensitivity: String(candidate.sensitivity ?? "normal"),
      disclosure_policy: candidate.disclosurePolicy ?? null,
      valid_from: candidate.validFrom == null
        ? null
        : new Date(candidate.validFrom).toISOString(),
      valid_to: candidate.validTo == null ? null : new Date(candidate.validTo).toISOString(),
    })),
  };
}

export function cognitionRequest(jobType, contextPack) {
  const serialized = JSON.stringify(contextPack);
  if (jobType === "thought_tick") {
    return primaryThoughtRequest([
      { role: "system", content: PRIMARY_THOUGHT_SYSTEM_PROMPT },
      { role: "user", content: serialized },
    ]);
  }
  if (jobType === "memory_consolidation") {
    return {
      profile: "primary",
      promptVersion: MEMORY_PROMPT_VERSION,
      responseSchema: memorySchema,
      maxOutputTokens: 2_048,
      messages: [
        {
          role: "system",
          content: `You generate reviewable Agent-global memory proposals from shared multi-party conversation evidence.${identityProtocol}${memoryExamples}
Compare the current evidence with every supplied existing candidate for the same stable subject even when source_conversation_id differs. Return create, duplicate, update, or conflict proposals. A non-create operation must reference one targetCandidateId for the same subject. Never activate, overwrite, archive, or supersede the target row; the server will persist a separate proposal and diff.
Choose the narrowest disclosure policy. Health, allergy, diagnosis, medication, pregnancy, disability, and mental-health facts must use sensitivity=restricted and default to scope=private unless an explicit allowlist is present. Preserve real-world validity when it is explicit; otherwise use null. Prefer no candidate over uncertain attribution.`,
        },
        { role: "user", content: serialized },
      ],
    };
  }
  throw new CognitionValidationError("unsupported_job", `不支持的认知任务：${jobType}`);
}

export function parseStructuredOutput(content) {
  if (typeof content !== "string") {
    throw new CognitionValidationError("invalid_json", "模型结构化结果不是文本");
  }
  const normalized = content.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(normalized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new CognitionValidationError("invalid_json", "模型返回的结构化 JSON 无效");
  }
}

export function validateThoughtOutput(output, contextPack, now = new Date()) {
  if (output?.action === "none") return null;
  if (output?.action !== "create") {
    throw new CognitionValidationError("invalid_output", "思绪 action 无效");
  }
  const messageById = new Map(contextPack.messages.map((message) => [message.message_id, message]));
  const expiresInMinutes = Number(output.expiresInMinutes);
  if (!Number.isSafeInteger(expiresInMinutes) || expiresInMinutes < 1 || expiresInMinutes > 10_080) {
    throw new CognitionValidationError("invalid_output", "思绪过期时间无效");
  }
  if (!["low", "medium", "high"].includes(output.risk)) {
    throw new CognitionValidationError("invalid_output", "思绪风险等级无效");
  }
  if (!["silent", "defer", "review"].includes(output.decision)) {
    throw new CognitionValidationError("invalid_output", "思绪决策无效");
  }
  return {
    intent: boundedText(output.intent, "思绪意图", 240),
    basis: boundedText(output.basis, "思绪依据", 500),
    evidenceMessageIds: evidenceIds(output.evidenceMessageIds, messageById, 8),
    confidenceMillis: confidenceMillis(output.confidence),
    risk: output.risk,
    decision: output.decision,
    expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000),
  };
}

export function validateMemoryOutput(output, contextPack, provenance = {}) {
  if (!Array.isArray(output?.candidates) || output.candidates.length > 10) {
    throw new CognitionValidationError("invalid_output", "记忆候选列表无效");
  }
  const participantIds = new Set(
    contextPack.participants.map((participant) => participant.participant_id),
  );
  const messageById = new Map(contextPack.messages.map((message) => [message.message_id, message]));
  const existingById = new Map(
    contextPack.existing_candidates.map((candidate) => [candidate.candidate_id, {
      id: candidate.candidate_id,
      conversationId: candidate.source_conversation_id,
      subjectId: candidate.subject_id,
      sourceSpeakerId: candidate.source_speaker_id,
      claim: candidate.claim,
      memoryType: candidate.memory_type ?? "fact",
      sensitivity: candidate.sensitivity ?? "normal",
      disclosurePolicy: candidate.disclosure_policy,
      validFrom: candidate.valid_from,
      validTo: candidate.valid_to,
      attributionStatus: candidate.attribution_status,
      status: candidate.status,
    }]),
  );
  return output.candidates.map((candidate) => {
    if (!["create", "duplicate", "update", "conflict"].includes(candidate?.operation)) {
      throw new CognitionValidationError("invalid_output", "记忆候选 operation 无效");
    }
    const sourceSpeakerId = String(candidate.sourceSpeakerId ?? "");
    if (!participantIds.has(sourceSpeakerId)) {
      throw new CognitionValidationError("invalid_attribution", "source speaker 不在参与者表");
    }
    const evidenceMessageIds = evidenceIds(candidate.evidenceMessageIds, messageById);
    if (!evidenceMessageIds.some((id) => messageById.get(id)?.sender_id === sourceSpeakerId)) {
      throw new CognitionValidationError(
        "invalid_attribution",
        "source speaker 必须实际说出至少一条证据",
      );
    }
    const attributionStatus = candidate.attributionStatus;
    const subjectId = candidate.subjectId == null ? null : String(candidate.subjectId);
    if (attributionStatus === "unresolved") {
      if (subjectId !== null) {
        throw new CognitionValidationError("invalid_attribution", "未解析对象不得绑定 subject");
      }
    } else if (attributionStatus === "resolved") {
      if (!subjectId || !participantIds.has(subjectId)) {
        throw new CognitionValidationError("invalid_attribution", "subject 不在参与者表");
      }
    } else {
      throw new CognitionValidationError("invalid_attribution", "归因状态无效");
    }
    const targetCandidateId = candidate.targetCandidateId == null
      ? null
      : String(candidate.targetCandidateId);
    if (candidate.operation === "create" && targetCandidateId !== null) {
      throw new CognitionValidationError("invalid_output", "新增候选不得指定 target");
    }
    if (candidate.operation !== "create" && !existingById.has(targetCandidateId)) {
      throw new CognitionValidationError("invalid_output", "更新或冲突必须引用已有候选");
    }
    return buildMemoryProposal({
      operation: candidate.operation,
      memoryType: candidate.memoryType ?? "fact",
      subjectId,
      sourceSpeakerId,
      sourceConversationId: contextPack.conversation.conversation_id,
      thoughtRunId: provenance.thoughtRunId ?? "unpersisted-memory-consolidation",
      claim: boundedText(candidate.claim, "记忆 claim", 600),
      evidenceMessageIds,
      confidenceMillis: confidenceMillis(candidate.confidence),
      attributionStatus,
      sensitivity: candidate.sensitivity ?? "normal",
      disclosurePolicy: candidate.disclosurePolicy,
      validFrom: candidate.validFrom ?? null,
      validTo: candidate.validTo ?? null,
      targetCandidateId,
      existingCandidates: [...existingById.values()],
      promptVersion: provenance.promptVersion ?? MEMORY_PROMPT_VERSION,
    });
  });
}

export function stableHash(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(value),
  ).digest("hex");
}

export function outputIdempotencyKey(jobType, conversationId, lastMessageId, ordinal = 0) {
  return `${jobType}:${stableHash({ conversationId, lastMessageId, ordinal })}`;
}
