"use strict";

/**
 * Lifetime leaderboards (no seasons - approved decision).
 * Two boards: Kills and Subdued (merged defense/subdue statistic).
 */

const { query } = require("../pool");

const PAGE_SIZE = 10;

/** Top N rows of a stat column. */
async function getTop(column, limit = PAGE_SIZE) {
  if (!["kills", "subdued"].includes(column)) {
    throw new Error(`Invalid leaderboard column: ${column}`);
  }
  const result = await query(
    `SELECT user_id, ${column} AS score
       FROM stats
      WHERE ${column} > 0
      ORDER BY ${column} DESC, user_id ASC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** 1-based rank of a member on a stat column (null if score is 0). */
async function getRank(userId, column) {
  if (!["kills", "subdued"].includes(column)) {
    throw new Error(`Invalid leaderboard column: ${column}`);
  }
  const result = await query(
    `SELECT COUNT(*) + 1 AS rank,
            (SELECT ${column} FROM stats WHERE user_id = $1) AS score
       FROM stats
      WHERE ${column} > (SELECT COALESCE((SELECT ${column} FROM stats WHERE user_id = $1), 0))
         OR (${column} = (SELECT COALESCE((SELECT ${column} FROM stats WHERE user_id = $1), 0))
             AND ${column} > 0 AND user_id < $1)`,
    [userId]
  );
  const row = result.rows[0];
  if (!row || row.score === null || Number(row.score) === 0) return null;
  return { rank: Number(row.rank), score: Number(row.score) };
}

module.exports = { getTop, getRank, PAGE_SIZE };
