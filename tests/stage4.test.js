"use strict";

/**
 * Stage 4 tests: match supervision and verification.
 *
 * Covers /match-start inside the 15-minute window, window-lapse cancellation
 * with daily-chance refund, proof-required result recording, every outcome
 * path (throne taken / kill / subdue / swap with seat choice / both no-shows),
 * refusal counting and the fourth-refusal strip, disputes, staff permission
 * keys, and persistence across a simulated restart.
 *
 * Runs against an embedded PostgreSQL server; skips with a reason if the
 * embedded server cannot start.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { startTestDatabase, stopTestDatabase, TMP_ROOT } = require("./helpers/testdb");

let handle = null;
let available = false;
let skipReason = "setup not run";
let guild = null;
let config = null;

// Known instant: Wed 2026-11-11 (Arena Day) in UTC.
const WEDNESDAY = new Date("2026-11-11T12:00:00Z");
const PROOF = "https://cdn.example/proof.png";

function makeGuild() {
  const sent = [];
  const removedRoles = [];
  const addedRoles = [];
  return {
    sent,
    removedRoles,
    addedRoles,
    channels: {
      fetch: async (channelId) => ({
        id: String(channelId),
        isTextBased: () => true,
        send: async (payload) => {
          const message = {
            id: String(1000000000000000000 + sent.length + 1),
            channel: String(channelId),
            payload,
          };
          sent.push(message);
          return message;
        },
      }),
    },
    members: {
      fetch: async (userId) => ({
        id: String(userId),
        roles: {
          remove: async (roleId) => {
            removedRoles.push({ userId: String(userId), roleId: String(roleId) });
          },
          add: async (roleId) => {
            addedRoles.push({ userId: String(userId), roleId: String(roleId) });
          },
        },
      }),
    },
  };
}

test.before(async () => {
  handle = await startTestDatabase("stage4");
  if (!handle.pool) {
    skipReason = handle.unavailableReason;
    return;
  }

  // Point the application's global pool at the embedded server.
  process.env.NODE_ENV = "test";
  process.env.DISCORD_TOKEN = "test-token";
  process.env.CLIENT_ID = "123456789012345678";
  process.env.GUILD_ID = "123456789012345678";
  process.env.DATABASE_URL = handle.url;

  const { runMigrations } = require("../src/db/migrate");
  await runMigrations(handle.pool);

  guild = makeGuild();
  config = {
    timezone: "UTC",
    discord: { guildId: "123456789012345678" },
    channels: { rules: "100", alerts: "200", challenge: "300", log: "400" },
  };

  const people = [
    [9101, "zeus-holder"],
    [9102, "hades-holder"],
    [9103, "wukong-holder"],
    [9104, "odin-holder"],
    [9201, "challenger-a"],
    [9202, "challenger-b"],
    [9203, "challenger-c"],
    [9204, "challenger-d"],
    [9205, "challenger-e"],
    [9206, "challenger-f"],
  ];
  for (const [id, name] of people) {
    await handle.pool.query(
      `INSERT INTO members (user_id, username) VALUES ($1, $2)`,
      [id, name]
    );
    await handle.pool.query(`INSERT INTO stats (user_id) VALUES ($1)`, [id]);
  }

  await handle.pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ('zeus', '9101', now() - interval '1 day'),
            ('hades', '9102', now() - interval '1 day'),
            ('odin', '9104', now() - interval '1 day'),
            ('sun-wukong', '9103', now() - interval '1 day')`
  );

  // Discord roles configured so role grants/removals are observable.
  await handle.pool.query(`UPDATE seats SET role_id = '999001' WHERE seat_id = 'zeus'`);
  await handle.pool.query(`UPDATE seats SET role_id = '999002' WHERE seat_id = 'hades'`);
  await handle.pool.query(`UPDATE seats SET role_id = '999003' WHERE seat_id = 'odin'`);
  await handle.pool.query(
    `UPDATE seats SET role_id = '999004' WHERE seat_id = 'sun-wukong'`
  );

  available = true;
});

test.after(async () => {
  if (available) {
    const { closePool } = require("../src/db/pool");
    await closePool().catch(() => {});
  }
  await stopTestDatabase(handle);
  try {
    fs.rmSync(path.join(TMP_ROOT, `starstream-stage4-${process.pid}`), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
  } catch {
    /* best effort */
  }
});

