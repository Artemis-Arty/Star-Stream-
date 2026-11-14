"use strict";

/**
 * Embedded PostgreSQL helper for integration tests.
 * Each test file gets its own cluster, data dir and port range.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const TMP_ROOT = (() => {
  const opencode = "C:/Users/temp/AppData/Local/Temp/opencode";
  return fs.existsSync(opencode) ? opencode : os.tmpdir();
})();

/**
 * Boot an embedded PostgreSQL server + pool.
 * @param {string} label unique label (keeps dirs/ports apart per test file)
 * @returns {Promise<{pool: import('pg').Pool, stop: () => Promise<void>, unavailableReason: string|null}>}
 */
async function startTestDatabase(label) {
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch (err) {
    return { pool: null, stop: async () => {}, unavailableReason: `embedded-postgres unavailable: ${err.message}` };
  }

  const dataDir = path.join(TMP_ROOT, `starstream-${label}-${process.pid}`);
  const port = 57000 + (process.pid % 1500) + label.length * 7;

  let embedded;
  let pool;
  try {
    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      port,
      user: "postgres",
      password: "testpw",
      persistent: false,
      autoRehydrateSymlinks: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(`starstream_${label}`);

    const { Pool } = require("pg");
    pool = new Pool({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "testpw",
      database: `starstream_${label}`,
      max: 2,
    });
    await pool.query("SELECT 1");
    const database = `starstream_${label}`;
    return {
      pool,
      port,
      database,
      // Ready-to-use connection string for src/config/env DATABASE_URL.
      url: `postgresql://${encodeURIComponent("postgres")}:${encodeURIComponent(
        "testpw"
      )}@127.0.0.1:${port}/${database}`,
      stop: async () => {},
      unavailableReason: null,
      _embedded: embedded,
    };
  } catch (err) {
    if (pool) await pool.end().catch(() => {});
    if (embedded) await embedded.stop().catch(() => {});
    return {
      pool: null,
      stop: async () => {},
      unavailableReason: `embedded PostgreSQL failed to start: ${err.message}`,
    };
  }
}

/** Resolve after `ms` (used to bound teardown steps). */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort kill of whatever still listens on OUR test port, plus any
 * ORPHANED postgres.exe (its recorded parent process no longer exists -
 * which only happens after a broken teardown; live clusters always have a
 * live postmaster parent, so parallel test files are never touched).
 */
function killPortHolder(port) {
  if (!port) return;
  try {
    if (process.platform === "win32") {
      spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; ` +
            `foreach ($id in $p) { taskkill /f /t /pid $id 2>$null }; ` +
            `Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | ForEach-Object { ` +
            `$pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ErrorAction SilentlyContinue; ` +
            `if (-not $pp) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }`,
        ],
        { timeout: 15_000, windowsHide: true }
      );
    } else {
      spawnSync("fuser", ["-k", `${port}/tcp`], { timeout: 10_000 });
    }
  } catch {
    /* best effort - process exit must not depend on this */
  }
}

/**
 * Stop a database started by startTestDatabase and clean its files.
 *
 * Teardown must NEVER hang the runner: embedded-postgres' stop() can stall
 * when taskkill misses an orphaned worker, and a surviving worker keeps the
 * server's stdio pipes open - which holds Node's event loop alive forever
 * (the "all tests passed but `node --test` never prints a summary" hang).
 */
async function stopTestDatabase(handle) {
  if (!handle) return;
  try {
    if (handle.pool) {
      // Bound: a wedged client must not hang teardown (then the whole
      // runner waits forever on this file).
      await Promise.race([handle.pool.end().catch(() => {}), delay(5_000)]);
    }
    if (handle._embedded) {
      const proc = handle._embedded.process; // capture BEFORE stop() clears it
      const stop = Promise.resolve(handle._embedded.stop()).catch(() => {});
      await Promise.race([stop, delay(10_000)]);

      if (proc) {
        // Release OUR ends of the server's stdio pipes: an orphaned worker
        // holding the write end must not keep this process alive.
        for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
          try {
            if (stream && !stream.destroyed) stream.destroy();
          } catch {
            /* ignore */
          }
        }
        if (proc.exitCode === null && !proc.killed) {
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
        }
      }
      killPortHolder(handle.port);
    }
  } finally {
    /* best-effort cleanup below */
  }
}

module.exports = { startTestDatabase, stopTestDatabase, TMP_ROOT };
