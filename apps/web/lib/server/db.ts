import type { AnyD1Database } from "drizzle-orm/d1";
import { ensureD1Schema } from "@asuka-agent/db/d1/runtime";
import { getRuntimeBinding } from "@/lib/server/runtime-env";

export function ensureSchema() {
  return ensureD1Schema(getRuntimeBinding<AnyD1Database>("DB"));
}
