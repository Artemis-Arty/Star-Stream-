"use strict";

/**
 * Stage 1 tests: Arena Day / timezone helpers (pure functions).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dayKey,
  isArenaDay,
  nextArenaDayKey,
  eligibleToChallengeAfterThroneLoss,
  formatDuration,
  hoursFromNow,
} = require("../src/utils/time");

// Known instants:
// 2026-11-11 is a Wednesday, 2026-11-14 a Saturday, 2026-11-16 a Monday.
const WEDNESDAY_UTC = new Date("2026-11-11T12:00:00Z");
const FRIDAY_UTC = new Date("2026-11-13T12:00:00Z");

test("dayKey formats in the configured timezone", () => {
  assert.equal(dayKey(WEDNESDAY_UTC, "UTC"), "2026-11-11");
  // 2026-11-11 23:30 UTC is already 2026-11-12 in Asia/Kolkata (+05:30).
  const late = new Date("2026-11-11T23:30:00Z");
  assert.equal(dayKey(late, "UTC"), "2026-11-11");
  assert.equal(dayKey(late, "Asia/Kolkata"), "2026-11-12");
});

test("Arena Days are Monday, Wednesday and Saturday", () => {
  assert.equal(isArenaDay(WEDNESDAY_UTC, "UTC"), true);
  assert.equal(isArenaDay(new Date("2026-11-14T00:00:00Z"), "UTC"), true); // Sat
  assert.equal(isArenaDay(new Date("2026-11-16T00:00:00Z"), "UTC"), true); // Mon
  assert.equal(isArenaDay(FRIDAY_UTC, "UTC"), false);
  assert.equal(isArenaDay(new Date("2026-11-12T12:00:00Z"), "UTC"), false); // Thu
});

test("timezone shifts which day counts", () => {
  // Friday 01:00 UTC is still Thursday in New York - Friday is not an
  // Arena Day in either timezone.
  const instant = new Date("2026-11-13T01:00:00Z");
  assert.equal(isArenaDay(instant, "UTC"), false); // Friday UTC
  // Monday 00:30 UTC: Arena Day in UTC...
  const mondayEarly = new Date("2026-11-16T00:30:00Z");
  assert.equal(isArenaDay(mondayEarly, "UTC"), true);
  // ...but still Sunday in Los Angeles (UTC-8), so NOT an Arena Day there.
  assert.equal(isArenaDay(mondayEarly, "America/Los_Angeles"), false);
});

test("nextArenaDayKey finds the following Arena Day", () => {
  assert.equal(nextArenaDayKey("2026-11-14"), "2026-11-16"); // Sat -> Mon
  assert.equal(nextArenaDayKey("2026-11-16"), "2026-11-18"); // Mon -> Wed
  assert.equal(nextArenaDayKey("2026-11-18"), "2026-11-21"); // Wed -> Sat
  assert.equal(nextArenaDayKey("2026-11-13"), "2026-11-14"); // Fri -> Sat
  assert.equal(nextArenaDayKey("2026-11-12"), "2026-11-14"); // Thu -> Sat
});

test("throne-loss gate waits until the next Arena Day", () => {
  const lostSaturday = new Date("2026-11-14T15:00:00Z");
  // Same day (Saturday): not yet eligible.
  assert.equal(
    eligibleToChallengeAfterThroneLoss(lostSaturday, new Date("2026-11-14T18:00:00Z"), "UTC"),
    false
  );
  // Monday: eligible.
  assert.equal(
    eligibleToChallengeAfterThroneLoss(lostSaturday, new Date("2026-11-16T00:00:00Z"), "UTC"),
    true
  );
  // Lost on Wednesday -> Thursday not eligible, Saturday eligible.
  const lostWednesday = new Date("2026-11-11T12:00:00Z");
  assert.equal(
    eligibleToChallengeAfterThroneLoss(lostWednesday, new Date("2026-11-12T12:00:00Z"), "UTC"),
    false
  );
  assert.equal(
    eligibleToChallengeAfterThroneLoss(lostWednesday, new Date("2026-11-14T12:00:00Z"), "UTC"),
    true
  );
  // Never held a throne: always eligible.
  assert.equal(eligibleToChallengeAfterThroneLoss(null, new Date(), "UTC"), true);
});

test("formatDuration renders d/h/m", () => {
  assert.equal(formatDuration(0), "0m");
  assert.equal(formatDuration(65 * 60 * 1000), "1h 5m");
  assert.equal(formatDuration(50 * 60 * 60 * 1000), "2d 2h");
  assert.equal(formatDuration(-1000), "0m");
});

test("hoursFromNow adds the response window", () => {
  const base = new Date("2026-11-11T12:00:00Z");
  assert.equal(hoursFromNow(4, base).toISOString(), "2026-11-11T16:00:00.000Z");
});
