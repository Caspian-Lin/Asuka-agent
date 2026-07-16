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

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16) / 255);
    const [red, green, blue] = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("web shell uses the shared Chinese font and icon library", async () => {
  const [layout, packageJson, ...components] = await Promise.all([
    readFile(new URL("layout.tsx", appRoot), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    ...componentFiles.map((file) => readFile(new URL(`components/${file}`, appRoot), "utf8")),
  ]);

  assert.match(layout, /Noto_Sans_SC/);
  assert.match(layout, /colorThemeBootstrapScript/);
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
  assert.match(css, /:root\[data-color-theme="asuka"\]/);
  assert.match(css, /--navigation-surface: #881c2c;/);
  assert.match(css, /--accent: #a8e2ff;/);
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

test("the Asuka theme changes only color and keeps readable text pairs", async () => {
  const css = await readFile(new URL("globals.css", appRoot), "utf8");
  const themeBlock = css.match(/:root\[data-color-theme="asuka"\]\s*{([^}]+)}/)?.[1];
  assert.ok(themeBlock);
  assert.doesNotMatch(themeBlock, /--(?:font|type|weight|tracking|space)-/);

  const token = (name) => themeBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const readablePairs = [
    ["ink", "canvas"],
    ["ink", "paper"],
    ["muted", "paper"],
    ["faint", "surface-subtle"],
    ["accent-strong", "accent-soft"],
    ["navigation-ink", "navigation-surface"],
    ["navigation-muted", "navigation-surface"],
  ];
  for (const [foregroundName, backgroundName] of readablePairs) {
    const foreground = token(foregroundName);
    const background = token(backgroundName);
    assert.ok(foreground && background, `missing ${foregroundName}/${backgroundName} theme tokens`);
    assert.ok(
      contrastRatio(foreground, background) >= 4.5,
      `${foregroundName} must remain readable on ${backgroundName}`,
    );
  }
});