function guard(t) {
  if (!available) {
    t.skip(skipReason);
    return false;
  }
  return true;
}

async function row(sql, params = []) {
  const result = await handle.pool.query(sql, params);
  return result.rows[0] || null;
}

async function rows(sql, params = []) {
  const result = await handle.pool.query(sql, params);
  return result.rows;
}

function sentTitles() {
  return guild.sent.flatMap((m) =>
    (m.payload?.embeds || []).map((e) => e.data?.title || "")
  );
}

function hasRemoved(userId, roleId) {
  return guild.removedRoles.some(
    (o) => o.userId === String(userId) && o.roleId === String(roleId)
  );
}

function hasAdded(userId, roleId) {
  return guild.addedRoles.some(
    (o) => o.userId === String(userId) && o.roleId === String(roleId)
  );
}

/** Issue + accept a challenge to produce a scheduled match. */
async function createAcceptedMatch(challengerId, holderId, seatId, at = WEDNESDAY) {
  const { issueChallenge, acceptChallenge } = require("../src/systems/challenge");
  const issued = await issueChallenge({ challengerId, seatId, guild, config, at });
  assert.equal(issued.ok, true, `issue failed: ${issued.code}`);
  const accepted = await acceptChallenge({
    challengeId: Number(issued.challenge.challenge_id),
    userId: holderId,
    guild,
    config,
    at,
  });
  assert.equal(accepted.ok, true, `accept failed: ${accepted.code}`);
  return {
    challengeId: Number(issued.challenge.challenge_id),
    matchId: Number(accepted.match.match_id),
  };
}

async function start(matchId, at = WEDNESDAY, game = "Chess") {
  const { startMatch } = require("../src/systems/match");
  return startMatch({
    matchId,
    game,
    actorId: "9900",
    guild,
    config,
    at,
  });
}

async function record(args) {
  const { recordResult } = require("../src/systems/match");
  return recordResult({
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
    ...args,
  });
}

// ------------------------------------------------------------- start flow

