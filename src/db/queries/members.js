"use strict";

/**
 * Member & statistics queries. All functions take explicit ids and are
 * safe to call repeatedly (idempotent upserts).
 */

const { query } = require("../pool");

/** Ensure members + stats rows exist (idempotent). */
async function ensureMember(userId, username = null) {
  await query(
    `INSERT INTO members (user_id, username)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET username = COALESCE(EXCLUDED.username, members.username),
           updated_at = now()`,
    [userId, username]
  );
  await query(
    `INSERT INTO stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId]
  );
}

async function getMember(userId) {
  const result = await query(`SELECT * FROM members WHERE user_id = $1`, [userId]);
  return result.rows[0] || null;
}

async function getStats(userId) {
  const result = await query(`SELECT * FROM stats WHERE user_id = $1`, [userId]);
  return result.rows[0] || null;
}

/** The member's currently held throne, if any (single open reign). */
async function getActiveReign(userId) {
  const result = await query(
    `SELECT r.*, s.display_name, s.modifier_role_name, s.emoji, s.role_id, s.seat_id AS slug
       FROM reigns r
       JOIN seats s ON s.seat_id = r.seat_id
      WHERE r.holder_id = $1 AND r.ended_at IS NULL`,
    [userId]
  );
  return result.rows[0] || null;
}

/** Open reign for a seat (current holder), if any. */
async function getSeatReign(seatId) {
  const result = await query(
    `SELECT r.*, s.display_name, s.modifier_role_name, s.emoji, s.role_id
       FROM seats s
       LEFT JOIN reigns r ON r.seat_id = s.seat_id AND r.ended_at IS NULL
      WHERE s.seat_id = $1`,
    [seatId]
  );
  return result.rows[0] || null;
}

/** Total reigns and longest reign (ms) for a member - lifetime. */
async function getReignSummary(userId) {
  const result = await query(
    `SELECT COUNT(*)::int AS total_reigns,
            COALESCE(MAX(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)))::bigint, 0) AS longest_seconds
       FROM reigns
      WHERE holder_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return {
    totalReigns: row.total_reigns,
    longestReignMs: Number(row.longest_seconds) * 1000,
  };
}

/** All achievements currently unlocked by a member (keys + timestamps). */
async function getUnlockedAchievements(userId) {
  const result = await query(
    `SELECT achievement_key, unlocked_at FROM achievements_unlocked WHERE user_id = $1 ORDER BY unlocked_at`,
    [userId]
  );
  return result.rows;
}

module.exports = {
  ensureMember,
  getMember,
  getStats,
  getActiveReign,
  getSeatReign,
  getReignSummary,
  getUnlockedAchievements,
};
