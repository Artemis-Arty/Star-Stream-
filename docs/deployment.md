# Deployment guide

## 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** section → **Add Bot** → copy the **Token** (this goes in
   `DISCORD_TOKEN`, never anywhere else).
3. Copy the **Application ID** → `CLIENT_ID`.
4. **Privileged Gateway Intents:** leave all disabled. The bot uses the
   `Guilds` intent only (roles are fetched via REST), which keeps memory low.
5. **OAuth2 → URL Generator:**
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Manage Roles` (to grant/strip Constellation roles),
     `Send Messages`, `Embed Links`, `Use External Emojis`.
6. Invite the bot to your **test server first** (see docs/testing.md).

## 2. Provision PostgreSQL

Do **not** rely on host-local files — they do not survive redeployments.

Options:

- **Host-provided database** on Bot-Hosting.net (if your plan offers one), or
- **External provider** (Neon, Supabase, Aiven, CockroachDB free tier, ...).

Requirements: PostgreSQL 14+, connection URL with `?sslmode=require` when the
provider requires SSL. Put the URL in `DATABASE_URL`.

The bot applies migrations automatically on startup (`AUTO_MIGRATE=true`),
or run them manually: `npm run migrate`.

## 3. Configure the environment

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` | Discord application + server |
| `DATABASE_URL` | PostgreSQL connection URL |
| `TIMEZONE` | IANA timezone that decides Arena Days (e.g. `Asia/Kolkata`) |
| `COLLECTION_OPEN_HOUR` | Hour (0-23, in `TIMEZONE`) when an unfilled vacant seat re-opens its Role Collection on an Arena Day. Default `0` |
| `CHANNEL_RULES_ID`, `CHANNEL_ALERTS_ID`, `CHANNEL_CHALLENGE_ID` | The three game channels |
| `CHANNEL_LOG_ID` | Staff audit-log channel |
| `BACKUP_*` | Automatic backup directory/interval/retention |

Nothing else is hardcoded: channel IDs, role IDs and staff permissions are
runtime configuration (env or `/starstream-config`).

## 4. Register slash commands

```bash
npm run deploy
```

Registers all commands to the guild in `GUILD_ID` (instant updates — ideal
for a single-server bot and test iterations).

## 5. Deploy to Bot-Hosting.net

### 5a. Publish this folder to GitHub

The repository root must be the `star-stream/` folder (so `package.json` sits
at the top level). Two easy ways — no single-file conversion needed:

- **Web UI (no git installed):** create an empty GitHub repository, then drag
  the *contents* of `star-stream/` onto the repo page. GitHub uploads every
  file in one action.
- **Git:** `git init && git add . && git commit -m "Star Stream"` then push to
  your remote.

`.gitignore` already excludes `.env`, `node_modules/` and `backups/`, so no
secrets or member data can leak. Never upload your `.env` file — configure
environment variables on the host instead.

### 5b. Host setup

1. Connect the repository to a **Node.js** server on Bot-Hosting.net.
2. Set:
   - **Start command:** `npm start`
   - **Node version:** 20 or newer (24 recommended)
   - **Environment variables:** all keys from `.env` (the host's env UI).
3. Deploy. Watch the logs: you should see
   `Applying migration: 001_initial_schema.sql`, then
   `Logged in as <bot>#xxxx`.
4. Run `npm run deploy` once locally (or as a one-off host task) to register
   the slash commands.

Notes for the free tier:

- The pool defaults to 4 connections (`DB_POOL_SIZE`).
- Backups are written to `BACKUP_DIR`; on ephemeral storage download them
  off-host or point `BACKUP_DIR` at a mounted/external location
  (see docs/backup-recovery.md).

### 5c. Running on the free plan (256 MB RAM / 25% CPU / 512 MB storage)

Measured sizes of this project:

| Item | Size |
|---|---|
| Source + tests + docs | ~0.25 MB |
| `node_modules` with dev deps (incl. `embedded-postgres`) | ~122 MB |
| `node_modules` **without** dev deps (`npm install --omit=dev`) | ~18 MB |

The bot itself fits comfortably. Three conditions make it work on the
free plan:

1. **Install without dev dependencies.** Set the install/build command to
   `npm install --omit=dev` (or add `NODE_ENV=production` before install).
   `embedded-postgres` (104 MB of test-only PostgreSQL binaries) must not be
   installed on the host — tests run locally, never on the bot host.
2. **Use an external free database** (Neon, Supabase, ... — see §2) with
   `?sslmode=require`. Do not use a database hosted on the same
   Bot-Hosting.net account: databases on one account share the same
   resource pool, so the DB would compete with the bot's 256 MB / 25% CPU.
3. **Renew manually every 4 days** in the panel, or the server is stopped.

Recommended free-plan tuning:

- `DB_POOL_SIZE=2` (two connections are plenty for a single guild)
- `BACKUP_INTERVAL_MINUTES=720`, `BACKUP_RETENTION=4` to keep disk and
  memory bursts low (host also keeps hourly snapshots for 24 h)
- Postgres `shared_buffers` stays on the provider's side, so the bot process
  keeps its headroom for discord.js (typically 60–90 MB RSS)

Storage after deploy ≈ 18 MB `node_modules` + <1 MB source + a few MB of
backups — well under the 512 MB quota.

## 6. Post-deploy checklist

- [ ] `#rules`, `#alerts`, `#challenge` IDs set; bot can post in them
- [ ] Bot role positioned **above** the Constellation modifier roles
      (needed to grant/strip them)
- [ ] Staff permission keys configured (`/starstream-config`, Stage 8)
- [ ] The seven Constellation roles created in Discord with the exact
      official names (Zeus, Hades, Odin, Sun Wukong, Surya,
      Abyssal Black Flame Dragon, Uriel) and linked to their seats
- [ ] First automatic backup exists (`npm run backup` or wait the interval)
