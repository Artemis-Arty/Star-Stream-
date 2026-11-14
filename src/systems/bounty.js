"use strict";

/**
 * Bounty calculations (section 9 of the specification).
 *
 * The bounty is DERIVED from the reign's started_at timestamp - no
 * in-memory timers, so it survives restarts and always stays correct.
 *
 *   14 days = 10,000 EXP | 28 days = 20,000 | 42 days = 30,000 ...
 *   every additional 14 days adds 10,000 EXP.
 */

const RULES = require("../config/rules");

/**
 * Bounty amount for a reign at a given instant.
 * @param {Date|string} startedAt reign start
 * @param {object} options { endedAt, at }
 * @returns {number} EXP amount
 */
function computeBounty(startedAt, { endedAt = null, at = new Date() } = {}) {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : at.getTime();
  const elapsedDays = Math.max(0, (end - start) / 86400000);
  const steps = Math.floor(elapsedDays / RULES.BOUNTY_INTERVAL_DAYS);
  return steps * RULES.BOUNTY_STEP_EXP;
}

/**
 * Progress toward the next bounty increase.
 * @returns {{ nextAt: Date, remainingMs: number, daysTotal: number, amount: number }}
 */
function nextBountyIncrease(startedAt, { endedAt = null, at = new Date() } = {}) {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : at.getTime();
  const elapsedDays = Math.max(0, (end - start) / 86400000);
  const stepsSoFar = Math.floor(elapsedDays / RULES.BOUNTY_INTERVAL_DAYS);
  const daysTotal = (stepsSoFar + 1) * RULES.BOUNTY_INTERVAL_DAYS;
  const nextAt = new Date(start + daysTotal * 86400000);
  return {
    nextAt,
    remainingMs: Math.max(0, nextAt.getTime() - end),
    daysTotal,
    amount: (stepsSoFar + 1) * RULES.BOUNTY_STEP_EXP,
  };
}

module.exports = { computeBounty, nextBountyIncrease };
