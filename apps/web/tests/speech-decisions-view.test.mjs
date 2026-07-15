import assert from "node:assert/strict";
import test from "node:test";

import {
  minuteToTime,
  speechOutcomeCopy,
  speechReasonCopy,
  timeToMinute,
} from "../app/components/speech-decisions-view.ts";

test("quiet-hour controls round-trip minute values", () => {
  assert.equal(minuteToTime(23 * 60 + 45), "23:45");
  assert.equal(timeToMinute("23:45"), 23 * 60 + 45);
});

test("operator copy explains every policy result without model jargon", () => {
  for (const outcome of ["silent", "defer", "blocked", "shadow_speak", "speak"]) {
    assert.ok(speechOutcomeCopy[outcome]?.label);
  }
  for (const reason of ["kill_switch", "quiet_hours", "duplicate_suppressed", "policy_passed"]) {
    assert.ok(speechReasonCopy[reason]);
  }
});
