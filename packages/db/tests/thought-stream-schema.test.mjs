import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const snapshotUrl = new URL("../drizzle-pg/meta/0006_snapshot.json", import.meta.url);
const migrationUrl = new URL("../drizzle-pg/0006_glorious_rictor.sql", import.meta.url);
const primarySnapshotUrl = new URL("../drizzle-pg/meta/0007_snapshot.json", import.meta.url);
const primaryMigrationUrl = new URL("../drizzle-pg/0007_keen_gravity.sql", import.meta.url);
const compilerSnapshotUrl = new URL("../drizzle-pg/meta/0008_snapshot.json", import.meta.url);
const compilerMigrationUrl = new URL(
  "../drizzle-pg/0008_lethal_radioactive_man.sql",
  import.meta.url,
);
const outboundSnapshotUrl = new URL("../drizzle-pg/meta/0009_snapshot.json", import.meta.url);
const outboundMigrationUrl = new URL("../drizzle-pg/0009_famous_legion.sql", import.meta.url);
const compressionSnapshotUrl = new URL("../drizzle-pg/meta/0010_snapshot.json", import.meta.url);
const compressionMigrationUrl = new URL("../drizzle-pg/0010_brief_hulk.sql", import.meta.url);
const memorySnapshotUrl = new URL("../drizzle-pg/meta/0011_snapshot.json", import.meta.url);
const memoryMigrationUrl = new URL("../drizzle-pg/0011_boring_justice.sql", import.meta.url);
const schedulerSnapshotUrl = new URL("../drizzle-pg/meta/0012_snapshot.json", import.meta.url);
const schedulerMigrationUrl = new URL(
  "../drizzle-pg/0012_regular_wendell_rand.sql",
  import.meta.url,
);

test("thought stream migration exposes the recoverable v2 contracts", async () => {
  const snapshot = JSON.parse(await readFile(snapshotUrl, "utf8"));
  const tables = snapshot.tables;

  const stream = tables["public.thought_streams"];
  const epoch = tables["public.thought_stream_epochs"];
  const run = tables["public.thought_runs"];
  const proposal = tables["public.action_proposals"];

  assert.ok(stream);
  assert.ok(epoch);
  assert.ok(proposal);
  assert.deepEqual(
    ["agent_id", "conversation_id", "current_epoch_ordinal", "version"].map(
      (column) => stream.columns[column].notNull,
    ),
    [true, true, true, true],
  );
  assert.ok(stream.indexes.thought_streams_agent_conversation_uidx.isUnique);
  assert.ok(epoch.indexes.thought_stream_epochs_stream_ordinal_uidx.isUnique);
  assert.ok(run.indexes.thought_runs_stream_turn_uidx.isUnique);
  assert.ok(proposal.indexes.action_proposals_idempotency_uidx.isUnique);
  assert.equal(tables["public.messages"].columns.author_kind.notNull, true);
  assert.equal(tables["public.messages"].columns.direction.notNull, true);
  assert.equal(tables["public.llm_calls"].columns.purpose.notNull, true);
});

test("primary generation has immutable output and resumable chunk state", async () => {
  const snapshot = JSON.parse(await readFile(primarySnapshotUrl, "utf8"));
  const columns = snapshot.tables["public.thought_runs"].columns;
  assert.equal(columns.primary_state.notNull, true);
  assert.equal(columns.primary_output.notNull, false);
  assert.equal(columns.primary_output_hash.notNull, false);
  assert.equal(columns.primary_prompt_version.notNull, false);
  assert.equal(columns.primary_stop_reason.notNull, false);
  assert.equal(columns.primary_completed_at.notNull, false);

  const migration = await readFile(primaryMigrationUrl, "utf8");
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO)\s+"?thought_runs"?/i);
});

test("compiler and bounded revision checkpoints are persisted without backfill", async () => {
  const snapshot = JSON.parse(await readFile(compilerSnapshotUrl, "utf8"));
  const columns = snapshot.tables["public.thought_runs"].columns;
  assert.equal(columns.compiler_state.notNull, true);
  assert.equal(columns.compiler_attempt_count.notNull, true);
  assert.equal(columns.revision_count.notNull, true);
  assert.equal(columns.compiler_status.notNull, false);
  assert.equal(columns.compiled_at.notNull, false);

  const migration = await readFile(compilerMigrationUrl, "utf8");
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO)\s+"?thought_runs"?/i);
});

