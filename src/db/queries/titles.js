"use strict";

/**
 * Title queries. Titles unlock automatically with their linked achievement
 * (config list keyed to achievements). One title may be equipped at a time.
 */

const { query, withTransaction } = require("../pool");
const { TITLES, getTitle } = require("../../config/titles");

/** Every configured title with unlock/equip state for a member. */
async function getTitlesFor(userId) {
  const unlocked = await query(
    `SELECT mt.title_key, mt.unlocked_at, mt.equipped
       FROM member_titles mt
      WHERE mt.user_id = $1`,
    [userId]
  );
  // Titles also become available when the linked achievement unlocks,
  // even before a member_titles row exists.
  const achievements = await query(
    `SELECT achievement_key FROM achievements_unlocked WHERE user_id = $1`,
    [userId]
  );
  const unlockedAchievements = new Set(achievements.rows.map((r) => r.achievement_key));
  const rows = new Map(unlocked.rows.map((r) => [r.title_key, r]));

  return TITLES.map((title) => {
    const row = rows.get(title.key);
    const achievementUnlocked = unlockedAchievements.has(title.achievement);
    const isUnlocked = Boolean(row) || achievementUnlocked;
    return {
      ...title,
      unlocked: isUnlocked,
      equipped: Boolean(row?.equipped),
      unlockedAt: row?.unlocked_at || null,
    };
  });
}

async function getEquippedTitle(userId) {
  const result = await query(
    `SELECT title_key FROM member_titles WHERE user_id = $1 AND equipped = TRUE`,
    [userId]
  );
  if (result.rows.length === 0) return null;
  return getTitle(result.rows[0].title_key);
}

/** Equip a title the member has unlocked. Throws if locked. */
async function equipTitle(userId, titleKey) {
  const title = getTitle(titleKey);
  if (!title) throw new Error("Unknown title");
  return withTransaction(async (client) => {
    const hasTitle = await client.query(
      `SELECT 1 FROM member_titles WHERE user_id = $1 AND title_key = $2`,
      [userId, titleKey]
    );
    const hasAchievement = await client.query(
      `SELECT 1 FROM achievements_unlocked WHERE user_id = $1 AND achievement_key = $2`,
      [userId, title.achievement]
    );
    if (hasTitle.rows.length === 0 && hasAchievement.rows.length === 0) {
      throw new Error("TITLE_LOCKED");
    }
    await client.query(
      `UPDATE member_titles SET equipped = FALSE WHERE user_id = $1 AND equipped = TRUE`,
      [userId]
    );
    await client.query(
      `INSERT INTO member_titles (user_id, title_key, equipped)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (user_id, title_key) DO UPDATE SET equipped = TRUE`,
      [userId, titleKey]
    );
    return title;
  });
}

/** Remove the currently equipped title (no-op if none). */
async function unequipTitle(userId) {
  const result = await query(
    `UPDATE member_titles SET equipped = FALSE
      WHERE user_id = $1 AND equipped = TRUE
      RETURNING title_key`,
    [userId]
  );
  return result.rows.length > 0;
}

module.exports = { getTitlesFor, getEquippedTitle, equipTitle, unequipTitle };
