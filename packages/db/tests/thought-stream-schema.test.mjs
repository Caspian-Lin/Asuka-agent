import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const snapshotUrl = new URL("../drizzle-pg/meta/0006_snapshot.json", import.meta.url);
const migrationUrl = new URL("../drizzle-pg/0006_glorious_rictor.sql", import.meta.url);

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

test("internal-development migration does not backfill legacy test rows", async () => {
  const migration = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(migration, /\b(?:UPDATE|INSERT INTO)\s+"?(?:messages|thought_runs)"?/i);
});
