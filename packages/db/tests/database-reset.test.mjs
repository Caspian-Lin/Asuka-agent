import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetConfig,
  quotePostgresIdentifier,
} from "../scripts/reset.mjs";

test("database reset accepts an exactly confirmed loopback target", () => {
  const config = buildResetConfig(
    "postgresql://asuka:secret@127.0.0.1:5433/asuka_agent?application_name=tests",
    "asuka_agent",
  );

  assert.equal(config.databaseName, "asuka_agent");
  assert.equal(config.targetLabel, "127.0.0.1:5433/asuka_agent");
  assert.doesNotMatch(config.targetLabel, /secret|asuka:/);

  const maintenanceUrl = new URL(config.maintenanceUrl);
  assert.equal(maintenanceUrl.pathname, "/postgres");
  assert.equal(maintenanceUrl.searchParams.get("application_name"), "tests");
});

test("database reset accepts every supported loopback spelling", () => {
  for (const url of [
    "postgres://localhost/asuka_agent",
    "postgres://127.0.0.1/asuka_agent",
    "postgres://[::1]/asuka_agent",
  ]) {
    assert.doesNotThrow(() => buildResetConfig(url, "asuka_agent"));
  }
});

test("database reset refuses remote and lookalike hosts", () => {
  for (const host of ["db.example.com", "localhost.example.com", "192.168.1.20"]) {
    assert.throws(
      () => buildResetConfig(`postgres://user:password@${host}/asuka_agent`, "asuka_agent"),
      /non-loopback host/,
    );
  }
});

test("database reset requires the exact database name as confirmation", () => {
  const databaseUrl = "postgres://localhost/asuka_agent";

  assert.throws(() => buildResetConfig(databaseUrl), /CONFIRM_DATABASE_RESET=asuka_agent/);
  assert.throws(
    () => buildResetConfig(databaseUrl, "ASUKA_AGENT"),
    /CONFIRM_DATABASE_RESET=asuka_agent/,
  );
});

test("database reset refuses maintenance and template databases", () => {
  for (const databaseName of ["postgres", "template0", "template1", "POSTGRES"]) {
    assert.throws(
      () => buildResetConfig(`postgres://localhost/${databaseName}`, databaseName),
      /reserved database/,
    );
  }
});

test("database reset refuses missing, placeholder, malformed, and unsafe targets", () => {
  assert.throws(() => buildResetConfig(undefined, "asuka_agent"), /real DATABASE_URL/);
  assert.throws(
    () => buildResetConfig("postgres://localhost/CHANGE_ME", "CHANGE_ME"),
    /real DATABASE_URL/,
  );
  assert.throws(() => buildResetConfig("not a URL", "asuka_agent"), /valid PostgreSQL URL/);
  assert.throws(
    () => buildResetConfig("mysql://localhost/asuka_agent", "asuka_agent"),
    /postgres or postgresql protocol/,
  );
  assert.throws(() => buildResetConfig("postgres://localhost", ""), /database name/);
  assert.throws(
    () => buildResetConfig("postgres://localhost/asuka%00agent", "asuka\0agent"),
    /unsafe database name/,
  );
});

test("PostgreSQL identifiers are quoted without allowing statement injection", () => {
  assert.equal(quotePostgresIdentifier("asuka_agent"), '"asuka_agent"');
  assert.equal(
    quotePostgresIdentifier('asuka"; DROP DATABASE postgres; --'),
    '"asuka""; DROP DATABASE postgres; --"',
  );
  assert.throws(() => quotePostgresIdentifier("unsafe\nname"), /unsafe PostgreSQL identifier/);
});
