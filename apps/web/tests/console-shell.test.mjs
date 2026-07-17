import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shellPath = new URL("../app/components/agent-console.tsx", import.meta.url);
const thoughtRunsPath = new URL("../app/components/thought-runs-page.tsx", import.meta.url);

test("console uses PostgreSQL-backed surfaces without legacy demo navigation", async () => {
  const source = await readFile(shellPath, "utf8");

  assert.match(source, /ThoughtRunsPage/);
  assert.match(source, /MemoriesPage/);
  assert.match(source, /唯一数据源/);
  assert.match(source, /折叠导航侧栏/);
  assert.match(source, /rail-collapsed/);
  assert.match(source, /className="brand-copy"/);
  assert.match(source, /className="nav-label"/);
  assert.match(source, /className="rail-note-icon"/);
  assert.match(source, /activeView === "thoughts" \? " thought-workbench"/);
  assert.doesNotMatch(source, /top-bar/);
  assert.doesNotMatch(source, /evaluation/);
  assert.doesNotMatch(source, /\/api\/bootstrap/);
});

test("collapsed navigation uses compact elements instead of compressing long labels", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.agent-shell\.rail-collapsed \.brand-copy,[\s\S]*?\.nav-label\s*{\s*display: none;/);
  assert.match(css, /\.agent-shell\.rail-collapsed \.rail-note\s*{[^}]*width: 44px;[^}]*height: 44px;/s);
  assert.match(css, /\.agent-shell\.rail-collapsed \.rail-note-icon\s*{\s*display: block;/);
});

test("thought inspector exposes compression coverage, cache usage, and raw calls", async () => {
  const source = await readFile(thoughtRunsPath, "utf8");
  assert.match(source, /上下文压缩/);
  assert.match(source, /covers_through_thought_run_id/);
  assert.match(source, /compression_cached_input_tokens/);
  assert.match(source, /无可调用工具/);
  assert.match(source, /RawCallPayload/);
});
