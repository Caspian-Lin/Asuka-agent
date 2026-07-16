import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const reservedDatabaseNames = new Set(["postgres", "template0", "template1"]);

class ResetPrivilegesError extends Error {}

function parseDatabaseUrl(databaseUrl, variableName) {
  if (!databaseUrl || databaseUrl.includes("CHANGE_ME")) {
    throw new Error(`Set a real ${variableName} before resetting the database.`);
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${variableName} must use the postgres or postgresql protocol.`);
  }

  return url;
}

function readDatabaseName(url, variableName) {
  const encodedName = url.pathname.replace(/^\/+/, "");
  if (!encodedName) {
    throw new Error(`${variableName} must include a database name.`);
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(encodedName);
  } catch {
    throw new Error(`${variableName} contains an invalid encoded database name.`);
  }

  if (!databaseName || /[\0-\x1f\x7f]/u.test(databaseName)) {
    throw new Error(`${variableName} contains an unsafe database name.`);
  }

  return databaseName;
}

function readUsername(url) {
  let username;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error("DATABASE_URL contains an invalid encoded username.");
  }

  if (!username || /[\0-\x1f\x7f]/u.test(username)) {
    throw new Error("DATABASE_URL must include a safe target database owner username.");
  }

  return username;
}

function assertLoopback(url, variableName) {
  const hostname = url.hostname.toLowerCase();
  if (!loopbackHosts.has(hostname)) {
    throw new Error(
      `Refusing to use ${variableName} on non-loopback host "${url.hostname}".`,
    );
  }

  return hostname;
}

export function quotePostgresIdentifier(identifier) {
  if (!identifier || /[\0-\x1f\x7f]/u.test(identifier)) {
    throw new Error("Cannot quote an empty or unsafe PostgreSQL identifier.");
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}

export function buildResetConfig(databaseUrl, confirmation, adminDatabaseUrl) {
  const targetUrl = parseDatabaseUrl(databaseUrl, "DATABASE_URL");
  const hostname = assertLoopback(targetUrl, "DATABASE_URL");
  const databaseName = readDatabaseName(targetUrl, "DATABASE_URL");

  if (reservedDatabaseNames.has(databaseName.toLowerCase())) {
    throw new Error(`Refusing to reset reserved database "${databaseName}".`);
  }

  if (confirmation !== databaseName) {
    throw new Error(
      `Refusing to reset database "${databaseName}". Set CONFIRM_DATABASE_RESET=${databaseName}.`,
    );
  }

  const databaseOwner = readUsername(targetUrl);

  const maintenanceUrl = adminDatabaseUrl
    ? parseDatabaseUrl(adminDatabaseUrl, "DATABASE_ADMIN_URL")
    : new URL(targetUrl);

  assertLoopback(maintenanceUrl, "DATABASE_ADMIN_URL");
  if (adminDatabaseUrl) {
    const maintenanceDatabaseName = readDatabaseName(
      maintenanceUrl,
      "DATABASE_ADMIN_URL",
    );
    if (maintenanceDatabaseName.toLowerCase() !== "postgres") {
      throw new Error("DATABASE_ADMIN_URL must connect to the postgres maintenance database.");
    }
  }

  const targetPort = targetUrl.port || "5432";
  const maintenancePort = maintenanceUrl.port || "5432";
  if (targetPort !== maintenancePort) {
    throw new Error("DATABASE_ADMIN_URL must use the same PostgreSQL port as DATABASE_URL.");
  }

  maintenanceUrl.pathname = "/postgres";

  const hostForDisplay = hostname === "::1" ? "[::1]" : hostname;
  const portForDisplay = targetUrl.port ? `:${targetUrl.port}` : "";

  return {
    databaseName,
    databaseOwner,
    maintenanceUrl: maintenanceUrl.toString(),
    targetLabel: `${hostForDisplay}${portForDisplay}/${databaseName}`,
    targetUrl: targetUrl.toString(),
  };
}

export function validateResetPrivileges(
  role,
  existingDatabaseOwner,
  targetDatabaseOwner,
  targetOwnerExists = true,
) {
  if (!targetOwnerExists) {
    throw new Error(
      `Target database owner role "${targetDatabaseOwner}" does not exist in PostgreSQL.`,
    );
  }

  if (!role || (!role.rolsuper && !role.rolcreatedb)) {
    const roleName = role?.current_user ?? "configured reset role";
    throw new ResetPrivilegesError(
      `PostgreSQL role "${roleName}" cannot create databases. Set DATABASE_ADMIN_URL to a loopback PostgreSQL superuser URL ending in /postgres, then rerun.`,
    );
  }

  if (!role.rolsuper && role.current_user !== targetDatabaseOwner) {
    throw new ResetPrivilegesError(
      `PostgreSQL role "${role.current_user}" must be a superuser to create a database owned by "${targetDatabaseOwner}".`,
    );
  }

  if (
    existingDatabaseOwner &&
    !role.rolsuper &&
    role.current_user !== existingDatabaseOwner
  ) {
    throw new ResetPrivilegesError(
      `PostgreSQL role "${role.current_user}" cannot drop database owned by "${existingDatabaseOwner}".`,
    );
  }
}

async function readResetPrivileges(client, config) {
  const [role] = await client.unsafe(
    "select current_user, rolcreatedb, rolsuper from pg_roles where rolname = current_user",
  );
  const [database] = await client.unsafe(
    "select pg_get_userbyid(datdba) as owner_name from pg_database where datname = $1",
    [config.databaseName],
  );
  const [targetOwner] = await client.unsafe(
    "select exists(select 1 from pg_roles where rolname = $1) as owner_exists",
    [config.databaseOwner],
  );

  return {
    existingDatabaseOwner: database?.owner_name,
    role,
    targetOwnerExists: targetOwner?.owner_exists,
  };
}

async function applyMigrations(client) {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle-pg", import.meta.url)),
  });
}

function runInteractiveCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const status = signal ? `signal ${signal}` : `status ${code}`;
      reject(new Error(`${command} exited with ${status}.`));
    });
  });
}

export function buildSudoResetCommands(config) {
  const targetUrl = new URL(config.targetUrl);
  const port = targetUrl.port || "5432";
  const sudoPrefix = ["-u", "postgres", "--"];

  return [
    {
      args: [
        ...sudoPrefix,
        "dropdb",
        "--if-exists",
        "--force",
        "--maintenance-db=postgres",
        `--port=${port}`,
        "--",
        config.databaseName,
      ],
      command: "sudo",
    },
    {
      args: [
        ...sudoPrefix,
        "createdb",
        `--owner=${config.databaseOwner}`,
        "--template=template0",
        "--maintenance-db=postgres",
        `--port=${port}`,
        "--",
        config.databaseName,
      ],
      command: "sudo",
    },
  ];
}

async function resetDatabaseWithSudo(config) {
  console.warn(
    `Application role cannot rebuild ${config.targetLabel}; requesting local sudo for PostgreSQL role postgres.`,
  );

  for (const { command, args } of buildSudoResetCommands(config)) {
    try {
      await runInteractiveCommand(command, args);
    } catch (cause) {
      throw new Error(
        "Local sudo database reset failed. Configure DATABASE_ADMIN_URL for a loopback PostgreSQL superuser and rerun.",
        { cause },
      );
    }
  }
}

export async function resetDatabase({
  adminDatabaseUrl = process.env.DATABASE_ADMIN_URL,
  confirmation = process.env.CONFIRM_DATABASE_RESET,
  databaseUrl = process.env.DATABASE_URL,
  requireSsl = process.env.DATABASE_SSL === "true",
} = {}, {
  createClient = postgres,
  log = console.log,
  runMigrations = applyMigrations,
  runSudoReset = resetDatabaseWithSudo,
} = {}) {
  const config = buildResetConfig(databaseUrl, confirmation, adminDatabaseUrl);
  const postgresOptions = {
    ssl: requireSsl ? "require" : false,
    max: 1,
  };

  let requiresSudoReset = false;
  const maintenanceClient = createClient(config.maintenanceUrl, postgresOptions);
  try {
    const privileges = await readResetPrivileges(maintenanceClient, config);
    try {
      validateResetPrivileges(
        privileges.role,
        privileges.existingDatabaseOwner,
        config.databaseOwner,
        privileges.targetOwnerExists,
      );
    } catch (error) {
      if (adminDatabaseUrl || !(error instanceof ResetPrivilegesError)) {
        throw error;
      }
      requiresSudoReset = true;
    }

    if (!requiresSudoReset) {
      console.warn(`Permanently resetting local PostgreSQL database ${config.targetLabel}.`);

      const quotedDatabaseName = quotePostgresIdentifier(config.databaseName);
      const quotedDatabaseOwner = quotePostgresIdentifier(config.databaseOwner);
      await maintenanceClient.unsafe(
        `DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`,
      );
      await maintenanceClient.unsafe(
        `CREATE DATABASE ${quotedDatabaseName} OWNER ${quotedDatabaseOwner} TEMPLATE template0`,
      );
    }
  } finally {
    await maintenanceClient.end();
  }

  if (requiresSudoReset) {
    await runSudoReset(config);
  }

  const targetClient = createClient(config.targetUrl, postgresOptions);
  try {
    await runMigrations(targetClient);
  } finally {
    await targetClient.end();
  }

  log(`Local PostgreSQL database ${config.targetLabel} rebuilt from migrations.`);
}

const isMainModule =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  await resetDatabase();
}
