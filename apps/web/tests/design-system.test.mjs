import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoot = new URL("../app/", import.meta.url);
const componentFiles = [
  "agent-console.tsx",
  "im-channel-page.tsx",
  "jobs-page.tsx",
  "llm-settings-panel.tsx",
  "memories-page.tsx",
  "speech-decisions-page.tsx",
  "thought-runs-page.tsx",
];

test("web shell uses the shared Chinese font and icon library", async () => {
  const [layout, packageJson, ...components] = await Promise.all([
    readFile(new URL("layout.tsx", appRoot), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    ...componentFiles.map((file) => readFile(new URL(`components/${file}`, appRoot), "utf8")),
  ]);

  assert.match(layout, /Noto_Sans_SC/);
  assert.equal(JSON.parse(packageJson).dependencies["react-icons"], "^5.5.0");
  for (const source of components) {
    assert.match(source, /react-icons\/lu/);
    assert.doesNotMatch(source, /className="(?:empty-orbit|section-kicker)"/);
  }
});

test("design tokens own typography, padding, and product colors", async () => {
  const css = await readFile(new URL("globals.css", appRoot), "utf8");
  const declarations = css.split("\n").map((line) => line.trim());

  assert.match(css, /--accent: #feb266;/);
  assert.match(css, /--info: #3b9ae1;/);
  assert.match(css, /--font-sans: var\(--font-noto-sans-sc\);/);
  assert.match(css, /line-break: strict;/);
  assert.match(css, /text-align: justify;/);

  for (const declaration of declarations) {
    if (declaration.startsWith("font-size:") && !declaration.startsWith("font-size: var(--type-")) {
      assert.fail(`font-size must use a semantic type token: ${declaration}`);
    }
    if (declaration.startsWith("font-weight:") && !declaration.startsWith("font-weight: var(--weight-")) {
      assert.fail(`font-weight must use a semantic weight token: ${declaration}`);
    }
    if (declaration.startsWith("padding") && !declaration.includes("var(--space-")) {
      assert.fail(`padding must use the spacing scale: ${declaration}`);
    }
  }

  const rules = css.slice(css.indexOf("@theme inline"));
  assert.doesNotMatch(rules, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(rules, /--(?:lavender|cyan|rose)/);
});
