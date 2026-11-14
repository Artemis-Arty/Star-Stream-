"use strict";

/**
 * Time helpers - Arena Days and durations.
 *
 * All "current day" decisions use the configured IANA timezone
 * (TIMEZONE env var - approved decision), never the host clock.
 * Pure functions: safe to unit-test without Discord or a database.
 */

const RULES = require("../config/rules");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Split an instant into calendar parts for a timezone. */
function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  // en-CA gives 24-hour time, but some ICU versions report hour "24" at midnight.
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Calendar day key "YYYY-MM-DD" for an instant in a timezone. */
function dayKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Day of week (0=Sunday..6=Saturday) for a "YYYY-MM-DD" key. */
function dowOfKey(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

function addDaysKey(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Is `date` currently an Arena Day (Mon/Wed/Sat) in `timeZone`? */
function isArenaDay(date, timeZone) {
  return RULES.ARENA_DAYS.includes(dowOfKey(dayKey(date, timeZone)));
}

/** "YYYY-MM-DD" of the current Arena Day (regardless of whether it is one). */
function arenaDayKey(date, timeZone) {
  return dayKey(date, timeZone);
}

/**
 * Next Arena Day strictly after the given calendar day.
 * e.g. lost on Saturday -> returns Monday's key.
 */
function nextArenaDayKey(fromKey) {
  for (let i = 1; i <= 7; i += 1) {
    const candidate = addDaysKey(fromKey, i);
    if (RULES.ARENA_DAYS.includes(dowOfKey(candidate))) return candidate;
  }
  /* c8 ignore next */
  throw new Error("No Arena Day found within 7 days");
}

/**
 * Can `memberLostAt` challenge again yet? (Section 6: a Constellation who
 * loses their throne must wait until the next Arena Day.)
 */
function eligibleToChallengeAfterThroneLoss(lostAt, now, timeZone) {
  if (!lostAt) return true;
  const lossKey = dayKey(lostAt, timeZone);
  const nowKey = dayKey(now, timeZone);
  return nextArenaDayKey(lossKey) <= nowKey;
}

/** Human duration like "3d 4h 12m". */
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const pieces = [];
  if (days > 0) pieces.push(`${days}d`);
  if (hours > 0) pieces.push(`${hours}h`);
  if (minutes > 0 || pieces.length === 0) pieces.push(`${minutes}m`);
  return pieces.join(" ");
}

/** Human "in Xh Ym" / "Xm remaining" style label. */
function formatRemaining(ms) {
  if (ms <= 0) return "expired";
  return formatDuration(ms);
}

function hoursFromNow(hours, from = new Date()) {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/** Unix seconds for Discord's <t:...> timestamp formatting. */
function unixSeconds(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function minutesFromNow(minutes, from = new Date()) {
  return new Date(from.getTime() + minutes * 60 * 1000);
}

module.exports = {
  zonedParts,
  dayKey,
  dowOfKey,
  addDaysKey,
  isArenaDay,
  arenaDayKey,
  nextArenaDayKey,
  eligibleToChallengeAfterThroneLoss,
  formatDuration,
  formatRemaining,
  hoursFromNow,
  minutesFromNow,
  unixSeconds,
  WEEKDAYS,
};