test("match-start records the game inside the 15-minute window", async (t) => {
  if (!guard(t)) return;
  const { matchId, challengeId } = await createAcceptedMatch("9201", "9101", "zeus");

  const before = guild.sent.length;
  const scheduled = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(scheduled.status, "scheduled");
  assert.ok(scheduled.game_agreed_deadline_at, "window timestamp must be persisted");

  const result = await start(matchId);
  assert.equal(result.ok, true, result.code);

  const saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(saved.status, "in_progress");
  assert.equal(saved.game_agreed, "Chess");
  assert.ok(saved.started_at);
  assert.ok(guild.sent.length > before, "start must be announced");
  assert.ok(sentTitles().some((title) => title.includes("Match started")));

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'match.start' AND target_id = $1`,
    [String(matchId)]
  );
  assert.ok(audit, "start must be audited");
  assert.equal(String(audit.actor_id), "9900");

  // Stash for later tests.
  state.match1 = matchId;
  state.challenge1 = challengeId;
});

const state = {};

test("match-start rejects bad ids and double starts", async (t) => {
  if (!guard(t)) return;
  const { startMatch } = require("../src/systems/match");

  const missing = await startMatch({
    matchId: 999999,
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "NOT_FOUND");

  const again = await start(state.match1);
  assert.equal(again.ok, false);
  assert.equal(again.code, "NOT_SCHEDULED");
});

test("a lapsed game-agreement window cancels the match and refunds the chance", async (t) => {
  if (!guard(t)) return;
  const { processExpiredMatches } = require("../src/systems/match");
  const { issueChallenge, cancelChallenge } = require("../src/systems/challenge");

  const { matchId: match2, challengeId: challenge2 } = await createAcceptedMatch(
    "9202",
    "9102",
    "hades"
  );

  // Starting after the 15-minute window is refused.
  const late = await start(match2, new Date(WEDNESDAY.getTime() + 16 * 60_000));
  assert.equal(late.ok, false);
  assert.equal(late.code, "WINDOW_EXPIRED");
  let saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [match2]);
  assert.equal(saved.status, "scheduled");

  // The sweeper cancels it and refunds the challenger's daily chance.
  const processed = await processExpiredMatches({
    guild,
    config,
    at: new Date(WEDNESDAY.getTime() + 20 * 60_000),
  });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].refunded, true);

  saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [match2]);
  assert.equal(saved.status, "cancelled");
  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challenge2,
  ]);
  assert.equal(challenge.status, "cancelled");
  assert.match(challenge.notes, /refunded/);
  assert.ok(sentTitles().some((title) => title.includes("no game agreed")));

  // Refund proof: the same challenger can challenge the same seat again today.
  const again = await issueChallenge({
    challengerId: "9202",
    seatId: "hades",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(again.ok, true, `refund failed: ${again.code}`);
  const cancelled = await cancelChallenge({
    challengeId: Number(again.challenge.challenge_id),
    actorId: "9900",
    reason: "test cleanup",
    at: WEDNESDAY,
  });
  assert.equal(cancelled.ok, true);

  // Idempotent: a second sweep processes nothing.
  const second = await processExpiredMatches({
    guild,
    config,
    at: new Date(WEDNESDAY.getTime() + 20 * 60_000),
  });
  assert.equal(second.length, 0);

  state.match2 = match2;
});

// ---------------------------------------------------- result validation

test("results require proof and valid choices before anything is written", async (t) => {
  if (!guard(t)) return;

  let r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    winnerChoice: "accept_throne",
    proof: [],
  });
  assert.equal(r.code, "PROOF_REQUIRED");

  r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    winnerChoice: "accept_throne",
    proof: ["not-a-url"],
  });
  assert.equal(r.code, "INVALID_PROOF");

  r = await record({
    matchId: state.match1,
    outcome: "other",
    proof: [PROOF],
  });
  assert.equal(r.code, "INVALID_OUTCOME");

  r = await record({
    matchId: state.match1,
    outcome: "defender_victory",
    winnerChoice: "kill",
    proof: [PROOF],
  });
  assert.equal(r.code, "INVALID_CHOICE");

  // Swap needs the defeated challenger to hold a throne (9201 holds none).
  r = await record({
    matchId: state.match1,
    outcome: "defender_victory",
    winnerChoice: "swap",
    proof: [PROOF],
  });
  assert.equal(r.code, "ILLEGAL_CHOICE");

  const saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [state.match1]);
  assert.equal(saved.status, "in_progress", "failed attempts must not mutate the match");
  assert.equal(saved.winner_id, null);
  assert.equal(
    (await rows(`SELECT * FROM match_evidence WHERE match_id = $1`, [state.match1])).length,
    0,
    "no evidence rows without proof"
  );
});

// ------------------------------------------------- attacker takes the throne

test("attacker_victory + accept_throne transfers the throne immediately", async (t) => {
  if (!guard(t)) return;

  const r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    winnerChoice: "accept_throne",
    proof: ["https://cdn.example/proof1.png", "https://cdn.example/proof2.png"],
    notes: "chess 2-1",
  });
  assert.equal(r.ok, true, r.code);

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [state.match1]);
  assert.equal(match.status, "verified");
  assert.equal(String(match.winner_id), "9201");
  assert.equal(match.outcome, "attacker_victory");
  assert.equal(match.winner_choice, "accept_throne");
  assert.equal(String(match.verified_by), "9900");
  assert.equal(String(match.result_submitted_by), "9900");
  assert.match(match.notes, /throne choice: won/);

  const evidence = await rows(
    `SELECT * FROM match_evidence WHERE match_id = $1 ORDER BY evidence_id`,
    [state.match1]
  );
  assert.equal(evidence.length, 2);
  assert.equal(String(evidence[0].submitted_by), "9900");

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    state.challenge1,
  ]);
  assert.equal(challenge.status, "completed");

  const oldReign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'zeus' AND holder_id = '9101' AND ended_at IS NOT NULL`
  );
  assert.ok(oldReign);
  assert.equal(oldReign.end_reason, "match_defeat");
  assert.equal(String(oldReign.ended_by_match_id), String(state.match1));

  const newReign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'zeus' AND ended_at IS NULL`
  );
  assert.equal(String(newReign.holder_id), "9201");
  assert.equal(Number(newReign.refusal_count), 0);

  const loser = await row(`SELECT * FROM members WHERE user_id = '9101'`);
  assert.ok(loser.throne_lost_at, "defeated holder waits out the Arena-Day gate");

  const winnerStats = await row(`SELECT * FROM stats WHERE user_id = '9201'`);
  assert.equal(Number(winnerStats.wins), 1);
  assert.equal(Number(winnerStats.losses), 0);
  assert.equal(Number(winnerStats.total_matches), 1);
  assert.equal(Number(winnerStats.win_streak), 0, "accepting a throne resets the streak");
  assert.equal(Number(winnerStats.best_win_streak), 1, "best still records the peak");

  const loserStats = await row(`SELECT * FROM stats WHERE user_id = '9101'`);
  assert.equal(Number(loserStats.losses), 1);
  assert.equal(Number(loserStats.win_streak), 0);

  const winnerMember = await row(`SELECT * FROM members WHERE user_id = '9201'`);
  assert.equal(Number(winnerMember.throne_accepts), 1);

  assert.ok(hasRemoved("9101", "999001"), "defeated holder loses the role");
  assert.ok(hasAdded("9201", "999001"), "winner gains the role");
  assert.ok(
    sentTitles().some((title) => title.includes("Throne changed hands")),
    "throne transfer announced in #alerts"
  );

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'match.record' AND target_id = $1`,
    [String(state.match1)]
  );
  assert.ok(audit, "result recording must be audited");

  const achievement = await row(
    `SELECT * FROM achievements_unlocked WHERE user_id = '9201' AND achievement_key = 'throne_conqueror'`
  );
  assert.ok(achievement, "taking a throne unlocks Throne Conqueror");

  // Recording the same result twice is impossible.
  const again = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    winnerChoice: "kill",
    proof: [PROOF],
  });
  assert.equal(again.ok, false);
  assert.equal(again.code, "NOT_IN_PROGRESS");
});

