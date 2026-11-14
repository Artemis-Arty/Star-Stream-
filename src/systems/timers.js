"use strict";

/**
 * Timer sweeper: converts persisted deadlines into actions.
 *
 * The bot keeps NO in-memory game timers - deadlines live in the database
 * (challenges.response_deadline_at, matches.game_agreed_deadline_at,
 * role_collections.deadline_at, ...). This sweeper runs:
 *   - once at startup (recovers deadlines missed while the bot was down)
 *   - every 60 seconds while running
 *
 * An advisory lock makes concurrent sweeps (multiple processes/restarts)
 * mutually exclusive, and the `status = 'pending'` filter inside the
 * transaction guarantees each deadline is processed exactly once.
 */

const { withAdvisoryLock } = require("../db/pool");
const { processExpiredChallenges } = require("./challenge");
const { processExpiredMatches } = require("./match");
const {
  processExpiredCollections,
  openArenaDayCollections,
} = require("./collection");
const { logger } = require("../logging/logger");

const DEFAULT_INTERVAL_MS = 60_000;
const LOCK_NAME = "starstream:timers";

let intervalHandle = null;

/** Run one sweep under the global timer lock. Returns how many ran. */
async function runTimerSweep({ client, config, at = new Date() }) {
  const guild = client?.guilds?.cache?.get(config?.discord?.guildId) || null;

  const { acquired, result } = await withAdvisoryLock(LOCK_NAME, async () => {
    const challenges = await processExpiredChallenges({ guild, config, at });
    const matches = await processExpiredMatches({ guild, config, at });
    const collections = await processExpiredCollections({ guild, config, at });
    const opened = await openArenaDayCollections({ guild, config, at });
    return { challenges, matches, collections, opened };
  });

  if (!acquired) {
    logger.debug("Timer sweep skipped - another process is sweeping.");
    return 0;
  }
  const challengeCount = result?.challenges?.length || 0;
  const matchCount = result?.matches?.length || 0;
  const collectionCount = result?.collections?.length || 0;
  const openedCount = result?.opened?.length || 0;
  if (challengeCount + matchCount + collectionCount + openedCount > 0) {
    logger.info(
      `Timer sweep processed ${challengeCount} expired challenge(s), ` +
        `${matchCount} expired game-agreement window(s), ` +
        `${collectionCount} Role Collection deadline(s), ` +
        `opened ${openedCount} Arena Day collection(s).`
    );
  }
  return challengeCount + matchCount + collectionCount + openedCount;
}

/** Start the periodic sweep (idempotent). */
function startTimers(client, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (intervalHandle) return intervalHandle;

  const config = client.config;
  const sweep = async () => {
    try {
      await runTimerSweep({ client, config });
    } catch (err) {
      logger.error("Timer sweep failed:", err.message);
    }
  };

  intervalHandle = setInterval(sweep, intervalMs);
  intervalHandle.unref?.();

  // Immediate sweep: recovers anything that expired while the bot was down.
  sweep();

  logger.info(`Challenge timers started (sweep every ${intervalMs / 1000}s).`);
  return intervalHandle;
}

function stopTimers() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { startTimers, stopTimers, runTimerSweep, DEFAULT_INTERVAL_MS };
