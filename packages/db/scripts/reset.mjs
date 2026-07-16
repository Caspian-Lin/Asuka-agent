import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const reservedDatabaseNames = new Set(["postgres", "template0", "template1"]);

function parseDatabaseUrl(databaseUrl) {
  if (!databaseUrl || databaseUrl.includes("CHANGE_ME")) {
    throw new Error("Set a real DATABASE_URL in .env before resetting the database.");
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }

  return url;
}

function readDatabaseName(url) {
  const encodedName = url.pathname.replace(/^\/+/, "");
  if (!encodedName) {
    throw new Error("DATABASE_URL must include a target database name.");
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(encodedName);
  } catch {
    throw new Error("DATABASE_URL contains an invalid encoded database name.");
  }

  if (!databaseName || /[\0-\x1f\x7f]/u.test(databaseName)) {
    throw new Error("DATABASE_URL contains an unsafe database name.");
  }

  return databaseName;
}

export function quotePostgresIdentifier(identifier) {
  if (!identifier || /[\0-\x1f\x7f]/u.test(identifier)) {
    throw new Error("Cannot quote an empty or unsafe PostgreSQL identifier.");
  }

  return `"${identifier.replaceAll('"', '""')}"`;
}

export function buildResetConfig(databaseUrl, confirmation) {
  const targetUrl = parseDatabaseUrl(databaseUrl);
  const hostname = targetUrl.hostname.toLowerCase();
  const databaseName = readDatabaseName(targetUrl);

  if (!loopbackHosts.has(hostname)) {
    throw new Error(
      `Refusing to reset PostgreSQL on non-loopback host "${targetUrl.hostname}".`,
    );
  }

  if (reservedDatabaseNames.has(databaseName.toLowerCase())) {
    throw new Error(`Refusing to reset reserved database "${databaseName}".`);
  }

  if (confirmation !== databaseName) {
    throw new Error(
      `Refusing to reset database "${databaseName}". Set CONFIRM_DATABASE_RESET=${databaseName}.`,
    );
  }

  const maintenanceUrl = new URL(targetUrl);
  maintenanceUrl.pathname = "/postgres";

  const hostForDisplay = hostname === "::1" ? "[::1]" : hostname;
  const portForDisplay = targetUrl.port ? `:${targetUrl.port}` : "";

  return {
    databaseName,
    maintenanceUrl: maintenanceUrl.toString(),
    targetLabel: `${hostForDisplay}${portForDisplay}/${databaseName}`,
    targetUrl: targetUrl.toString(),
  };
}

export async function resetDatabase({
  confirmation = process.env.CONFIRM_DATABASE_RESET,
  databaseUrl = process.env.DATABASE_URL,
  requireSsl = process.env.DATABASE_SSL === "true",
} = {}) {
  const config = buildResetConfig(databaseUrl, confirmation);
  const postgresOptions = {
    ssl: requireSsl ? "require" : false,
    max: 1,
  };

  console.warn(`Permanently resetting local PostgreSQL database ${config.targetLabel}.`);

  const maintenanceClient = postgres(config.maintenanceUrl, postgresOptions);
  try {
    const quotedDatabaseName = quotePostgresIdentifier(config.databaseName);
    await maintenanceClient.unsafe(
      `DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`,
    );
    await maintenanceClient.unsafe(
      `CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`,
    );
  } finally {
    await maintenanceClient.end();
  }

  const targetClient = postgres(config.targetUrl, postgresOptions);
  try {
    await migrate(drizzle(targetClient), {
      migrationsFolder: fileURLToPath(new URL("../drizzle-pg", import.meta.url)),
    });
  } finally {
    await targetClient.end();
  }

  console.log(`Local PostgreSQL database ${config.targetLabel} rebuilt from migrations.`);
}

const isMainModule =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMainModule) {
  await resetDatabase();
}