// ------------------------------------------- defender wins, subdue path

test("defender_victory + subdue keeps the throne and records a defense", async (t) => {
  if (!guard(t)) return;
  const { matchId, challengeId } = await createAcceptedMatch("9203", "9102", "hades");
  const started = await start(matchId, WEDNESDAY, "Free Fire");
  assert.equal(started.ok, true, started.code);

  const hadesReignBefore = await row(
    `SELECT * FROM reigns WHERE seat_id = 'hades' AND ended_at IS NULL`
  );

  const r = await record({
    matchId,
    outcome: "defender_victory",
    winnerChoice: "subdue",
    proof: [PROOF],
  });
  assert.equal(r.ok, true, r.code);
  assert.equal(r.defenseCounted, true);

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(match.status, "verified");
  assert.equal(String(match.winner_id), "9102");
  assert.equal(match.winner_choice, "subdue");

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challengeId,
  ]);
  assert.equal(challenge.status, "completed");

  const hadesReignAfter = await row(
    `SELECT * FROM reigns WHERE seat_id = 'hades' AND ended_at IS NULL`
  );
  assert.equal(
    String(hadesReignAfter.reign_id),
    String(hadesReignBefore.reign_id),
    "defending keeps the same reign open"
  );

  const stats = await row(`SELECT * FROM stats WHERE user_id = '9102'`);
  assert.equal(Number(stats.wins), 1);
  assert.equal(Number(stats.win_streak), 1);
  assert.equal(Number(stats.subdued), 1, "every successful defense adds Subdued");

  const attackerStats = await row(`SELECT * FROM stats WHERE user_id = '9203'`);
  assert.equal(Number(attackerStats.losses), 1);
  assert.equal(Number(attackerStats.win_streak), 0);

  const defense = await row(
    `SELECT * FROM defense_events WHERE match_id = $1`,
    [matchId]
  );
  assert.ok(defense, "defense event recorded");
  assert.equal(defense.counted_for_reward, true);

  state.match7 = matchId;
});

