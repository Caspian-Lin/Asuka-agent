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
