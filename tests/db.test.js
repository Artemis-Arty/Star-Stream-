"use strict";

/**
 * Stage 1 tests: real PostgreSQL schema, constraints and backup/restore.
 *
 * Uses an embedded PostgreSQL server (devDependency `embedded-postgres`)
 * so the schema is validated against a REAL database even on hosts with
 * no Postgres installed. If the embedded server cannot start, the tests
 * skip with a reason instead of failing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TMP_ROOT = (() => {
  const opencode = "C:/Users/temp/AppData/Local/Temp/opencode";
  return fs.existsSync(opencode) ? opencode : os.tmpdir();
})();

const DATA_DIR = path.join(TMP_ROOT, `starstream-pg-${process.pid}`);
const BACKUP_DIR = path.join(TMP_ROOT, `starstream-bk-${process.pid}`);
const PORT = 55100 + (process.pid % 800);

let available = false;
let skipReason = "setup not run";
let embedded = null;
let pool = null;

test.before(async () => {
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch (err) {
    skipReason = `embedded-postgres unavailable: ${err.message}`;
    return;
  }

  try {
    embedded = new EmbeddedPostgres({
      databaseDir: DATA_DIR,
      port: PORT,
      user: "postgres",
      password: "testpw",
      persistent: false,
      autoRehydrateSymlinks: true,
      // Windows locales default to WIN1252, which cannot store emoji.
      // Real hosting providers use UTF8; match them here.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("starstream_test");

    const { Pool } = require("pg");
    pool = new Pool({
      host: "127.0.0.1",
      port: PORT,
      user: "postgres",
      password: "testpw",
      database: "starstream_test",
      max: 2,
    });
    await pool.query("SELECT 1");
    available = true;
  } catch (err) {
    skipReason = `embedded PostgreSQL failed to start: ${err.message}`;
    if (pool) await pool.end().catch(() => {});
    if (embedded) await embedded.stop().catch(() => {});
    embedded = null;
    pool = null;
  }
});

test.after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (embedded) await embedded.stop().catch(() => {});
  // Best-effort cleanup: embedded-postgres may still hold file handles
  // briefly while deleting its own data directory on Windows.
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    /* ignore */
  }
});