// --------------------------------------------------- challenger forfeits

test("challenger no-show forfeits: full win for the Constellation", async (t) => {
  if (!guard(t)) return;
  const { matchId, challengeId } = await createAcceptedMatch("9204", "9104", "odin");
  const started = await start(matchId);
  assert.equal(started.ok, true, started.code);

  const r = await record({
    matchId,
    outcome: "abandon_attacker",
    proof: [PROOF],
  });
  assert.equal(r.ok, true, r.code);

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(match.status, "verified");
  assert.equal(String(match.winner_id), "9104");
  assert.equal(String(match.abandoned_by), "9204");
  assert.equal(match.winner_choice, "none");

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challengeId,
  ]);
  assert.equal(challenge.status, "completed", "forfeit consumes the daily chance");

  const defenderStats = await row(`SELECT * FROM stats WHERE user_id = '9104'`);
  assert.equal(Number(defenderStats.wins), 1);
  assert.equal(Number(defenderStats.win_streak), 1);
  assert.equal(Number(defenderStats.subdued), 1);

  const attackerStats = await row(`SELECT * FROM stats WHERE user_id = '9204'`);
  assert.equal(Number(attackerStats.losses), 1);
  assert.equal(Number(attackerStats.win_streak), 0);

  const defense = await row(`SELECT * FROM defense_events WHERE match_id = $1`, [
    matchId,
  ]);
  assert.ok(defense, "forfeit still counts as a defense");

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(String(reign.holder_id), "9104", "throne unchanged on a forfeit");

  assert.ok(sentTitles().some((title) => title.includes("Challenger forfeited")));

  state.match8 = matchId;
});

// ------------------------------------------------ holder no-show (refusal)

test("holder no-show counts as a refusal without touching stats", async (t) => {
  if (!guard(t)) return;
  const { matchId, challengeId } = await createAcceptedMatch("9205", "9104", "odin");
  const started = await start(matchId);
  assert.equal(started.ok, true, started.code);

  const r = await record({
    matchId,
    outcome: "abandon_defender",
    proof: [PROOF],
  });
  assert.equal(r.ok, true, r.code);

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(match.status, "abandoned");
  assert.equal(match.winner_id, null);
  assert.equal(String(match.abandoned_by), "9104");
  assert.equal(match.outcome, "abandon_defender");

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challengeId,
  ]);
  assert.equal(challenge.status, "refused");
  assert.equal(String(challenge.refuser_id), "9104");

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(Number(reign.refusal_count), 1);
  assert.equal(String(reign.holder_id), "9104");

  const defenderStats = await row(`SELECT * FROM stats WHERE user_id = '9104'`);
  assert.equal(Number(defenderStats.wins), 1, "no stats for a match never played");
  const attackerStats = await row(`SELECT * FROM stats WHERE user_id = '9205'`);
  assert.equal(Number(attackerStats.total_matches), 0);

  const defenses = await rows(
    `SELECT * FROM defense_events WHERE defender_id = '9104'`
  );
  assert.equal(defenses.length, 1, "no defense event for a no-show");

  state.match9 = matchId;
});

