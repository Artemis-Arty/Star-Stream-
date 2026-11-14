"use strict";

/**
 * Achievement definitions (approved defaults - configurable before launch).
 *
 * Achievements are based on LIFETIME statistics. They are never removed by
 * seasonal resets (not used), losing a throne, losing a match or role
 * changes. Unlocking is recorded in the `achievements_unlocked` table.
 *
 * Requirement types (evaluated against stored lifetime values):
 *   kills                    - stats.kills
 *   subdued                  - stats.subdued  (merged Defense Wins + Subdued stat)
 *   thrones_taken            - members.throne_accepts
 *   constellations_defeated  - distinct Constellation seats defeated
 *   custom_unlocks           - members.custom_unlocks_count
 *   king                     - has ever forged the King of Constellations title
 *
 * Add a new achievement by appending an entry here - no other code changes
 * are required for it to unlock and display.
 */

const ACHIEVEMENTS = [
  // --- Kill achievements ---
  { key: "first_blood", name: "First Blood", category: "kill", requirement: { type: "kills", value: 1 }, description: "Win your first match as a Challenger." },
  { key: "throne_breaker", name: "Throne Breaker", category: "kill", requirement: { type: "kills", value: 5 }, description: "Reach 5 Kills." },
  { key: "constellation_killer", name: "Constellation Killer", category: "kill", requirement: { type: "kills", value: 10 }, description: "Reach 10 Kills." },
  { key: "calamity", name: "Calamity", category: "kill", requirement: { type: "kills", value: 25 }, description: "Reach 25 Kills." },
  { key: "doom_of_the_star_stream", name: "Doom of the Star Stream", category: "kill", requirement: { type: "kills", value: 50 }, description: "Reach 50 Kills." },

  // --- Conquest achievements ---
  { key: "throne_conqueror", name: "Throne Conqueror", category: "conquest", requirement: { type: "thrones_taken", value: 1 }, description: "Claim your first throne." },
  { key: "star_devourer", name: "Star Devourer", category: "conquest", requirement: { type: "constellations_defeated", value: 5 }, description: "Defeat 5 different Constellations." },
  { key: "divine_predator", name: "Divine Predator", category: "conquest", requirement: { type: "constellations_defeated", value: 10 }, description: "Defeat 10 different Constellations." },
  { key: "myth_maker", name: "Myth Maker", category: "conquest", requirement: { type: "custom_unlocks", value: 1 }, description: "Unlock a custom Constellation seat." },
  { key: "absolute_sovereign", name: "Absolute Sovereign", category: "conquest", requirement: { type: "king", value: 1 }, description: "Become King of Constellations." },

  // --- Subdued achievements (merged Defense Wins + Subdued ladder) ---
  { key: "unyielding", name: "Unyielding", category: "subdued", requirement: { type: "subdued", value: 3 }, description: "Reach 3 Subdued." },
  { key: "conqueror", name: "Conqueror", category: "subdued", requirement: { type: "subdued", value: 5 }, description: "Reach 5 Subdued." },
  { key: "immovable_throne", name: "Immovable Throne", category: "subdued", requirement: { type: "subdued", value: 10 }, description: "Reach 10 Subdued." },
  { key: "divine_ruler", name: "Divine Ruler", category: "subdued", requirement: { type: "subdued", value: 10 }, description: "Reach 10 Subdued." },
  { key: "eternal_guardian", name: "Eternal Guardian", category: "subdued", requirement: { type: "subdued", value: 25 }, description: "Reach 25 Subdued." },
  { key: "kingmaker", name: "Kingmaker", category: "subdued", requirement: { type: "subdued", value: 25 }, description: "Reach 25 Subdued." },
  { key: "invincible_legend", name: "Invincible Legend", category: "subdued", requirement: { type: "subdued", value: 50 }, description: "Reach 50 Subdued." },
];

const BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

function getAchievement(key) {
  return BY_KEY.get(key) || null;
}

module.exports = { ACHIEVEMENTS, getAchievement };