function guard(t) {
  if (!available) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

async function expectUniqueViolation(fn) {
  await assert.rejects(fn, (err) => err.code === "23505", "expected unique violation");
}

test("migrations apply, seed seven Constellations and are idempotent", async (t) => {
  if (!guard(t)) return;
  const { runMigrations } = require("../src/db/migrate");

  const first = await runMigrations(pool);
  assert.ok(first.applied.includes("001_initial_schema.sql"));

  const seats = await pool.query(
    "SELECT seat_id, modifier_role_name, source FROM seats ORDER BY sort_order"
  );
  assert.equal(seats.rows.length, 7);
  assert.deepEqual(
    seats.rows.map((r) => r.modifier_role_name),
    ["Zeus", "Hades", "Odin", "Sun Wukong", "Surya", "Abyssal Black Flame Dragon", "Uriel"]
  );
  assert.ok(seats.rows.every((r) => r.source === "original"));

  // Locked names are UNIQUE at the database level.
  await expectUniqueViolation(() =>
    pool.query(
      `INSERT INTO seats (seat_id, display_name, modifier_role_name, source)
       VALUES ('fake-zeus', 'Fake', 'Zeus', 'custom')`
    )
  );

  // Re-running must not duplicate anything.
  const second = await runMigrations(pool);
  assert.equal(second.applied.length, 0);
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM seats");
  assert.equal(count.rows[0].n, 7);
});

test("only one active challenge per Constellation seat", async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO challenges (seat_id, challenger_id, arena_day, response_deadline_at)
     VALUES ('zeus', 111, '2026-11-11', now() + interval '4 hours')`
  );
  await expectUniqueViolation(() =>
    pool.query(
      `INSERT INTO challenges (seat_id, challenger_id, arena_day, response_deadline_at)
       VALUES ('zeus', 222, '2026-11-11', now() + interval '4 hours')`
    )
  );
});

test("one challenge per Challenger per seat per Arena Day (cancelled exempt)", async (t) => {
  if (!guard(t)) return;
  // Challenger 333 vs hades - first one is fine.
  await pool.query(
    `INSERT INTO challenges (seat_id, challenger_id, arena_day, response_deadline_at)
     VALUES ('hades', 333, '2026-11-11', now() + interval '4 hours')`
  );
  // Resolve it, then the same challenger still cannot re-challenge the same day.
  await pool.query(
    `UPDATE challenges SET status = 'completed', resolved_at = now()
     WHERE challenger_id = 333 AND seat_id = 'hades'`
  );
  await expectUniqueViolation(() =>
    pool.query(
      `INSERT INTO challenges (seat_id, challenger_id, arena_day, response_deadline_at)
       VALUES ('hades', 333, '2026-11-11', now() + interval '4 hours')`
    )
  );
  // A CANCELLED challenge does not consume the opportunity.
  await pool.query(
    `UPDATE challenges SET status = 'cancelled' WHERE challenger_id = 333 AND seat_id = 'hades'`
  );
  await pool.query(
    `INSERT INTO challenges (seat_id, challenger_id, arena_day, response_deadline_at)
     VALUES ('hades', 333, '2026-11-11', now() + interval '4 hours')`
  );
});

test("only one open Role Collection per seat", async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO role_collections (seat_id, arena_day, deadline_at)
     VALUES ('odin', '2026-11-11', now() + interval '4 hours')`
  );
  await expectUniqueViolation(() =>
    pool.query(
      `INSERT INTO role_collections (seat_id, arena_day, deadline_at)
       VALUES ('odin', '2026-11-12', now() + interval '4 hours')`
    )
  );
  // Different seat: allowed.
  await pool.query(
    `INSERT INTO role_collections (seat_id, arena_day, deadline_at)
     VALUES ('uriel', '2026-11-11', now() + interval '4 hours')`
  );
});

test("only one active King of Constellations", async (t) => {
  if (!guard(t)) return;
  await pool.query(`INSERT INTO king_records (user_id) VALUES (444)`);
  await expectUniqueViolation(() =>
    pool.query(`INSERT INTO king_records (user_id) VALUES (555)`)
  );
  // After the king is lost, a new one can be forged.
  await pool.query(
    `UPDATE king_records SET status = 'lost', lost_at = now() WHERE user_id = 444`
  );
  await pool.query(`INSERT INTO king_records (user_id) VALUES (555)`);
});

test("only one equipped title per member; stats persist", async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO members (user_id, username) VALUES (666, 'tester') ON CONFLICT DO NOTHING`
  );
  await pool.query(
    `INSERT INTO stats (user_id) VALUES (666) ON CONFLICT DO NOTHING`
  );

  await pool.query(
    `INSERT INTO member_titles (user_id, title_key, equipped) VALUES (666, 'title_a', TRUE)`
  );
  await expectUniqueViolation(() =>
    pool.query(
      `INSERT INTO member_titles (user_id, title_key, equipped) VALUES (666, 'title_b', TRUE)`
    )
  );
  // Equipping another title must move the flag (tested here as data-level
  // guarantee: unequip first, then equip).
  await pool.query(
    `UPDATE member_titles SET equipped = FALSE WHERE user_id = 666 AND title_key = 'title_a'`
  );
  await pool.query(
    `INSERT INTO member_titles (user_id, title_key, equipped) VALUES (666, 'title_b', TRUE)`
  );

  await pool.query(
    `UPDATE stats SET kills = 12, subdued = 7, win_streak = 3, best_win_streak = 5
      WHERE user_id = 666`
  );
  const stats = await pool.query(
    `SELECT kills, subdued, win_streak, best_win_streak FROM stats WHERE user_id = 666`
  );
  assert.deepEqual(stats.rows[0], {
    kills: 12,
    subdued: 7,
    win_streak: 3,
    best_win_streak: 5,
  });
});

test("reward transactions cannot duplicate (anti double-pay)", async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO reward_transactions (user_id, kind, amount, source_type, source_key)
     VALUES (666, 'bounty', 10000, 'reign', '1')`
  );
  await expectUniqueViolation(() =>
    pool.query(
      `INSERT INTO reward_transactions (user_id, kind, amount, source_type, source_key)
       VALUES (666, 'bounty', 10000, 'reign', '1')`
    )
  );
  // A different source key is a different reward: allowed.
  await pool.query(
    `INSERT INTO reward_transactions (user_id, kind, amount, source_type, source_key)
     VALUES (666, 'bounty', 20000, 'reign', '2')`
  );
});

