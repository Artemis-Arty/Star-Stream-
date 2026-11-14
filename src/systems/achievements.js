"use strict";

/**
 * Achievement engine.
 *
 * Evaluates every configured achievement against a member's LIFETIME data
 * and unlocks whatever qualifies. Idempotent (unique constraint + INSERT
 * ... ON CONFLICT DO NOTHING), so it can run after any stat change, on
 * profile views, or on a timer without ever double-unlocking.
 *
 * Adding an achievement = appending to src/config/achievements.js.
 */

const { ACHIEVEMENTS } = require("../config/achievements");
const { query } = require("../db/pool");
const membersQueries = require("../db/queries/members");
const { countThroneVictories } = require("../db/queries/matches");

async function requirementValue(requirement, data) {
  switch (requirement.type) {
    case "kills":
      return data.stats.kills;
    case "subdued":
      return data.stats.subdued;
    case "thrones_taken":
      return data.member.throne_accepts;
    case "constellations_defeated":
      return data.throneVictories;
    case "custom_unlocks":
      return data.member.custom_unlocks_count;
    case "king":
      return data.hasBeenKing ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Unlock every achievement the member qualifies for.
 * @returns {Promise<Array<{key,name}>>} newly unlocked achievements
 */
async function evaluateAchievements(userId) {
  const member = await membersQueries.getMember(userId);
  if (!member) return [];
  const stats = await membersQueries.getStats(userId);
  if (!stats) return [];

  const kingResult = await query(
    `SELECT 1 FROM king_records WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const data = {
    member,
    stats,
    hasBeenKing: kingResult.rows.length > 0,
    throneVictories: 0,
  };

  const needsConquest = ACHIEVEMENTS.some(
    (a) => a.requirement.type === "constellations_defeated"
  );
  if (needsConquest) data.throneVictories = await countThroneVictories(userId);

  const newlyUnlocked = [];
  for (const achievement of ACHIEVEMENTS) {
    const value = await requirementValue(achievement.requirement, data);
    if (value < achievement.requirement.value) continue;
    const inserted = await query(
      `INSERT INTO achievements_unlocked (user_id, achievement_key)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING achievement_key`,
      [userId, achievement.key]
    );
    if (inserted.rows.length > 0) newlyUnlocked.push(achievement);
  }
  return newlyUnlocked;
}

/** Keys of unlocked achievements for a member. */
async function getUnlockedKeys(userId) {
  const result = await query(
    `SELECT achievement_key FROM achievements_unlocked WHERE user_id = $1`,
    [userId]
  );
  return new Set(result.rows.map((r) => r.achievement_key));
}

module.exports = { evaluateAchievements, getUnlockedKeys };
