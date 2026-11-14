"use strict";

/**
 * Throne seat queries: all seats with their current holders, plus the
 * bounty board for /bounty.
 */

const { query } = require("../pool");
const { computeBounty, nextBountyIncrease } = require("../../systems/bounty");

/** All active seats with holder info (null holder = vacant). */
async function getSeatsWithHolders() {
  const result = await query(
    `SELECT s.seat_id, s.display_name, s.modifier_role_name, s.emoji, s.role_id,
            s.source, s.sort_order,
            r.reign_id, r.holder_id, r.started_at, r.refusal_count
       FROM seats s
       LEFT JOIN reigns r ON r.seat_id = s.seat_id AND r.ended_at IS NULL
      WHERE s.is_active = TRUE
      ORDER BY s.sort_order, s.display_name`
  );
  return result.rows.map((row) => ({
    ...row,
    holderId: row.holder_id ? String(row.holder_id) : null,
    reignId: row.reign_id ?? null,
    startedAt: row.started_at,
    bounty: row.started_at ? computeBounty(row.started_at) : 0,
    reignMs: row.started_at ? Date.now() - new Date(row.started_at).getTime() : 0,
    nextIncrease: row.started_at ? nextBountyIncrease(row.started_at) : null,
  }));
}

/** Occupied seats only, sorted by bounty descending (for /bounty). */
async function getBountyBoard() {
  const seats = await getSeatsWithHolders();
  const occupied = seats.filter((seat) => seat.holderId);
  occupied.sort((a, b) => b.bounty - a.bounty);
  const total = occupied.reduce((sum, seat) => sum + seat.bounty, 0);
  return { occupied, total };
}

module.exports = { getSeatsWithHolders, getBountyBoard };