test("the fourth holder no-show strips the role and vacates the throne", async (t) => {
  if (!guard(t)) return;
  // Put Hades at 3 refusals so this no-show is the fourth challenge.
  await handle.pool.query(
    `UPDATE reigns SET refusal_count = 3 WHERE seat_id = 'hades' AND ended_at IS NULL`
  );

  const { matchId, challengeId } = await createAcceptedMatch("9206", "9102", "hades");
  const started = await start(matchId);
  assert.equal(started.ok, true, started.code);

  const r = await record({
    matchId,
    outcome: "abandon_defender",
    proof: [PROOF],
  });
  assert.equal(r.ok, true, r.code);

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challengeId,
  ]);
  assert.equal(challenge.status, "stripped");
  assert.equal(challenge.strip_applied, true);

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'hades' AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1`
  );
  assert.equal(reign.end_reason, "refusal_limit");
  assert.equal(Number(reign.refusal_count), 4);
  assert.equal(String(reign.ended_by_match_id), String(matchId));

  const holder = await row(`SELECT * FROM members WHERE user_id = '9102'`);
  assert.ok(holder.throne_lost_at);

  assert.ok(hasRemoved("9102", "999002"), "stripped role removed from Discord");
  assert.ok(
    sentTitles().some((title) => title.includes("Throne vacant")),
    "vacancy announced in #alerts"
  );
  assert.ok(
    sentTitles().some((title) => title.includes("Fourth no-show")),
    "result announced with the strip"
  );

  const openReign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'hades' AND ended_at IS NULL`
  );
  assert.equal(openReign, null, "seat is vacant for a Role Collection");

  state.match10 = matchId;
});

// ------------------------------------------------------------- disputes

