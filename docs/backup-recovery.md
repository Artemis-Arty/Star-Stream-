# Backup & recovery

Star Stream stores **all** game data in PostgreSQL. Backups are logical
exports (gzipped JSON) produced by the bot itself — no `pg_dump` binary
required, so they work on any host.

## What is backed up

Every public table: members, stats, seats, reigns, challenges, matches,
evidence, disputes, role collections, defense events/rewards, reward
transactions, achievements, titles, king records, staff permissions/audit
log, settings and migration state.

`schema_migrations` is exported for reference but **not** restored — the
deployed code always owns the schema state, so restoring an older backup
into a newer schema is safe.

## Creating a backup

```bash
npm run backup                 # manual backup + prune old ones
npm run backup -- --label pre-upgrade
npm run backup -- --prune      # only prune
```

Automatic backups run every `BACKUP_INTERVAL_HOURS` (default 24h) while the
bot is running, keeping the newest `BACKUP_RETENTION` (default 14).

Files: `BACKUP_DIR/starstream-<timestamp>-<label>.json.gz`.

## Restoring

```bash
node scripts/restore.js backups/starstream-2026-11-13T11-46-47-359Z-manual.json.gz --yes
```

Guarantees:

- **Transactional** — a failed restore rolls back completely; the database
  is left exactly as it was.
- **Complete replace** — all tables are truncated and reloaded from the
  backup (it is a point-in-time snapshot, not a merge).
- **Sequences resynced** — primary keys keep working after the restore.
- **Confirmation required** — without `--yes` the command refuses to run.

## Recovery scenarios

| Scenario | Action |
|---|---|
| Bot/host crash, redeploy | Nothing to do — data lives in PostgreSQL; timers are rebuilt from timestamps on startup |
| Accidental data change | Restore the most recent backup, or ask staff to correct with `/set-stats`, `/set-bounty` (Stage 8) |
| Database lost entirely | Create a new database, set `DATABASE_URL`, start the bot (migrations run), then restore the latest backup |
| Pre-upgrade safety net | `npm run backup -- --label pre-upgrade` before deploying a new version |

## Off-host retention (recommended)

On ephemeral hosting, `BACKUP_DIR` may disappear with the container. After
each backup, copy the file somewhere durable (cloud storage, another
machine), or schedule `npm run backup` from an external cron and pull the
files via your host's file manager/SFTP.

## Optional: pg_dump

If your host provides the PostgreSQL client tools, a native dump is also
valid:

```bash
pg_dump "$DATABASE_URL" -Fc -f starstream.dump
pg_restore --clean --if-exists -d "$DATABASE_URL" starstream.dump
```

The built-in backup remains the recommended path because it needs no
binaries and is tested in the automated suite.
