import { getD1, getDb } from ".";

let schemaReady: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'shadow',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'web',
    external_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    citations_json TEXT NOT NULL DEFAULT '[]',
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    event_type TEXT NOT NULL,
    source_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    correlation_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_entities (
    event_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT 'mentions',
    PRIMARY KEY (event_id, entity_id, relation)
  )`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate',
    source_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    importance REAL NOT NULL DEFAULT 0.5,
    access_scope TEXT NOT NULL DEFAULT 'private',
    sensitivity TEXT NOT NULL DEFAULT 'normal',
    valid_from TEXT,
    valid_to TEXT,
    recorded_at TEXT NOT NULL,
    superseded_at TEXT,
    retrieve_count INTEGER NOT NULL DEFAULT 0,
    helpful_use_count INTEGER NOT NULL DEFAULT 0,
    last_retrieved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memory_evidence (
    memory_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    evidence_role TEXT NOT NULL DEFAULT 'supports',
    PRIMARY KEY (memory_id, event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS memory_links (
    source_memory_id TEXT NOT NULL,
    target_memory_id TEXT NOT NULL,
    link_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_memory_id, target_memory_id, link_type)
  )`,
  `CREATE TABLE IF NOT EXISTS thoughts (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL,
    novelty REAL NOT NULL,
    urgency REAL NOT NULL,
    expected_value REAL NOT NULL,
    risk REAL NOT NULL,
    decision TEXT NOT NULL DEFAULT 'shadow',
    human_label TEXT,
    label_note TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evaluation_cases (
    id TEXT PRIMARY KEY,
    suite TEXT NOT NULL,
    category TEXT NOT NULL,
    prompt TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evaluation_runs (
    id TEXT PRIMARY KEY,
    suite TEXT NOT NULL,
    status TEXT NOT NULL,
    summary_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS evaluation_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    predicted_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    score REAL NOT NULL,
    passed INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, case_id)
  )`,
  `CREATE TABLE IF NOT EXISTS agent_settings (
    agent_id TEXT PRIMARY KEY,
    shadow_mode INTEGER NOT NULL DEFAULT 1,
    quiet_hours_start TEXT NOT NULL DEFAULT '23:00',
    quiet_hours_end TEXT NOT NULL DEFAULT '08:00',
    daily_proactive_budget INTEGER NOT NULL DEFAULT 3,
    model_mode TEXT NOT NULL DEFAULT 'deterministic_mvp',
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS conversations_agent_idx ON conversations(agent_id)`,
  `CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS events_conversation_time_idx ON events(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS events_type_idx ON events(event_type)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS entities_name_type_uidx ON entities(canonical_name, entity_type)`,
  `CREATE INDEX IF NOT EXISTS event_entities_entity_idx ON event_entities(entity_id)`,
  `CREATE INDEX IF NOT EXISTS memories_agent_status_idx ON memories(agent_id, status)`,
  `CREATE INDEX IF NOT EXISTS memories_type_idx ON memories(memory_type)`,
  `CREATE INDEX IF NOT EXISTS memory_evidence_event_idx ON memory_evidence(event_id)`,
  `CREATE INDEX IF NOT EXISTS thoughts_conversation_time_idx ON thoughts(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS evaluation_cases_suite_idx ON evaluation_cases(suite)`,
  `CREATE INDEX IF NOT EXISTS evaluation_runs_time_idx ON evaluation_runs(started_at)`,
  `CREATE INDEX IF NOT EXISTS evaluation_results_run_idx ON evaluation_results(run_id)`,
];

export async function ensureSchema() {
  const d1 = getD1();
  schemaReady ??= d1.batch(
    schemaStatements.map((statement) => d1.prepare(statement)),
  ).then(() => undefined);
  await schemaReady;
  return getDb();
}

export function resetSchemaReadyForTests() {
  schemaReady = null;
}
