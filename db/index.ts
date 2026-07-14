import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import { getRuntimeBinding } from "@/lib/server/runtime-env";
import * as schema from "./schema";

export function getD1() {
  return getRuntimeBinding<AnyD1Database>("DB");
}

export function getDb() {
  return drizzle(getD1(), { schema });
}
