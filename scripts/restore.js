"use strict";

/**
 * CLI: restore the database from a backup file.
 *   node scripts/restore.js <file.json.gz> --yes
 *
 * Refuses to run without --yes. The restore itself is transactional:
 * on any failure the database is left exactly as it was.
 */

const path = require("path");
const { getConfig } = require("../src/config/env");
const { restoreBackup, listBackups } = require("../src/db/backup");
const { closePool } = require("../src/db/pool");
const { logger } = require("../src/logging/logger");

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const fileArg = args.find((arg) => !arg.startsWith("--"));

  if (!fileArg) {
    const cfg = getConfig();
    const backups = await listBackups(cfg.backup.dir);
    console.error("Usage: node scripts/restore.js <file.json.gz> --yes");
    if (backups.length > 0) {
      console.error("\nAvailable backups:");
      for (const file of backups) console.error(`  - ${file}`);
    }
    process.exitCode = 1;
    return;
  }

  if (!confirmed) {
    console.error(
      "Refusing to restore without confirmation. Re-run with --yes.\n" +
        "This REPLACES all current data in the database."
    );
    process.exitCode = 1;
    return;
  }

  const file = path.resolve(fileArg);
  console.log(`Restoring from: ${file}`);
  const restored = await restoreBackup(file);
  for (const [table, count] of Object.entries(restored)) {
    console.log(`  ${table}: ${count} row(s)`);
  }
  console.log("Restore complete.");
}

main()
  .catch((err) => {
    logger.error("Restore failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
