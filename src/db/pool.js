"use strict";

/**
 * PostgreSQL connection pool.
 *
 * - Small pool (default 4) for free hosting tiers.
 * - Auto-reconnect: idle client errors don't kill the process.
 * - `withTransaction` wraps critical game actions (spec: use transactions,
 *   prevent duplicate rewards/results).
 * - `withAdvisoryLock` serializes singleton jobs (timer recovery) so a
 *   restart can never double-process a deadline.
 */

const { Pool, types } = require("pg");
const { getConfig } = require("../config/env");
const { logger } = require("../logging/logger");

// DATE columns (challenges.arena_day, role_collections.arena_day) come back
// as 'YYYY-MM-DD' strings, never as JS Dates: a Date for a DATE column is
// anchored at local midnight and loses the calendar day across timezones,
// while every consumer (dayKey comparisons, embed footers, `T00:00:00Z`
// parsing) expects the plain calendar-day string.
types.setTypeParser(1082, (value) => value);

let pool = null;

function getPool() {
  if (pool) return pool;
  const cfg = getConfig();
  pool = new Pool({
    connectionString: cfg.database.url,
    max: cfg.database.poolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Reconnect-friendly: keep trying on transient network drops.
    allowExitOnIdle: false,
  });

  pool.on("error", (err) => {
    // Emitted for idle clients; the pool itself stays usable.
    logger.error("PostgreSQL idle client error:", err.message);
  });

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Run `fn(client)` inside a transaction.
 * Commits on resolve, rolls back on throw. Never swallows the error.
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("Transaction rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` while holding a Postgres advisory lock (key derived from name).
 * Guarantees only one process runs the critical section at a time.
 */
async function withAdvisoryLock(lockName, fn) {
  const key = hashLockName(lockName);
  const client = await getPool().connect();
  try {
    const got = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [key]);
    if (!got.rows[0].locked) {
      return { acquired: false, result: undefined };
    }
    try {
      const result = await fn(client);
      return { acquired: true, result };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
    }
  } finally {
    client.release();
  }
}

/** FNV-1a 32-bit - stable advisory lock key for a lock name. */
function hashLockName(name) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = { getPool, query, withTransaction, withAdvisoryLock, closePool };
