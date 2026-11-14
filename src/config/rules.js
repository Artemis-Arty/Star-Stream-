"use strict";

/**
 * Fixed game rules for Star Stream: The Constellations.
 *
 * These values come directly from the approved specification. They are NOT
 * environment configuration - changing them changes game rules, which must
 * go through the server administrators first.
 */

module.exports = Object.freeze({
  // --- Arena Days (section 4): Monday, Wednesday, Saturday ---
  // 0 = Sunday ... 6 = Saturday (JS Date.getDay())
  ARENA_DAYS: Object.freeze([1, 3, 6]),

  // --- Challenge rules (section 4) ---
  CHALLENGE_RESPONSE_HOURS: 4, // response window, NOT a cooldown
  REFUSAL_LIMIT: 3, // 4th challenge must be accepted or role is stripped

  // --- Role Collection (section 7) ---
  ROLE_COLLECTION_HOURS: 4,
  ROLE_COLLECTION_MAX_ENTRANTS: 2,

  // --- Match rules (section 5) ---
  GAME_AGREE_MINUTES: 15,
  MIN_ROUNDS: 3,
  DEFAULT_GAMES: Object.freeze([
    { id: "owo", label: "3 rounds of OwO Battle" },
    { id: "rps", label: "3 rounds of Rock-Paper-Scissors" },
  ]),

  // --- Bounty (section 9): every 14 days adds 10,000 EXP ---
  BOUNTY_INTERVAL_DAYS: 14,
  BOUNTY_STEP_EXP: 10000,

  // --- Defense rewards (section 8): every 3 defenses = 2,500 EXP ---
  DEFENSE_REWARD_EVERY: 3,
  DEFENSE_REWARD_EXP: 2500,
  DEFENSE_REWARD_SAME_OPPONENT_DAYS: 3,

  // --- King of Constellations (section 10) ---
  KING_SUBDUED_COST: 25,

  // --- Custom Constellation unlocks (section 11) ---
  CUSTOM_UNLOCK_BASE_KILLS: 25,
  CUSTOM_UNLOCK_STEP_KILLS: 10,
});