test("internal-development migration does not backfill legacy test rows", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO)\s+"?(?:messages|thought_runs)"?/i);
});

test("autonomous speech uses a durable decision and single outbound queue", async () => {
  const snapshot = JSON.parse(await readFile(outboundSnapshotUrl, "utf8"));
  const tables = snapshot.tables;
  const policy = tables["public.outbound_policies"];
  const decision = tables["public.speech_decisions"];
  const delivery = tables["public.outbound_deliveries"];

  assert.ok(policy);
  assert.ok(decision);
  assert.ok(delivery);
  assert.equal(policy.columns.enabled.default, false);
  assert.ok(decision.indexes.speech_decisions_proposal_uidx.isUnique);
  assert.ok(delivery.indexes.outbound_deliveries_decision_uidx.isUnique);
  assert.ok(delivery.indexes.outbound_deliveries_echo_uidx.isUnique);

  const migration = await readFile(outboundMigrationUrl, "utf8");
  assert.match(migration, /'agent-asuka', false, 'Asia\/Shanghai'/);
  assert.doesNotMatch(migration, /UPDATE\s+"?(?:messages|thought_runs|action_proposals)"?/i);
});

test("compression records provider cache usage without migrating old thought data", async () => {
  const snapshot = JSON.parse(await readFile(compressionSnapshotUrl, "utf8"));
  const tables = snapshot.tables;
  assert.equal(
    tables["public.llm_calls"].columns.cached_input_tokens.notNull,
    false,
  );
  assert.equal(
    tables["public.thought_stream_epochs"].columns.cached_input_tokens.notNull,
    false,
  );
  const migration = await readFile(compressionMigrationUrl, "utf8");
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO)\s+"?(?:llm_calls|thought_stream_epochs)"?/i);
});

test("global memory proposals and retrieval decisions remain auditable", async () => {
  const snapshot = JSON.parse(await readFile(memorySnapshotUrl, "utf8"));
  const tables = snapshot.tables;
  const candidate = tables["public.memory_candidates"];
  const audit = tables["public.memory_retrieval_audits"];
  const item = tables["public.memory_retrieval_items"];

  assert.ok(audit);
  assert.ok(item);
  assert.equal(candidate.columns.sensitivity.notNull, true);
  assert.equal(candidate.columns.disclosure_policy.notNull, true);
  assert.equal(candidate.columns.diff.notNull, true);
  assert.ok(candidate.indexes.memory_candidates_agent_subject_idx);
  assert.equal(audit.columns.thought_run_id.notNull, true);
  assert.equal(audit.columns.returned_count.notNull, true);
  assert.ok(item.foreignKeys.memory_retrieval_items_memory_candidate_id_memory_candidates_id_fk);

  const migration = await readFile(memoryMigrationUrl, "utf8");
  assert.doesNotMatch(
    migration,
    /\b(?:UPDATE|INSERT INTO)\s+"?(?:memory_candidates|thought_runs)"?/i,
  );
});

test("manual scheduler scope is durable and only cognition seeds become configurable", async () => {
  const snapshot = JSON.parse(await readFile(schedulerSnapshotUrl, "utf8"));
  const parameters = snapshot.tables["public.job_runs"].columns.parameters;
  assert.equal(parameters.notNull, true);
  assert.equal(parameters.default, "'{}'::jsonb");

  const migration = await readFile(schedulerMigrationUrl, "utf8");
  assert.match(migration, /"job_type" = 'thought_tick'/);
  assert.match(migration, /"job_type" = 'memory_consolidation'/);
  assert.match(migration, /"job_type" NOT IN \('thought_tick', 'memory_consolidation'\)/);
  assert.doesNotMatch(migration, /"job_type" = '(?:qq_ingress|inbound_projection)'/);
});
