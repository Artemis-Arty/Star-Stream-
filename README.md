# Star Stream: The Constellations

A competitive game-management Discord bot inspired by *Omniscient Reader's
Viewpoint*. It runs challenges, Constellation thrones, supervised matches,
bounties, Role Collections, achievements, titles, leaderboards and a full
staff audit trail — as one integrated Star Stream system.

> **Stage: 4 complete** — match supervision, proof-required result recording,
> throne transfers, refusals via no-show, disputes, staff match commands.
> See "Development stages" below for what is implemented so far.

## Features (per approved specification)

- **Challenges** — `/challenge` on Arena Days (Mon/Wed/Sat), 4-hour response
  window, refusal counter (3 → 4th challenge is last chance), one active
  challenge per Constellation, once per Challenger per seat per Arena Day.
- **Constellations** — the seven original thrones (Zeus, Hades, Odin,
  Sun Wukong, Surya, Abyssal Black Flame Dragon, Uriel) plus custom seats.
  Modifier role names are locked; the bot never renames roles.
- **Matches** — staff-supervised 1v1s with a 15-minute game-agreement window
  (default: 3 rounds OwO Battle or 3 rounds RPS), evidence submission,
  verification, disputes. The bot never auto-declares an unverified winner.
- **Role Collections** — vacant thrones open a 4-hour button sign-up; first
  two eligible unranked members compete in a staff-supervised match.
- **Rewards** — bounty growth (10,000 EXP per 14 days of reign) and defense
  rewards (2,500 EXP per 3 throne defenses, one per opponent per 3 days),
  recorded as permanent ledger transactions (staff grants the Tatsu EXP).
- **Stats** — Kills, Subdued (merged Defense Wins + Subdued statistic),
  win streaks, permanent battle history, lifetime leaderboards.
- **Achievements & titles** — config-driven, permanent, never lost.
- **Staff system** — configurable permission keys (no hardcoded hierarchy),
  full audit log (actor, action, previous/new value, reason).

## Tech stack

- Node.js 20+ (developed on 24), discord.js v14, PostgreSQL (via `pg`)
- Modular layout: `src/commands`, `src/events`, `src/systems`, `src/db`,
  `src/config`, `src/utils`, `src/logging`
- Low-memory design: `Guilds`-only intent, small connection pool, no
  privileged intents, no in-memory game state

## Project layout

```
star-stream/
├── package.json
├── .env.example            # copy to .env - never commit .env
├── scripts/
│   ├── check-syntax.js     # npm run check
│   ├── deploy-commands.js  # npm run deploy
│   ├── backup.js           # npm run backup
│   └── restore.js          # npm run restore <file> --yes
├── src/
│   ├── index.js            # entry point (boot order in file header)
│   ├── config/             # env, rules, achievements, titles, permissions
│   ├── db/                 # pool, migrations, backup/restore
│   ├── commands/           # member/ and staff/ slash commands
│   ├── events/             # Discord event handlers
│   ├── systems/            # challenge, match, throne, bounty, ...
│   ├── logging/            # leveled logger (secrets redacted)
│   └── utils/              # time (Arena Days), embeds, pagination
├── tests/                  # node:test suite (incl. real PostgreSQL tests)
└── docs/                   # deployment, backup/recovery, testing
```

## Quick start (development)

```bash
cd star-stream
npm install
copy .env.example .env      # then fill in DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DATABASE_URL
npm run check               # syntax-check every file
npm test                    # full test suite (starts an embedded PostgreSQL)
npm run migrate             # apply database migrations
npm run deploy              # register slash commands
npm start                   # run the bot
```

## Development stages

| Stage | Scope | Status |
|-------|-------|--------|
| 1 | Project structure, configuration, database | ✅ done |
| 2 | Member commands and profiles | ✅ done |
| 3 | Challenge system and refusal tracking | ✅ done |
| 4 | Match supervision and verification | ✅ done |
| 5 | Throne management and Role Collection | ✅ done |
| 6 | Bounties, defense rewards, King system | ⏳ |
| 7 | Achievements, titles, leaderboards | ⏳ |
| 8 | Staff management and automatic alerts | ⏳ |
| 9 | Testing, security review, deployment prep | ⏳ |

## Documentation

- [Deployment guide](docs/deployment.md) — Discord app, database, Bot-Hosting.net
- [Backup & recovery](docs/backup-recovery.md)
- [Testing environment](docs/testing.md)