test("disputes open and resolve on recorded results only", async (t) => {
  if (!guard(t)) return;
  const { openDispute, resolveDispute } = require("../src/systems/match");

  let d = await openDispute({
    matchId: state.match1,
    reporterId: "9201",
    reason: "wrong winner reported",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.ok, true, d.code);
  let match = await row(`SELECT * FROM matches WHERE match_id = $1`, [state.match1]);
  assert.equal(match.status, "disputed");

  // Effects stay while disputed (approved) - the verified result is untouched.
  assert.equal(String(match.winner_id), "9201");

  d = await openDispute({
    matchId: state.match1,
    reason: "again",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.code, "ALREADY_DISPUTED");

  d = await openDispute({
    matchId: state.match1,
    reason: "   ",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.code, "DISPUTE_REASON_REQUIRED");

  d = await openDispute({
    matchId: state.match9, // abandoned - never recorded
    reason: "cannot dispute this",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.code, "NOT_VERIFIED");

  d = await resolveDispute({
    matchId: state.match9,
    resolution: "n/a",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.code, "NOT_DISPUTED");

  d = await resolveDispute({
    matchId: state.match1,
    resolution: "original result upheld",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.ok, true, d.code);
  match = await row(`SELECT * FROM matches WHERE match_id = $1`, [state.match1]);
  assert.equal(match.status, "verified");
  const dispute = await row(
    `SELECT * FROM match_disputes WHERE match_id = $1`,
    [state.match1]
  );
  assert.equal(dispute.status, "resolved");
  assert.equal(String(dispute.resolved_by), "9900");
  assert.equal(dispute.resolution, "original result upheld");

  d = await resolveDispute({
    matchId: state.match1,
    resolution: "again",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(d.code, "NOT_DISPUTED");
});

// --------------------------------------- two-throne winners (seat choice)

test("swap requires a seat choice and applies the winner's pick", async (t) => {
  if (!guard(t)) return;
  // Odin's holder (9104) challenges Zeus, now held by 9201.
  const { matchId, challengeId } = await createAcceptedMatch("9104", "9201", "zeus");
  const started = await start(matchId, WEDNESDAY, "PUBG");
  assert.equal(started.ok, true, started.code);

  let r = await record({
    matchId,
    outcome: "defender_victory",
    winnerChoice: "swap",
    proof: [PROOF],
  });
  assert.equal(r.code, "SEAT_CHOICE_REQUIRED");
  let saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(saved.status, "in_progress", "failed attempt must not record");

  // Winner picks 'won': takes the challenger's Odin, releases their own Zeus.
  r = await record({
    matchId,
    outcome: "defender_victory",
    winnerChoice: "swap",
    seatChoice: "won",
    proof: [PROOF],
    notes: "swap accepted",
  });
  assert.equal(r.ok, true, r.code);

  saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [matchId]);
  assert.equal(saved.status, "verified");
  assert.equal(String(saved.winner_id), "9201");
  assert.equal(saved.winner_choice, "swap");
  assert.match(saved.notes, /throne choice: won/);

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challengeId,
  ]);
  assert.equal(challenge.status, "completed");

  const odinOpen = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(String(odinOpen.holder_id), "9201", "winner took the won throne");

  const zeusOpen = await row(
    `SELECT * FROM reigns WHERE seat_id = 'zeus' AND ended_at IS NULL`
  );
  assert.equal(zeusOpen, null, "winner's own throne released to a Role Collection");

  const released = await row(
    `SELECT * FROM reigns WHERE seat_id = 'zeus' AND holder_id = '9201'
       AND ended_at IS NOT NULL`
  );
  assert.ok(released, "the winner's released throne must be recorded");
  assert.equal(released.end_reason, "seat_released");

  const oldOdin = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND holder_id = '9104' AND ended_at IS NOT NULL`
  );
  assert.equal(oldOdin.end_reason, "match_defeat");
  assert.equal(String(oldOdin.ended_by_match_id), String(matchId));

  assert.ok(hasRemoved("9104", "999003"), "defeated challenger loses their role");
  assert.ok(hasRemoved("9201", "999001"), "released seat role removed");
  assert.ok(hasAdded("9201", "999003"), "winner gains the won throne's role");

  const winnerStats = await row(`SELECT * FROM stats WHERE user_id = '9201'`);
  assert.equal(Number(winnerStats.wins), 2);
  assert.equal(Number(winnerStats.win_streak), 1);
  assert.equal(Number(winnerStats.subdued), 1);

  const winnerMember = await row(`SELECT * FROM members WHERE user_id = '9201'`);
  assert.equal(
    Number(winnerMember.throne_accepts),
    1,
    "swap is not an accept - counter unchanged from the earlier accept_throne"
  );

  const loserStats = await row(`SELECT * FROM stats WHERE user_id = '9104'`);
  assert.equal(Number(loserStats.wins), 1);
  assert.equal(Number(loserStats.losses), 1);
  assert.equal(Number(loserStats.win_streak), 0);

  const defense = await row(`SELECT * FROM defense_events WHERE match_id = $1`, [
    matchId,
  ]);
  assert.ok(defense && defense.counted_for_reward === true);

  state.match12 = matchId;
});

test("accept_throne with seat_choice 'current' keeps the old throne", async (t) => {
  if (!guard(t)) return;
  // 9201 now holds Odin and challenges Sun Wukong (9103).
  const { matchId, challengeId } = await createAcceptedMatch("9201", "9103", "sun-wukong");
  const started = await start(matchId);
  assert.equal(started.ok, true, started.code);

  const odinBefore = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(String(odinBefore.holder_id), "9201");

  const r = await record({
    matchId,
    outcome: "attacker_victory",
    winnerChoice: "accept_throne",
    seatChoice: "current",
    proof: [PROOF],
  });
  assert.equal(r.ok, true, r.code);

  const odinAfter = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(
    String(odinAfter.reign_id),
    String(odinBefore.reign_id),
    "winner kept their original throne"
  );

  const wukongOpen = await row(
    `SELECT * FROM reigns WHERE seat_id = 'sun-wukong' AND ended_at IS NULL`
  );
  assert.equal(wukongOpen, null, "the won throne was released to a Role Collection");

  assert.ok(hasRemoved("9103", "999004"), "defeated holder loses the role");
  assert.ok(!hasAdded("9201", "999004"), "winner does not gain the released seat");
  assert.ok(!hasRemoved("9201", "999003"), "winner keeps their old role");

  const stats = await row(`SELECT * FROM stats WHERE user_id = '9201'`);
  assert.equal(Number(stats.wins), 3);
  assert.equal(Number(stats.win_streak), 0, "accept-throne choice resets the streak");
  assert.equal(Number(stats.best_win_streak), 2);
  assert.equal(Number(stats.subdued), 1);

  const member = await row(`SELECT * FROM members WHERE user_id = '9201'`);
  assert.equal(
    Number(member.throne_accepts),
    1,
    "keeping the old seat does not count as accepting a throne"
  );

  const loserStats = await row(`SELECT * FROM stats WHERE user_id = '9103'`);
  assert.equal(Number(loserStats.losses), 1);

  const challenge = await row(`SELECT * FROM challenges WHERE challenge_id = $1`, [
    challengeId,
  ]);
  assert.equal(challenge.status, "completed");

  state.match13 = matchId;
});

// ------------------------------------------------------------ persistence

test("all results survive a simulated restart (migrations re-run + re-read)", async (t) => {
  if (!guard(t)) return;
  const { runMigrations } = require("../src/db/migrate");
  await runMigrations(handle.pool); // idempotent - no data loss

  const match1 = await row(`SELECT * FROM matches WHERE match_id = $1`, [state.match1]);
  assert.equal(match1.status, "verified");
  assert.equal(String(match1.winner_id), "9201");

  const odin = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(String(odin.holder_id), "9201");

  const stats = await row(`SELECT * FROM stats WHERE user_id = '9201'`);
  assert.equal(Number(stats.wins), 3);
  assert.equal(Number(stats.total_matches), 3);

  const { getMatchDetails, listMatches } = require("../src/systems/match");
  const details = await getMatchDetails(state.match1);
  assert.ok(details);
  assert.equal(details.evidence.length, 2);
  assert.equal(details.disputes.length, 1);
  assert.equal(details.disputes[0].status, "resolved");

  const list = await listMatches({ limit: 10 });
  assert.ok(list.length >= 8, `expected >= 8 matches, got ${list.length}`);
  assert.ok(list.some((m) => Number(m.match_id) === state.match1));

  const evidenceCount = await row(`SELECT COUNT(*)::int AS n FROM match_evidence`);
  assert.ok(Number(evidenceCount.n) >= 7, "evidence rows persisted");
});

// ------------------------------------------------------- permission keys

test("stage 4 staff commands declare the right permission keys", async (t) => {
  if (!guard(t)) return;
  const { loadCommands } = require("../src/commands");
  const { PERMISSIONS } = require("../src/config/permissions");
  const { hasPermission } = require("../src/systems/permissions");

  const commands = loadCommands();
  assert.equal(commands.get("match-start").permission, PERMISSIONS.MATCH_REGISTER);
  assert.equal(commands.get("match-result").permission, PERMISSIONS.MATCH_VERIFY);
  assert.equal(commands.get("match-status").permission, PERMISSIONS.MATCH_REVIEW);
  assert.equal(commands.get("match-review").permission, PERMISSIONS.MATCH_REVIEW);
  assert.equal(
    commands.get("resolve-dispute").permission,
    PERMISSIONS.MATCH_DISPUTE_RESOLVE
  );
  assert.ok(!commands.get("challenge").permission, "member commands stay open");
  for (const name of ["match-start", "match-result", "match-status", "match-review", "resolve-dispute"]) {
    const json = commands.get(name).data.toJSON();
    assert.ok(json.description.length > 0 && json.description.length <= 100);
    assert.ok(
      json.default_member_permissions === undefined ||
        json.default_member_permissions === null,
      `/${name} must not hardcode Discord-side permissions`
    );
  }

  // DB-configured role grants: role 777 holds match.verify only.
  await handle.pool.query(
    `INSERT INTO staff_permissions (permission_key, role_id) VALUES ($1, '777')
     ON CONFLICT DO NOTHING`,
    [PERMISSIONS.MATCH_VERIFY]
  );
  const mod = {
    permissions: { has: () => false },
    roles: { cache: new Set(["777"]) },
  };
  assert.equal(await hasPermission(mod, PERMISSIONS.MATCH_VERIFY), true);
  assert.equal(await hasPermission(mod, PERMISSIONS.MATCH_REGISTER), false);

  const nobody = {
    permissions: { has: () => false },
    roles: { cache: new Set() },
  };
  assert.equal(await hasPermission(nobody, PERMISSIONS.MATCH_VERIFY), false);
});
