import assert from "node:assert/strict";
import test from "node:test";

import {
  COLOR_THEME_STORAGE_KEY,
  colorThemeBootstrapScript,
  parseColorTheme,
} from "../app/components/theme-preferences.ts";

test("theme preferences fail closed to the classic palette", () => {
  assert.equal(parseColorTheme("asuka"), "asuka");
  assert.equal(parseColorTheme("classic"), "classic");
  assert.equal(parseColorTheme("unknown"), "classic");
  assert.equal(parseColorTheme(null), "classic");
});

test("the early bootstrap reads the same stable storage key", () => {
  assert.equal(COLOR_THEME_STORAGE_KEY, "asuka-agent-color-theme");
  assert.match(colorThemeBootstrapScript, new RegExp(COLOR_THEME_STORAGE_KEY));
  assert.match(colorThemeBootstrapScript, /dataset\.colorTheme/);
});
