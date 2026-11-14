# Testing environment

## Principle

Nothing is ever tested against the live server first. Use a **test Discord
server** with test channels, test roles and a **separate test database**.

## 1. Test Discord server

1. Create a server (e.g. "Star Stream Test").
2. Create `#rules`, `#alerts`, `#challenge`, `#log` channels.
3. Create the seven Constellation roles with their exact official names.
4. Create two test members (one to play Challengers, one to hold thrones).
5. Invite the bot with the same application (same token is fine — the
   guild is restricted by `GUILD_ID` for command registration).

## 2. Test environment file

Create `.env.test` next to `.env`:

```ini
NODE_ENV=test
DISCORD_TOKEN=...same token...
CLIENT_ID=...same...
GUILD_ID=<test server id>
DATABASE_URL=postgresql://...separate test database...
TIMEZONE=UTC
CHANNEL_RULES_ID=<test channel ids>
CHANNEL_ALERTS_ID=...
CHANNEL_CHALLENGE_ID=...
CHANNEL_LOG_ID=...
AUTO_MIGRATE=true
```

Run with:

```powershell
$env:DOTENV_PATH=".env.test"; npm start
```

Commands are registered per-guild (`GUILD_ID`), so the live server never
sees test command changes.

## 3. Automated tests

```bash
npm run check    # syntax-check all JS files
npm test         # full suite
```

The suite includes **real PostgreSQL tests**: `tests/db.test.js` boots an
embedded PostgreSQL server (devDependency `embedded-postgres`), applies the
actual migrations and verifies:

- migrations apply and are idempotent
- the seven original Constellations are seeded with locked role names
- one active challenge per seat, once per challenger per seat per Arena Day
- one open Role Collection per seat, one active King, one equipped title
- reward transactions cannot double-pay
- backup → wipe → restore round-trip with working sequences
- refusal counter stored on the reign

`tests/stage2.test.js` covers the query layer against the same real database:

- bounty math (14-day ladder, frozen at reign end)
- leaderboard ordering, tie-breaking and personal ranks
- throne list with holders, bounties and reign timers
- battle history + "Constellations defeated" (throne-victory) counting
- achievement engine idempotency and title equip/unequip enforcement
- Role Collection entrant counts and DB-backed staff permission checks
- mocked `/profile`, `/stats`, `/leaderboard`, `/titles`, `/help` execution,
  including that `/profile` hides throne details from unranked members

`tests/commands.test.js` validates every command/component definition loads,
no command hardcodes Discord-side permissions, every staff command declares a
permission key, and the permission helper defaults to deny with an admin
bypass.

`tests/stage3.test.js` exercises the challenge system end to end against the
same real database:

- issuance rules: Arena Day gate, self/vacant/unknown-seat rejection,
  one-active-challenge-per-seat, once-per-Challenger-per-seat-per-day
- throne-loss waiting gate (blocked on the loss day, allowed next Arena Day)
- Accept/Refuse buttons: only the current holder may respond
- refusal counter increments, 4-hour timeout sweeps that are idempotent
  (a second sweep never double-counts)
- the fourth challenge: active refusal AND expiry both strip the modifier
  role, vacate the throne, arm the holder's waiting gate and announce in
  `#alerts`
- accept creates the match with the 15-minute game-agreement deadline and
  keeps the seat locked
- staff `/challenge-cancel`: permission denial, cancellation, audit entry
  (actor, previous/new value, reason) and daily-chance refund
- auto-cancel of pending challenges when a throne changes hands

`tests/stage4.test.js` exercises match supervision end to end against the
same real database:

- `/match-start` inside the 15-minute game-agreement window: game recorded,
  status flips to `in_progress`, public announcement, audit entry
- start validation: unknown match id, double start, window already lapsed
- window lapse sweep: cancels the match **and refunds** the challenger's
  daily challenge chance (re-issuance proof), idempotent second sweep
- result recording requires at least one valid http(s) proof link — no
  proof, malformed proof, wrong outcome/choice combos write nothing
