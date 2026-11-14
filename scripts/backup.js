"use strict";

/**
 * CLI: create a database backup.
 *   npm run backup              - manual backup
 *   npm run backup -- --label x - custom label
 *   npm run backup -- --prune   - only prune old backups
 */

const { getConfig } = require("../src/config/env");
const { createBackup, pruneBackups, listBackups } = require("../src/db/backup");
const { closePool } = require("../src/db/pool");
const { logger } = require("../src/logging/logger");

async function main() {
  const args = process.argv.slice(2);
  const labelIndex = args.indexOf("--label");
  const label = labelIndex >= 0 ? args[labelIndex + 1] : "manual";
  const pruneOnly = args.includes("--prune");

  const cfg = getConfig();

  if (!pruneOnly) {
    const result = await createBackup({ dir: cfg.backup.dir, label });
    console.log(`Backup created: ${result.file}`);
    console.log(`Rows: ${result.totalRows} | Size: ${result.bytes} bytes`);
  }

  const pruned = await pruneBackups(cfg.backup.dir, cfg.backup.retention);
  console.log(`Pruned ${pruned} old backup(s).`);

  const remaining = await listBackups(cfg.backup.dir);
  console.log(`${remaining.length} backup(s) on disk:`);
  for (const file of remaining) console.log(`  - ${file}`);
}

main()
  .catch((err) => {
    logger.error("Backup failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