test("settings table round-trips JSONB", async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('channels.alerts', '"1234567890"'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
  );
  const row = await pool.query(`SELECT value FROM settings WHERE key = 'channels.alerts'`);
  assert.equal(row.rows[0].value, "1234567890");
});

test("backup and restore round-trips data and keeps sequences working", async (t) => {
  if (!guard(t)) return;
  const { createBackup, restoreBackup } = require("../src/db/backup");

  // Ensure a known reward transaction exists with a non-trivial id.
  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reward_transactions WHERE user_id = 666`
  );
  assert.ok(before.rows[0].n >= 1);

  const backup = await createBackup({ dir: BACKUP_DIR, label: "test" }, pool);
  assert.ok(fs.existsSync(backup.file));
  assert.ok(backup.totalRows > 0);

  // Wipe the data.
  await pool.query(`DELETE FROM reward_transactions WHERE user_id = 666`);
  await pool.query(`DELETE FROM stats WHERE user_id = 666`);
  const wiped = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reward_transactions WHERE user_id = 666`
  );
  assert.equal(wiped.rows[0].n, 0);

  // Restore and verify.
  const restored = await restoreBackup(backup.file, pool);
  assert.ok(restored.reward_transactions >= 2);
  const after = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reward_transactions WHERE user_id = 666`
  );
  assert.equal(after.rows[0].n, before.rows[0].n);

  // Sequence must be resynced: a fresh insert must not collide.
  await pool.query(
    `INSERT INTO reward_transactions (user_id, kind, amount, source_type, source_key)
     VALUES (666, 'other', 1, 'manual', 'post-restore-test')`
  );

  // Backup file is reusable.
  await restoreBackup(backup.file, pool);
  const twice = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reward_transactions WHERE user_id = 666`
  );
  assert.equal(twice.rows[0].n, before.rows[0].n);
});

test("refusal counter lives on the reign (current holder query works)", async (t) => {
  if (!guard(t)) return;
  await pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at) VALUES ('surya', 666, now())`
  );
  await pool.query(
    `UPDATE reigns SET refusal_count = refusal_count + 1
      WHERE seat_id = 'surya' AND ended_at IS NULL`
  );
  const open = await pool.query(
    `SELECT refusal_count, holder_id FROM reigns WHERE seat_id = 'surya' AND ended_at IS NULL`
  );
  assert.equal(open.rows.length, 1);
  assert.equal(open.rows[0].refusal_count, 1);
  assert.equal(String(open.rows[0].holder_id), "666");

  // Closing the reign frees the seat for a new holder.
  await pool.query(
    `UPDATE reigns SET ended_at = now(), end_reason = 'defeated_kill' WHERE seat_id = 'surya'`
  );
  await pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at) VALUES ('surya', 999, now())`
  );
  const openCount = await pool.query(
    `SELECT COUNT(*)::int AS n FROM reigns WHERE seat_id = 'surya' AND ended_at IS NULL`
  );
  assert.equal(openCount.rows[0].n, 1);
});
