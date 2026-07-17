import { createHash } from "node:crypto";

import {
  MEMORY_SENSITIVITIES,
  normalizeDisclosurePolicy,
} from "./memory-proposal.mjs";

const weakTokens = new Set([
  "一个", "什么", "怎么", "我们", "你们", "他们", "用户", "这个", "那个",
  "the", "and", "are", "was", "were", "what", "how", "user",
]);

export class MemoryRetrievalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemoryRetrievalError";
    this.code = code;
  }
}

function stableHash(value) {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(value),
  ).digest("hex");
}

function lexicalTokens(value) {
  const normalized = String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
  const tokens = [];
  for (const word of normalized.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (!weakTokens.has(word)) tokens.push(word);
  }
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (sequence.length === 1) tokens.push(sequence);
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const token = sequence.slice(index, index + 2);
      if (!weakTokens.has(token)) tokens.push(token);
    }
  }
  return new Set(tokens);
}

function lexicalScore(queryTokens, memory) {
  const memoryTokens = lexicalTokens(`${memory.title ?? ""}\n${memory.claim ?? memory.content ?? ""}`);
  const overlap = [...queryTokens].filter((token) => memoryTokens.has(token)).length;
  if (overlap === 0) return { matchedTokens: 0, relevanceMillis: 0 };
  const denominator = Math.sqrt(Math.max(1, queryTokens.size) * Math.max(1, memoryTokens.size));
  return {
    matchedTokens: overlap,
    relevanceMillis: Math.min(1_000, Math.round((overlap / denominator) * 1_000)),
  };
}

function permissionFor(sensitivity) {
  return `memory:${sensitivity}:read`;
}

function disclosureDecision(memory, request, now) {
  if (String(memory.agentId) !== String(request.agentId)) return "agent_mismatch";
  if (memory.status !== "active") return "not_active";
  if (memory.attributionStatus !== "resolved" || !memory.subjectId) return "subject_unresolved";
  const validFrom = memory.validFrom == null ? null : new Date(memory.validFrom);
  const validTo = memory.validTo == null ? null : new Date(memory.validTo);
  if (validFrom && validFrom > now) return "not_yet_valid";
  if (validTo && validTo <= now) return "expired";
  const sensitivity = String(memory.sensitivity ?? "normal");
  if (!MEMORY_SENSITIVITIES.includes(sensitivity)) return "sensitivity_invalid";
  const permissions = new Set(request.permissions ?? []);
  if (sensitivity !== "public" && !permissions.has(permissionFor(sensitivity))) {
    return "permission_denied";
  }
  const policy = normalizeDisclosurePolicy(memory.disclosurePolicy, sensitivity);
  const participantIds = new Set((request.participantIds ?? []).map(String));
  const subjectPresent = participantIds.has(String(memory.subjectId));
  if (!subjectPresent && String(memory.subjectId) !== String(request.agentId)) {
    return "subject_absent";
  }
  if (policy.scope === "public") return "allowed";
  if (policy.scope === "subject") return "allowed";
  if (policy.scope === "private") {
    return request.conversationType === "private" ? "allowed" : "private_only";
  }
  if (policy.conversationIds.includes(String(request.conversationId))) return "allowed";
  if (policy.participantIds.some((participantId) => participantIds.has(participantId))) {
    return "allowed";
  }
  return "allowlist_denied";
}

function recalledMemory(memory, relevanceMillis) {
  return {
    memoryId: String(memory.id),
    title: memory.title == null ? null : String(memory.title),
    content: String(memory.claim ?? memory.content),
    subjectId: String(memory.subjectId),
    sourceSpeakerId: memory.sourceSpeakerId == null ? null : String(memory.sourceSpeakerId),
    sourceConversationId: memory.sourceConversationId == null
      ? null
      : String(memory.sourceConversationId),
    thoughtRunId: memory.thoughtRunId == null ? null : String(memory.thoughtRunId),
    evidenceIds: (memory.evidenceMessageIds ?? memory.evidenceIds ?? []).map(String),
    sensitivity: String(memory.sensitivity ?? "normal"),
    disclosurePolicy: normalizeDisclosurePolicy(
      memory.disclosurePolicy,
      String(memory.sensitivity ?? "normal"),
    ),
    validFrom: memory.validFrom == null ? null : new Date(memory.validFrom).toISOString(),
    validTo: memory.validTo == null ? null : new Date(memory.validTo).toISOString(),
    relevance: relevanceMillis / 1_000,
    relevanceMillis,
    disclosureDecision: "allowed",
    meetsThreshold: true,
  };
}

