"use strict";

/**
 * Titles (config list keyed to achievements - approved decision).
 *
 * A title is unlocked when its linked achievement is unlocked. Members
 * equip one title at a time with /titles; the equipped title shows in
 * /profile. Add or remove entries here before launch without code changes.
 */

const { ACHIEVEMENTS } = require("./achievements");

// One title per achievement by default (seed list).
const TITLES = ACHIEVEMENTS.map((achievement) => ({
  key: `title_${achievement.key}`,
  name: achievement.name,
  achievement: achievement.key,
  description: `Awarded for the ${achievement.name} achievement.`,
}));

// Add extra titles here later, e.g.:
// { key: "title_event_x", name: "Event Name", achievement: "some_achievement" }
const EXTRA_TITLES = [];

const ALL_TITLES = [...TITLES, ...EXTRA_TITLES];
const BY_KEY = new Map(ALL_TITLES.map((t) => [t.key, t]));

function getTitle(key) {
  return BY_KEY.get(key) || null;
}

module.exports = { TITLES: ALL_TITLES, getTitle };
