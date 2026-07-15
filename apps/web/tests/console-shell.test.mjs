import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellPath = new URL("../app/components/agent-console.tsx", import.meta.url);

test("console uses PostgreSQL-backed surfaces without legacy demo navigation", async () => {
  const source = await readFile(shellPath, "utf8");

  assert.match(source, /ThoughtRunsPage/);
  assert.match(source, /MemoriesPage/);
  assert.match(source, /唯一数据源/);
  assert.doesNotMatch(source, /top-bar/);
  assert.doesNotMatch(source, /evaluation/);
  assert.doesNotMatch(source, /\/api\/bootstrap/);
});
