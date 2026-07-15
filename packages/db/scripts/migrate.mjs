import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("CHANGE_ME")) {
  throw new Error("Set a real DATABASE_URL in .env before running migrations.");
}

const client = postgres(process.env.DATABASE_URL, {
  ssl: process.env.DATABASE_SSL === "true" ? "require" : false,
  max: 1,
});

try {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle-pg", import.meta.url)),
  });
  console.log("PostgreSQL migrations applied.");
} finally {
  await client.end();
}