export function retrieveGlobalMemories({
  query,
  memories,
  request,
  limit = 4,
  minimumRelevanceMillis = 160,
  now = new Date(),
}) {
  const normalizedQuery = String(query ?? "").trim();
  if (!normalizedQuery || normalizedQuery.length > 2_000) {
    throw new MemoryRetrievalError("memory_query_invalid", "记忆查询不能为空且不能超过 2000 字符");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new MemoryRetrievalError("memory_limit_invalid", "记忆召回 limit 无效");
  }
  if (!Number.isSafeInteger(minimumRelevanceMillis) ||
      minimumRelevanceMillis < 1 || minimumRelevanceMillis > 1_000) {
    throw new MemoryRetrievalError("memory_threshold_invalid", "记忆召回阈值无效");
  }
  const queryTokens = lexicalTokens(normalizedQuery);
  const decisions = [];
  const eligible = [];
  for (const memory of memories ?? []) {
    const reason = disclosureDecision(memory, request, now);
    if (reason !== "allowed") {
      decisions.push({
        memoryId: String(memory.id),
        decision: "filtered",
        reason,
        relevanceMillis: null,
        rank: null,
      });
      continue;
    }
    const score = lexicalScore(queryTokens, memory);
    if (score.relevanceMillis < minimumRelevanceMillis) {
      decisions.push({
        memoryId: String(memory.id),
        decision: "below_threshold",
        reason: score.matchedTokens === 0 ? "no_lexical_match" : "relevance_below_threshold",
        relevanceMillis: score.relevanceMillis,
        rank: null,
      });
      continue;
    }
    eligible.push({ memory, relevanceMillis: score.relevanceMillis });
  }
  eligible.sort((left, right) => (
    right.relevanceMillis - left.relevanceMillis ||
    String(left.memory.id).localeCompare(String(right.memory.id))
  ));
  const selected = eligible.slice(0, limit);
  for (const [rank, entry] of selected.entries()) {
    decisions.push({
      memoryId: String(entry.memory.id),
      decision: "returned",
      reason: "allowed_and_relevant",
      relevanceMillis: entry.relevanceMillis,
      rank: rank + 1,
    });
  }
  for (const entry of eligible.slice(limit)) {
    decisions.push({
      memoryId: String(entry.memory.id),
      decision: "below_threshold",
      reason: "limit_exceeded",
      relevanceMillis: entry.relevanceMillis,
      rank: null,
    });
  }
  return {
    memories: selected.map((entry) => recalledMemory(entry.memory, entry.relevanceMillis)),
    audit: {
      query: normalizedQuery,
      queryHash: stableHash(normalizedQuery),
      requestedLimit: limit,
      minimumRelevanceMillis,
      candidateCount: (memories ?? []).length,
      filteredCount: decisions.filter((decision) => decision.decision === "filtered").length,
      returnedCount: selected.length,
      decisions,
    },
  };
}

export function createGlobalMemoryRetrievalPort({
  loadActiveMemories,
  recordAudit,
  clock = () => new Date(),
}) {
  if (typeof loadActiveMemories !== "function" || typeof recordAudit !== "function") {
    throw new MemoryRetrievalError(
      "memory_port_invalid",
      "global memory retrieval port 需要 loadActiveMemories 与 recordAudit",
    );
  }
  return Object.freeze({
    async retrieve(input) {
      const memories = await loadActiveMemories({
        agentId: input.request.agentId,
        participantIds: input.request.participantIds,
      });
      const result = retrieveGlobalMemories({
        ...input,
        memories,
        now: clock(),
      });
      await recordAudit({
        requestId: String(input.requestId),
        thoughtRunId: input.thoughtRunId == null ? null : String(input.thoughtRunId),
        conversationId: String(input.request.conversationId),
        agentId: String(input.request.agentId),
        mode: String(input.mode ?? "passive"),
        ...result.audit,
      });
      return result;
    },
  });
}
