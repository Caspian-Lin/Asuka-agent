const REDACTED_CONTENT = "[敏感内容已按本地 Trace 权限脱敏]";
const sensitiveLevels = new Set(["sensitive", "restricted"]);
const secretKeys = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "encrypted_api_key",
  "password",
  "secret",
]);

export class ThoughtTraceRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ThoughtTraceRequestError";
    this.code = code;
    this.status = status;
  }
}

export function resolveThoughtTraceAccess({ configuredAccess, host }) {
  const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
  return configuredAccess === "full" && loopback.has(String(host))
    ? "full"
    : "redacted";
}

function sensitivityOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const direct = value.sensitivity;
  const metadata = value.metadata?.sensitivity;
  return String(direct ?? metadata ?? "");
}

function collectSensitiveStrings(value, collected) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return;
    try {
      collectSensitiveStrings(JSON.parse(trimmed), collected);
    } catch {
      // Ordinary prose can start with punctuation; it is not structured trace data.
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectSensitiveStrings(item, collected));
    return;
  }
  if (sensitiveLevels.has(sensitivityOf(value))) {
    for (const key of ["claim", "content", "draft", "title"]) {
      if (typeof value[key] === "string" && value[key].trim()) {
        collected.add(value[key]);
      }
    }
  }
  Object.values(value).forEach((item) => collectSensitiveStrings(item, collected));
}

function scrubString(value, sensitiveStrings) {
  let scrubbed = value;
  for (const sensitive of sensitiveStrings) {
    scrubbed = scrubbed.split(sensitive).join(REDACTED_CONTENT);
  }
  const trimmed = scrubbed.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return scrubbed;
  try {
    const parsed = JSON.parse(trimmed);
    const scrubbedPayload = scrubValue(parsed, sensitiveStrings);
    return JSON.stringify(scrubbedPayload) === JSON.stringify(parsed)
      ? scrubbed
      : JSON.stringify(scrubbedPayload);
  } catch {
    return scrubbed;
  }
}

function scrubValue(value, sensitiveStrings) {
  if (typeof value === "string") return scrubString(value, sensitiveStrings);
  if (!value || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, sensitiveStrings));
  const scrubbed = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretKeys.has(key.toLowerCase())) {
      scrubbed[key] = "[secret redacted]";
    } else {
      scrubbed[key] = scrubValue(item, sensitiveStrings);
    }
  }
  if (sensitiveLevels.has(sensitivityOf(value)) && scrubbed.metadata) {
    scrubbed.metadata = {
      ...scrubbed.metadata,
      redacted: true,
      redactionReason: "local_trace_permission_required",
    };
  }
  return scrubbed;
}

function traceAccess(access) {
  return {
    scope: "local_operator",
    sensitiveContent: access,
    secrets: "always_redacted",
  };
}

function redactList(rows, access) {
  return rows.map((row) => {
    const scrubbed = scrubValue(row, []);
    if (access === "full" || !row.contains_sensitive_content) return scrubbed;
    return { ...scrubbed, summary: REDACTED_CONTENT };
  });
}

function redactDetail(detail, access) {
  const sensitiveStrings = new Set();
  if (access !== "full") collectSensitiveStrings(detail, sensitiveStrings);
  return {
    ...scrubValue(detail, [...sensitiveStrings].sort((left, right) => right.length - left.length)),
    traceAccess: traceAccess(access),
  };
}

export function createThoughtTraceService({ repository, access = "redacted" }) {
  if (!repository?.listRuns || !repository?.getRun) {
    throw new TypeError("thought trace repository is required");
  }
  const normalizedAccess = access === "full" ? "full" : "redacted";
  return {
    async listRuns() {
      const rows = await repository.listRuns();
      return {
        thoughtRuns: redactList(rows, normalizedAccess),
        traceAccess: traceAccess(normalizedAccess),
      };
    },

    async getRun(thoughtRunId) {
      const normalizedId = String(thoughtRunId ?? "").trim();
      if (!normalizedId) {
        throw new ThoughtTraceRequestError(
          "thought_run_required",
          "缺少思绪运行 ID",
        );
      }
      const detail = await repository.getRun(normalizedId);
      if (!detail) {
        throw new ThoughtTraceRequestError(
          "thought_run_not_found",
          "思绪运行不存在",
          404,
        );
      }
      return redactDetail(detail, normalizedAccess);
    },
  };
}

export { REDACTED_CONTENT };
