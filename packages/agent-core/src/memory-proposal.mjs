export const MEMORY_TYPES = Object.freeze([
  "preference",
  "goal",
  "profile",
  "prospective",
  "fact",
  "lesson",
]);

export const MEMORY_SENSITIVITIES = Object.freeze([
  "public",
  "normal",
  "sensitive",
  "restricted",
]);

export const MEMORY_DISCLOSURE_SCOPES = Object.freeze([
  "public",
  "subject",
  "private",
  "allowlist",
]);

const sensitivityRank = new Map(
  MEMORY_SENSITIVITIES.map((sensitivity, rank) => [sensitivity, rank]),
);

const healthPatterns = [
  /(?:过敏|疾病|病史|诊断|症状|用药|药物|处方|手术|怀孕|孕期|残疾|心理健康|精神疾病|血型|体检)/u,
  /\b(?:allerg(?:y|ic)|diagnos(?:is|ed)|disease|disability|medication|pregnan(?:t|cy)|prescription|mental health|medical)\b/iu,
];

export class MemoryProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryProposalError";
    this.code = code;
  }
}

function requiredText(value, label, maximum = 4_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new MemoryProposalError("memory_contract_invalid", `${label}不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new MemoryProposalError("memory_contract_invalid", `${label}过长`);
  }
  return normalized;
}

function nullableDate(value, label) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MemoryProposalError("memory_validity_invalid", `${label}不是有效时间`);
  }
  return date.toISOString();
}

function uniqueStrings(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new MemoryProposalError("memory_contract_invalid", `${label}无效`);
  }
  const normalized = value.map(String).map((item) => item.trim());
  if (normalized.some((item) => !item) || new Set(normalized).size !== normalized.length) {
    throw new MemoryProposalError("memory_contract_invalid", `${label}必须非空且不可重复`);
  }
  return normalized;
}

export function enforceMemorySensitivity(claim, requested = "normal") {
  if (!MEMORY_SENSITIVITIES.includes(requested)) {
    throw new MemoryProposalError("memory_sensitivity_invalid", "记忆敏感度无效");
  }
  const inferred = healthPatterns.some((pattern) => pattern.test(String(claim)))
    ? "restricted"
    : requested;
  return sensitivityRank.get(inferred) > sensitivityRank.get(requested)
    ? inferred
    : requested;
}

export function defaultDisclosurePolicy(sensitivity) {
  if (!MEMORY_SENSITIVITIES.includes(sensitivity)) {
    throw new MemoryProposalError("memory_sensitivity_invalid", "记忆敏感度无效");
  }
  if (sensitivity === "public") {
    return { scope: "public", conversationIds: [], participantIds: [] };
  }
  if (sensitivity === "restricted") {
    return { scope: "private", conversationIds: [], participantIds: [] };
  }
  return { scope: "subject", conversationIds: [], participantIds: [] };
}

export function normalizeDisclosurePolicy(value, sensitivity) {
  const fallback = defaultDisclosurePolicy(sensitivity);
  if (value == null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryProposalError("memory_disclosure_invalid", "disclosure policy 必须是对象");
  }
  const scope = String(value.scope ?? fallback.scope);
  if (!MEMORY_DISCLOSURE_SCOPES.includes(scope)) {
    throw new MemoryProposalError("memory_disclosure_invalid", "disclosure scope 无效");
  }
  const normalized = {
    scope,
    conversationIds: uniqueStrings(
      value.conversationIds ?? [],
      100,
      "disclosure conversationIds",
    ),
    participantIds: uniqueStrings(
      value.participantIds ?? [],
      100,
      "disclosure participantIds",
    ),
  };
  if (sensitivity === "restricted" && !["private", "allowlist"].includes(scope)) {
    return fallback;
  }
  if (scope === "allowlist" &&
      normalized.conversationIds.length === 0 && normalized.participantIds.length === 0) {
    throw new MemoryProposalError(
      "memory_disclosure_invalid",
      "allowlist disclosure 至少需要一个明确授权目标",
    );
  }
  return normalized;
}

function normalizedTarget(existingCandidates, targetCandidateId) {
  if (targetCandidateId == null) return null;
  const target = (existingCandidates ?? []).find((candidate) => (
    String(candidate.id) === String(targetCandidateId)
  ));
  if (!target) {
    throw new MemoryProposalError(
      "memory_target_invalid",
      "duplicate、update 或 conflict 必须引用可见的全局候选",
    );
  }
  return target;
}

function snapshot(value) {
  if (!value) return null;
  return {
    claim: String(value.claim),
    memoryType: String(value.memoryType ?? "fact"),
    sensitivity: String(value.sensitivity ?? "normal"),
    disclosurePolicy: value.disclosurePolicy ?? defaultDisclosurePolicy(
      String(value.sensitivity ?? "normal"),
    ),
    validFrom: value.validFrom == null ? null : new Date(value.validFrom).toISOString(),
    validTo: value.validTo == null ? null : new Date(value.validTo).toISOString(),
  };
}

function changedFields(before, after) {
  if (!before) return Object.keys(after);
  return Object.keys(after).filter((key) => (
    JSON.stringify(before[key]) !== JSON.stringify(after[key])
  ));
}

export function buildMemoryProposal({
  operation,
  memoryType = "fact",
  subjectId,
  sourceSpeakerId,
  sourceConversationId,
  thoughtRunId,
  claim,
  evidenceMessageIds,
  confidenceMillis,
  attributionStatus,
  sensitivity = "normal",
  disclosurePolicy,
  validFrom = null,
  validTo = null,
  targetCandidateId = null,
  existingCandidates = [],
  promptVersion,
}) {
  if (!["create", "duplicate", "update", "conflict"].includes(operation)) {
    throw new MemoryProposalError("memory_operation_invalid", "记忆 operation 无效");
  }
  if (!MEMORY_TYPES.includes(memoryType)) {
    throw new MemoryProposalError("memory_type_invalid", "记忆类型无效");
  }
  const normalizedClaim = requiredText(claim, "记忆 claim", 600);
  const normalizedSubjectId = subjectId == null ? null : requiredText(subjectId, "subjectId", 300);
  const normalizedSourceSpeakerId = requiredText(sourceSpeakerId, "sourceSpeakerId", 300);
  const normalizedAttributionStatus = String(attributionStatus);
  if (normalizedAttributionStatus === "unresolved") {
    if (normalizedSubjectId !== null || operation !== "create") {
      throw new MemoryProposalError(
        "memory_attribution_invalid",
        "未解析主体只能创建 unresolved proposal，不能参与合并或更新",
      );
    }
  } else if (normalizedAttributionStatus !== "resolved" || !normalizedSubjectId) {
    throw new MemoryProposalError("memory_attribution_invalid", "resolved proposal 必须有 subject");
  }
  const target = normalizedTarget(existingCandidates, targetCandidateId);
  if (operation === "create" && target) {
    throw new MemoryProposalError("memory_target_invalid", "create proposal 不得引用 target");
  }
  if (operation !== "create" && !target) {
    throw new MemoryProposalError("memory_target_invalid", `${operation} proposal 缺少 target`);
  }
  if (target && String(target.subjectId ?? "") !== String(normalizedSubjectId ?? "")) {
    throw new MemoryProposalError(
      "memory_subject_mismatch",
      "不同 subject 的候选不得合并、更新或标记冲突",
    );
  }
  const normalizedConfidence = Number(confidenceMillis);
  if (!Number.isSafeInteger(normalizedConfidence) ||
      normalizedConfidence < 0 || normalizedConfidence > 1_000) {
    throw new MemoryProposalError("memory_confidence_invalid", "confidenceMillis 无效");
  }
  const normalizedSensitivity = enforceMemorySensitivity(normalizedClaim, sensitivity);
  const normalizedValidFrom = nullableDate(validFrom, "validFrom");
  const normalizedValidTo = nullableDate(validTo, "validTo");
  if (normalizedValidFrom && normalizedValidTo && normalizedValidFrom >= normalizedValidTo) {
    throw new MemoryProposalError("memory_validity_invalid", "validTo 必须晚于 validFrom");
  }
  const after = {
    claim: normalizedClaim,
    memoryType,
    sensitivity: normalizedSensitivity,
    disclosurePolicy: normalizeDisclosurePolicy(disclosurePolicy, normalizedSensitivity),
    validFrom: normalizedValidFrom,
    validTo: normalizedValidTo,
  };
  const before = snapshot(target);
  return {
    operation,
    memoryType,
    subjectId: normalizedSubjectId,
    sourceSpeakerId: normalizedSourceSpeakerId,
    sourceConversationId: requiredText(sourceConversationId, "sourceConversationId", 300),
    thoughtRunId: requiredText(thoughtRunId, "thoughtRunId", 300),
    claim: normalizedClaim,
    evidenceMessageIds: uniqueStrings(evidenceMessageIds, 20, "evidenceMessageIds"),
    confidenceMillis: normalizedConfidence,
    attributionStatus: normalizedAttributionStatus,
    sensitivity: normalizedSensitivity,
    disclosurePolicy: after.disclosurePolicy,
    validFrom: normalizedValidFrom,
    validTo: normalizedValidTo,
    targetCandidateId: target ? String(target.id) : null,
    promptVersion: requiredText(promptVersion, "promptVersion", 200),
    diff: {
      operation,
      targetCandidateId: target ? String(target.id) : null,
      before,
      after,
      changedFields: changedFields(before, after),
    },
  };
}
