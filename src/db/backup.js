"use strict";

/**
 * Logical backup & restore (no pg_dump binary needed - works on any host).
 *
 * Format: gzip-compressed JSON:
 *   { format, version, createdAt, tables, rowCounts, data: { table: [rows] } }
 *
 * - createBackup(): dumps every public table, writes a timestamped file,
 *   prunes old backups beyond `retention`.
 * - restoreBackup(): truncates and reloads ALL tables inside ONE
 *   transaction - a failed restore leaves the database untouched.
 *
 * pg_dump/pg_restore remain a valid alternative (see docs/backup-recovery.md).
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { getPool, query } = require("./pool");
const { logger } = require("../logging/logger");

const FORMAT = "star-stream-backup";
const VERSION = 1;

async function listTables(client = { query }) {
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  return result.rows.map((row) => row.table_name);
}

/**
 * Dump the database to a gzipped JSON file.
 * @returns {Promise<{file: string, rowCounts: object, bytes: number}>}
 */
async function createBackup({ dir, label = "manual" } = {}, pool = getPool()) {
  const tables = await listTables(pool);
  const data = {};
  const rowCounts = {};

  for (const table of tables) {
    const result = await pool.query(`SELECT * FROM "${table}"`);
    data[table] = result.rows;
    rowCounts[table] = result.rows.length;
  }

  const payload = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    label,
    tables,
    rowCounts,
    data,
  };

  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `starstream-${stamp}-${label}.json.gz`);

  const gzip = zlib.createGzip({ level: 6 });
  const source = require("stream").Readable.from([JSON.stringify(payload)]);
  await pipeline(source, gzip, fs.createWriteStream(file));

  const { size } = await fsp.stat(file);
  const totalRows = Object.values(rowCounts).reduce((a, b) => a + b, 0);
  logger.info(`Backup written: ${file} (${totalRows} rows, ${size} bytes)`);

  return { file, rowCounts, bytes: size, totalRows };
}

/** List backups newest-first. */
async function listBackups(dir) {
  try {
    const files = await fsp.readdir(dir);
    const backups = files
      .filter((name) => name.startsWith("starstream-") && name.endsWith(".json.gz"))
      .map((name) => path.join(dir, name));
    const withStats = await Promise.all(
      backups.map(async (file) => ({ file, stat: await fsp.stat(file) }))
    );
    return withStats
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .map((entry) => entry.file);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

/** Delete old backups, keeping the newest `retention`. */
async function pruneBackups(dir, retention) {
  const files = await listBackups(dir);
  const doomed = files.slice(retention);
  for (const file of doomed) {
    await fsp.unlink(file);
    logger.info(`Pruned old backup: ${file}`);
  }
  return doomed.length;
}

async function readBackup(file) {
  const raw = await fsp.readFile(file);
  const json = zlib.gunzipSync(raw).toString("utf8");
  const payload = JSON.parse(json);
  if (payload.format !== FORMAT) {
    throw new Error(`Not a Star Stream backup (format=${payload.format})`);
  }
  if (payload.version !== VERSION) {
    throw new Error(`Unsupported backup version ${payload.version}`);
  }
  return payload;
}

const INSERT_BATCH_ROWS = 400;

/**
 * Order tables so that referenced tables are inserted before the tables
 * that reference them (FK-safe restore).
 */
async function sortTablesByDependency(client, tables) {
  const result = await client.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'`
  );

  const wanted = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of result.rows) {
    if (child !== parent && wanted.has(child) && wanted.has(parent)) {
      deps.get(child).add(parent);
    }
  }

  const sorted = [];
  const placed = new Set();
  const visiting = new Set();
  const visit = (table) => {
    if (placed.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(`Foreign key cycle detected involving table "${table}"`);
    }
    visiting.add(table);
    for (const dep of deps.get(table)) visit(dep);
    visiting.delete(table);
    placed.add(table);
    sorted.push(table);
  };
  for (const table of tables) visit(table);
  return sorted;
}

async function insertRows(client, table, rows) {
  if (rows.length === 0) return 0;
  const columns = Object.keys(rows[0]);
  if (columns.length === 0) return 0;
  const quoted = columns.map((c) => `"${c}"`).join(", ");
  let inserted = 0;

  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    const batch = rows.slice(start, start + INSERT_BATCH_ROWS);
    const params = [];
    const tuples = batch.map((row) => {
      const placeholders = columns.map((col) => {
        params.push(row[col] === undefined ? null : row[col]);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await client.query(
      `INSERT INTO "${table}" (${quoted}) VALUES ${tuples.join(", ")}`,
      params
    );
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Restore a backup file. Truncates every table and reloads inside a single
 * transaction. Requires explicit confirmation (handled by the CLI).
 */
async function restoreBackup(file, pool = getPool()) {
  const payload = await readBackup(file);
  const liveTables = await listTables(pool);
  const missing = payload.tables.filter((t) => !liveTables.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `Backup references tables that do not exist in this database: ${missing.join(", ")}`
    );
  }

  // Restore every table EXCEPT schema_migrations: the running schema's
  // migration state must always reflect the code that is deployed, even
  // when restoring an older backup.
  const restoreTables = payload.tables.filter((t) => t !== "schema_migrations");
  const truncateTargets = liveTables.filter((t) => t !== "schema_migrations");

  const client = await pool.connect();
  const restored = {};
  let insertOrder = restoreTables;
  try {
    await client.query("BEGIN");
    insertOrder = await sortTablesByDependency(client, restoreTables);
    // Truncate everything in one statement (FK-safe when all are listed).
    await client.query(
      `TRUNCATE TABLE ${truncateTargets.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
    for (const table of insertOrder) {
      restored[table] = await insertRows(client, table, payload.data[table] || []);
    }
    // Resync BIGSERIAL sequences to the restored max ids, otherwise the
    // next INSERT would reuse old primary keys and fail.
    for (const table of restoreTables) {
      const cols = await client.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_default LIKE 'nextval(%'`,
        [table]
      );
      for (const { column_name: column } of cols.rows) {
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, $2),
             GREATEST(COALESCE((SELECT MAX("${column}") FROM "${table}"), 1), 1)
           )`,
          [table, column]
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Restore failed, database left unchanged: ${err.message}`);
  } finally {
    client.release();
  }

  const total = Object.values(restored).reduce((a, b) => a + b, 0);
  logger.info(`Restore complete from ${file}: ${total} rows`);
  return restored;
}

/**
 * Start the automatic backup interval (called from index.js).
 * @returns {NodeJS.Timeout|null}
 */
function scheduleAutoBackups({ dir, intervalHours, retention }) {
  if (!intervalHours || intervalHours <= 0) return null;
  const timer = setInterval(async () => {
    try {
      await createBackup({ dir, label: "auto" });
      await pruneBackups(dir, retention);
    } catch (err) {
      logger.error("Automatic backup failed:", err.message);
    }
  }, intervalHours * 60 * 60 * 1000);
  timer.unref?.();
  logger.info(`Automatic backups every ${intervalHours}h -> ${dir}`);
  return timer;
}

module.exports = {
  FORMAT,
  VERSION,
  listTables,
  createBackup,
  listBackups,
  pruneBackups,
  readBackup,
  restoreBackup,
  scheduleAutoBackups,
};
