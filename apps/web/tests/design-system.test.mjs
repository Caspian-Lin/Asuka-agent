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
  "theme-settings-panel.tsx",
  "thought-runs-page.tsx",
];

test("web shell uses the shared Chinese font and icon library", async () => {
  const [layout, packageJson, favicon, ...components] = await Promise.all([
    readFile(new URL("layout.tsx", appRoot), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/favicon.svg", import.meta.url), "utf8"),
    ...componentFiles.map((file) => readFile(new URL(`components/${file}`, appRoot), "utf8")),
  ]);

  assert.match(layout, /Noto_Sans_SC/);
  assert.match(layout, /colorThemeBootstrapScript/);
  assert.equal(JSON.parse(packageJson).dependencies["react-icons"], "^5.5.0");
  assert.match(favicon, /#FEB266/);
  assert.match(favicon, /#3B9AE1/);
  assert.doesNotMatch(favicon, /#(?:7165DF|68C4FF)/i);
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
  assert.match(css, /:root\[data-color-theme="asuka"\]/);
  assert.match(css, /--preview-asuka-surface: #e9922f;/);
  assert.match(css, /--preview-asuka-accent: #a8e2ff;/);
  assert.match(css, /--font-sans: var\(--font-noto-sans-sc\);/);
  assert.match(css, /--weight-regular: 500;/);
  assert.match(css, /--weight-bold: 800;/);
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

test("the Asuka theme uses EVA hue pairs and scopes heavier type to content", async () => {
  const css = await readFile(new URL("globals.css", appRoot), "utf8");
  const themeBlock = css.match(/:root\[data-color-theme="asuka"\]\s*{([^}]+)}/)?.[1];
  assert.ok(themeBlock);
  assert.doesNotMatch(themeBlock, /--(?:font|type|weight|tracking|space)-/);

  const token = (name) => themeBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const expectedTokens = {
    paper: "#f4481f",
    "paper-strong": "#ffe7c1",
    accent: "#ffe8c1",
    info: "#65c8ff",
    "surface-muted": "#dc7826",
    canvas: "#312e2a",
    ink: "#00e108",
    muted: "#ffe8c1",
  };
  for (const [name, expected] of Object.entries(expectedTokens)) {
    assert.equal(token(name)?.toLowerCase(), expected, `${name} must keep its EVA palette role`);
  }

  assert.match(css, /:root\[data-color-theme="asuka"\] \.workbench\s*{[^}]*--weight-regular: 600;[^}]*--weight-bold: 900;/s);
  assert.match(css, /:root\[data-color-theme="asuka"\] \.mobile-nav\s*{[^}]*--weight-regular: 400;[^}]*--weight-bold: 700;/s);
  assert.match(css, /:root\[data-color-theme="asuka"\] ::selection\s*{[^}]*background: var\(--accent-strong\);[^}]*color: var\(--warning\);/s);
});
