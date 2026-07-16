import assert from "node:assert/strict";
import test from "node:test";

import {
  NAV_RAIL_COLLAPSED_STORAGE_KEY,
  parseNavRailCollapsed,
} from "../app/components/navigation-preferences.ts";

test("navigation rail collapse preference fails open and uses a stable storage key", () => {
  assert.equal(NAV_RAIL_COLLAPSED_STORAGE_KEY, "asuka-agent-nav-rail-collapsed");
  assert.equal(parseNavRailCollapsed("true"), true);
  assert.equal(parseNavRailCollapsed("false"), false);
  assert.equal(parseNavRailCollapsed("unknown"), false);
  assert.equal(parseNavRailCollapsed(null), false);
});