- `attacker_victory + accept_throne`: throne transfers immediately (reign
  ends/starts, Discord roles swapped, `#alerts` announcement), winner stats
  (win counted, streak reset after accept, best keeps the peak), loser stats,
  `throne_accepts` +1, Arena-Day waiting gate armed, achievements, audit
- `defender_victory + subdue`: same reign stays open, +1 Subdued, defense
  event with the 3-day reward gate
- `abandon_attacker` (challenger forfeit): full win for the Constellation
  (wins + streak + Subdued + defense event), forfeiter gets a loss, throne
  unchanged
- `abandon_defender` (holder no-show): counted as a refusal with no stats;
  the fourth no-show strips the modifier role, vacates the throne and
  announces the vacancy
- two-throne winners: `seat_choice` required for `accept_throne`/`swap` when
  the winner already holds a throne — `won` moves them and releases the old
  seat, `current` keeps their seat and releases the won one (both verified
  by reign rows and role grant/removal records)
- disputes: open only on recorded results (effects stay while disputed),
  resolve returns the match to verified, duplicate/invalid operations
  rejected
- persistence: migrations re-run (restart simulation) with all results,
  evidence, disputes and stats intact; staff permission keys for the five
  new match commands

`tests/stage5.test.js` exercises Role Collections and throne management
end to end against the same real database:

- vacating a throne (`/throne-vacate`) ends the reign, arms the holder's
  waiting gate, removes the Discord modifier role, writes an audit entry
  and opens a 4-hour Role Collection in `#alerts` with a Join button
- opening is idempotent (no duplicate window), refuses held/unknown seats
- join rules: throne holders rejected (unranked only, no waiting gate),
  first two entrants accepted, duplicates rejected, third entrant rejected,
  joins after the deadline rejected (nothing written)
- the second entrant locks the collection and creates a staff-supervised
  `role_collection` match (first entrant = attacker, no 15-minute window)
- duel recording through the same `/match-result` path: proof required,
  started match required, no-show outcomes rejected (staff decides
  case-by-case), winner choices rejected (vacant seat), then winner stats
  + `throne_accepts` +1, loser stats, collection closed as `two_entrants`,
  reign started, role granted, `#alerts` announcement, audit entry
- deadline sweep (idempotent): 0 entrants -> closed `no_entrants`
  (reopens next Arena Day), 1 entrant -> closed `solo_entrant` with the
  role granted automatically (+1 `throne_accepts`, achievement unlock, no
  match stats), entrant who became ranked -> voided (seat stays vacant),
  2 entrants -> left open for staff
- `/collection-manage` award: reason required, throne holders cannot
  receive a seat, collection closed, pending duel cancelled, role granted,
  audit entry; close: reason required, no winner, pending duel cancelled,
  audit entry
- `/throne-grant`: vacant-seat-only repair tool, closes any open
  collection, does **not** count as a throne accept (documented decision),
  audit entry
- `/throne-strip`: only the actual holder can be stripped, reason
  required, vacated seat opens a collection, audit entry
- Arena Day re-opener: only on Arena Days, only at/after
  `COLLECTION_OPEN_HOUR` (env, TIMEZONE), one window per vacant seat per
  Arena Day, idempotent, announcements per opened collection
- persistence: migrations re-run (restart simulation) with reigns, stats,
  `throne_accepts`, audit trail and open collections intact; staff
  permission keys for the four new staff commands and the Join button
  routing through the component loader

If the embedded server cannot start (e.g. restricted CI), those tests skip
with a reason; the pure-logic tests always run.

## 4. Manual test checklist (per stage)

Run through this after each stage before touching the live server:

1. **Happy path** — the main flow works end to end.
2. **Invalid inputs** — wrong day, non-Constellation target, missing
   options: the bot replies with a clear error, nothing is written.
3. **Permissions** — members cannot run staff commands; staff without the
   configured key cannot run them either.
4. **Duplicate interactions** — double-clicking a button or re-running a
   command never double-applies effects (unique constraints + idempotency).
5. **Persistence** — kill the bot mid-flow (`Ctrl+C`), restart, confirm
   pending challenges/deadlines resume from the database.
6. **Restart recovery** — let a 4-hour window expire while the bot is
   down, restart, confirm the expiry is processed once on startup.
