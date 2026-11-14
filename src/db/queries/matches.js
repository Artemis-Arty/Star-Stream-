"use strict";

/**
 * Match queries: battle history pages and the "Constellations defeated"
 * count (total throne victories - approved decision: every verified win
 * against a member who held a throne at the time).
 */

const { query } = require("../pool");

/** Paginated history for a member (newest first). */
async function getMatchHistory(userId, { limit = 5, offset = 0 } = {}) {
  const countResult = await query(
    `SELECT COUNT(*)::int AS n FROM matches WHERE attacker_id = $1 OR defender_id = $1`,
    [userId]
  );
  const result = await query(
    `SELECT m.*,
            CASE WHEN m.attacker_id = $1 THEN m.defender_id ELSE m.attacker_id END AS opponent_id,
            (SELECT r.bounty_paid_exp
               FROM reigns r
              WHERE r.ended_by_match_id = m.match_id
                AND r.bounty_paid_exp IS NOT NULL
              LIMIT 1) AS bounty_paid
       FROM matches m
      WHERE m.attacker_id = $1 OR m.defender_id = $1
      ORDER BY COALESCE(m.verified_at, m.created_at) DESC, m.match_id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );
  return { total: countResult.rows[0].n, rows: result.rows };
}

/**
 * Total throne victories: verified wins where the OPPONENT held a throne
 * during the match (temporal reign overlap).
 */
async function countThroneVictories(userId) {
  const result = await query(
    `SELECT COUNT(*)::int AS n
       FROM matches m
       JOIN reigns r
         ON r.holder_id = CASE WHEN m.attacker_id = $1 THEN m.defender_id ELSE m.attacker_id END
        AND r.started_at <= COALESCE(m.verified_at, m.result_submitted_at, m.created_at)
        AND (r.ended_at IS NULL
             OR r.ended_at >= COALESCE(m.verified_at, m.result_submitted_at, m.created_at))
      WHERE m.status = 'verified'
        AND m.winner_id = $1
        AND (m.attacker_id = $1 OR m.defender_id = $1)`,
    [userId]
  );
  return result.rows[0].n;
}

module.exports = { getMatchHistory, countThroneVictories };
