"use strict";

/**
 * Migration runner.
 *
 * - Tracks applied versions in `schema_migrations`.
 * - Applies each pending .sql file inside its own transaction.
 * - Seeds the original seven Constellation seats (idempotent).
 *
 * Run manually:  npm run migrate
 * Or automatically at startup when AUTO_MIGRATE=true.
 */

const fs = require("fs");
const path = require("path");
const { getPool } = require("./pool");
const { ORIGINAL_CONSTELLATIONS } = require("../config/constellations");
const { logger } = require("../logging/logger");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function getAppliedVersions(client) {
  const result = await client.query("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((row) => row.version));
}

/** Insert the original seven Constellations (no-op if already present). */
async function seedConstellations(client) {
  const values = [];
  const params = [];
  ORIGINAL_CONSTELLATIONS.forEach((c, index) => {
    const base = index * 7;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
    );
    params.push(
      c.seatId,
      c.displayName,
      c.modifierRoleName,
      c.description || null,
      c.emoji || null,
      c.sortOrder,
      "original"
    );
  });

  await client.query(
    `INSERT INTO seats (seat_id, display_name, modifier_role_name, description, emoji, sort_order, source)
     VALUES ${values.join(", ")}
     ON CONFLICT (seat_id) DO NOTHING`,
    params
  );
}

/**
 * Apply all pending migrations. Safe to call concurrently thanks to the
 * advisory lock (only one runner proceeds).
 */
async function runMigrations(pool = getPool()) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(772001)");
    await ensureMigrationsTable(client);

    const applied = await getAppliedVersions(client);
    const files = listMigrationFiles();
    let ran = 0;

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      logger.info(`Applying migration: ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        ran += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    await seedConstellations(client);

    if (ran === 0) logger.info("Database schema is up to date.");
    else logger.info(`Applied ${ran} migration(s).`);

    return { applied: files.filter((f) => !applied.has(f)), total: files.length };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(772001)");
    } catch {
      /* connection may already be broken */
    }
    client.release();
  }
}

module.exports = { runMigrations, listMigrationFiles, seedConstellations };

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error("Migration failed:", err.message);
      process.exit(1);
    });
}
