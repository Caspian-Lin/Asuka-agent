import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResetConfig,
  quotePostgresIdentifier,
  resetDatabase,
  validateResetPrivileges,
} from "../scripts/reset.mjs";

test("database reset accepts an exactly confirmed loopback target", () => {
  const config = buildResetConfig(
    "postgresql://asuka:secret@127.0.0.1:5433/asuka_agent?application_name=tests",
    "asuka_agent",
  );

  assert.equal(config.databaseName, "asuka_agent");
  assert.equal(config.databaseOwner, "asuka");
  assert.equal(config.targetLabel, "127.0.0.1:5433/asuka_agent");
  assert.doesNotMatch(config.targetLabel, /secret|asuka:/);

  const maintenanceUrl = new URL(config.maintenanceUrl);
  assert.equal(maintenanceUrl.pathname, "/postgres");
  assert.equal(maintenanceUrl.searchParams.get("application_name"), "tests");
});

test("database reset accepts a loopback administrator on the same server", () => {
  const config = buildResetConfig(
    "postgres://asuka_agent:app@127.0.0.1:5433/asuka_agent",
    "asuka_agent",
    "postgres://postgres:admin@localhost:5433/postgres",
  );

  const maintenanceUrl = new URL(config.maintenanceUrl);
  assert.equal(maintenanceUrl.username, "postgres");
  assert.equal(maintenanceUrl.pathname, "/postgres");
  assert.doesNotMatch(config.targetLabel, /admin|postgres/);
});

test("database reset refuses an unsafe or different administrator server", () => {
  const targetUrl = "postgres://asuka_agent:app@127.0.0.1:5432/asuka_agent";

  assert.throws(
    () => buildResetConfig(
      targetUrl,
      "asuka_agent",
      "postgres://postgres:admin@db.example.com:5432/postgres",
    ),
    /non-loopback host/,
  );
  assert.throws(
    () => buildResetConfig(
      targetUrl,
      "asuka_agent",
      "postgres://postgres:admin@localhost:5433/postgres",
    ),
    /same PostgreSQL port/,
  );
  assert.throws(
    () => buildResetConfig(
      targetUrl,
      "asuka_agent",
      "postgres://postgres:admin@localhost:5432/template1",
    ),
    /postgres maintenance database/,
  );
});

test("database reset accepts every supported loopback spelling", () => {
  for (const url of [
    "postgres://asuka_agent@localhost/asuka_agent",
    "postgres://asuka_agent@127.0.0.1/asuka_agent",
    "postgres://asuka_agent@[::1]/asuka_agent",
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
    () => buildResetConfig("postgres://localhost/asuka_agent", "asuka_agent"),
    /owner username/,
  );
  assert.throws(
    () => buildResetConfig("postgres://localhost/asuka%00agent", "asuka\0agent"),
    /unsafe database name/,
  );
});

test("database reset validates create, owner, and drop privileges", () => {
  assert.throws(
    () => validateResetPrivileges(
      { current_user: "asuka_agent", rolcreatedb: false, rolsuper: false },
      "asuka_agent",
      "asuka_agent",
    ),
    /cannot create databases/,
  );
  assert.throws(
    () => validateResetPrivileges(
      { current_user: "postgres", rolcreatedb: true, rolsuper: true },
      undefined,
      "missing_owner",
      false,
    ),
    /does not exist/,
  );
  assert.throws(
    () => validateResetPrivileges(
      { current_user: "db_admin", rolcreatedb: true, rolsuper: false },
      "asuka_agent",
      "asuka_agent",
    ),
    /must be a superuser/,
  );
  assert.throws(
    () => validateResetPrivileges(
      { current_user: "asuka_agent", rolcreatedb: true, rolsuper: false },
      "another_owner",
      "asuka_agent",
    ),
    /cannot drop database/,
  );
  assert.doesNotThrow(() => validateResetPrivileges(
    { current_user: "postgres", rolcreatedb: true, rolsuper: true },
    "asuka_agent",
    "asuka_agent",
  ));
});

test("database reset checks create privileges before dropping the target", async () => {
  const statements = [];
  const maintenanceClient = {
    async unsafe(statement) {
      statements.push(statement);
      if (statement.includes("rolcreatedb")) {
        return [{ current_user: "asuka_agent", rolcreatedb: false, rolsuper: false }];
      }
      if (statement.includes("pg_database")) {
        return [{ owner_name: "asuka_agent" }];
      }
      if (statement.includes("owner_exists")) {
        return [{ owner_exists: true }];
      }
      throw new Error(`Unexpected statement: ${statement}`);
    },
    async end() {
      statements.push("end");
    },
  };

  await assert.rejects(
    () => resetDatabase(
      {
        confirmation: "asuka_agent",
        databaseUrl: "postgres://asuka_agent:app@localhost/asuka_agent",
      },
      {
        createClient() {
          return maintenanceClient;
        },
        async runMigrations() {
          throw new Error("Migrations must not run without create privileges.");
        },
      },
    ),
    /cannot create databases/,
  );

  assert.equal(statements.some((statement) => statement.startsWith("DROP DATABASE")), false);
  assert.deepEqual(statements.at(-1), "end");
});

test("PostgreSQL identifiers are quoted without allowing statement injection", () => {
  assert.equal(quotePostgresIdentifier("asuka_agent"), '"asuka_agent"');
  assert.equal(
    quotePostgresIdentifier('asuka"; DROP DATABASE postgres; --'),
    '"asuka""; DROP DATABASE postgres; --"',
  );
  assert.throws(() => quotePostgresIdentifier("unsafe\nname"), /unsafe PostgreSQL identifier/);
});
