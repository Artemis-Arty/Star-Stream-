"use strict";

/**
 * Stage 5 tests: Role Collections and throne management.
 *
 * Covers: vacancy -> collection opening with Join button, join eligibility
 * (unranked only, first-two cap, duplicates, expiry), the deadline sweep
 * (0 entrants / solo grant / void guard / two-entrant skip), recording the
 * staff-supervised duel through /match-result (stats + throne_accepts),
 * /collection-manage award & close (incl. pending-duel cancellation),
 * /throne-grant /throne-strip /throne-vacate, the Arena Day re-opener
 * (COLLECTION_OPEN_HOUR), staff permission keys, and persistence across a
 * simulated restart.
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

// Known instants (UTC): Wed = Arena Day; Fri = not; Sat = Arena Day.
const WEDNESDAY = new Date("2026-11-11T12:00:00Z");
const FRIDAY_0030 = new Date("2026-11-13T00:30:00Z");
const SAT_0030 = new Date("2026-11-14T00:30:00Z");
const SAT_0035 = new Date("2026-11-14T00:35:00Z");
const SAT_0300 = new Date("2026-11-14T03:00:00Z");
const PROOF = "https://cdn.example/collection.png";

const state = {};

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
  handle = await startTestDatabase("stage5");
  if (!handle.pool) {
    skipReason = handle.unavailableReason;
    return;
  }

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
    collection: { openHour: 0 },
  };

  // Members: 9101-9108 = throne holders, 9201-9209 = unranked, 9900 = staff.
  const people = [
    [9101, "zeus-holder"],
    [9102, "hades-holder"],
    [9103, "wukong-holder"],
    [9104, "odin-holder"],
    [9105, "surya-holder"],
    [9106, "uriel-holder"],
    [9107, "abyssal-holder"],
    [9108, "custom-holder"],
    [9201, "challenger-a"],
    [9202, "challenger-b"],
    [9203, "challenger-c"],
    [9204, "challenger-d"],
    [9205, "challenger-e"],
    [9206, "challenger-f"],
    [9207, "challenger-g"],
    [9208, "challenger-h"],
    [9209, "challenger-i"],
    [9900, "staff-mod"],
  ];
  for (const [id, name] of people) {
    await handle.pool.query(
      `INSERT INTO members (user_id, username) VALUES ($1, $2)`,
      [id, name]
    );
    await handle.pool.query(`INSERT INTO stats (user_id) VALUES ($1)`, [id]);
  }

  // Every seat is occupied to start with, so the Arena Day opener only
  // opens collections for seats this suite deliberately vacates.
  await handle.pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ('zeus', '9101', now() - interval '1 day'),
            ('hades', '9102', now() - interval '1 day'),
            ('odin', '9104', now() - interval '1 day'),
            ('sun-wukong', '9103', now() - interval '1 day'),
            ('surya', '9105', now() - interval '1 day'),
            ('uriel', '9106', now() - interval '1 day'),
            ('abyssal-black-flame-dragon', '9107', now() - interval '1 day')`
  );

  // A custom seat (also occupied) for the close-with-duel scenario.
  await handle.pool.query(
    `INSERT INTO seats
       (seat_id, display_name, modifier_role_name, emoji, source, sort_order, is_active, role_id)
     VALUES ('custom-x', 'Custom Throne X', 'Custom X', '🔮', 'custom', 99, TRUE, '999008')`
  );
  await handle.pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ('custom-x', '9108', now() - interval '1 day')`
  );

  const roleIds = {
    zeus: "999001",
    hades: "999002",
    odin: "999003",
    "sun-wukong": "999004",
    surya: "999005",
    "abyssal-black-flame-dragon": "999006",
    uriel: "999007",
    "custom-x": "999008",
  };
  for (const [seatId, roleId] of Object.entries(roleIds)) {
    await handle.pool.query(`UPDATE seats SET role_id = $2 WHERE seat_id = $1`, [
      seatId,
      roleId,
    ]);
  }

  available = true;
});

test.after(async () => {
  if (available) {
    const { closePool } = require("../src/db/pool");
    await closePool().catch(() => {});
  }
  await stopTestDatabase(handle);
  try {
    fs.rmSync(path.join(TMP_ROOT, `starstream-stage5-${process.pid}`), {
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

function sentDescriptions() {
  return guild.sent.flatMap((m) =>
    (m.payload?.embeds || []).map((e) => e.data?.description || "")
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

async function vacate(seatId, reason, at = WEDNESDAY) {
  const { vacateThrone } = require("../src/systems/collection");
  return vacateThrone({
    seatId,
    reason,
    actorId: "9900",
    guild,
    config,
    at,
  });
}

async function join(collectionId, userId, at = WEDNESDAY) {
  const { joinCollection } = require("../src/systems/collection");
  return joinCollection({ collectionId, userId, guild, config, at });
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

// ---------------------------------------------------- vacancy -> collection

test("vacating a throne opens a Role Collection with a Join button", async (t) => {
  if (!guard(t)) return;
  const { vacateThrone, openCollectionForSeat, errorMessage } = require("../src/systems/collection");

  const before = guild.sent.length;
  const r = await vacateThrone({
    seatId: "odin",
    reason: "inactive holder",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.ok, true, r.code);

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NOT NULL`
  );
  assert.equal(reign.end_reason, "staff_vacate");
  const holder = await row(`SELECT * FROM members WHERE user_id = '9104'`);
  assert.ok(holder.throne_lost_at, "vacate arms the waiting gate");

  assert.ok(hasRemoved("9104", "999003"), "modifier role removed");

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'throne.vacate'`
  );
  assert.ok(audit, "vacate must be audited");
  assert.equal(audit.reason, "inactive holder");
  assert.equal(String(audit.actor_id), "9900");

  const collection = await row(
    `SELECT * FROM role_collections WHERE seat_id = 'odin' AND status = 'open'`
  );
  assert.ok(collection, "collection opened");
  assert.equal(collection.arena_day, "2026-11-11");
  assert.equal(
    new Date(collection.deadline_at).toISOString(),
    new Date(WEDNESDAY.getTime() + 4 * 3600_000).toISOString(),
    "4-hour window persisted"
  );
  assert.match(collection.notes, /inactive holder/);
  state.odinCollection = Number(collection.collection_id);

  // The announcement carries the Join button.
  assert.ok(guild.sent.length > before);
  const joinMessage = guild.sent.find((m) =>
    (m.payload?.components || []).some((row2) =>
      row2.components.some(
        (c) => c.data?.custom_id === `collection:join:${collection.collection_id}`
      )
    )
  );
  assert.ok(joinMessage, "Join button posted to #alerts");
  assert.equal(joinMessage.channel, "200");
  assert.ok(
    sentTitles().some((title) => title.includes("Role Collection open"))
  );

  // Idempotent + guards.
  const again = await openCollectionForSeat("odin", { guild, config, at: WEDNESDAY });
  assert.equal(again.ok, true);
  assert.equal(again.created, false, "no duplicate collection");

  const held = await openCollectionForSeat("zeus", { guild, config, at: WEDNESDAY });
  assert.equal(held.code, "SEAT_HELD");

  const missing = await openCollectionForSeat("nope", { guild, config, at: WEDNESDAY });
  assert.equal(missing.code, "SEAT_NOT_FOUND");
  assert.equal(errorMessage("SEAT_NOT_FOUND").length > 0, true);
});

// ---------------------------------------------------------------- joining

test("join rules: unranked only, first two entrants, no duplicates", async (t) => {
  if (!guard(t)) return;

  // A throne holder may not join.
  let r = await join(state.odinCollection, "9101");
  assert.equal(r.code, "RANKED");

  r = await join(state.odinCollection, "9201");
  assert.equal(r.ok, true, r.code);
  assert.equal(r.entrantCount, 1);

  const entry = await row(
    `SELECT * FROM role_collection_entries
      WHERE collection_id = $1 AND user_id = '9201'`,
    [state.odinCollection]
  );
  assert.ok(entry);

  r = await join(state.odinCollection, "9201");
  assert.equal(r.code, "ALREADY_JOINED");

  // Second entrant locks the collection and creates the staff duel.
  r = await join(state.odinCollection, "9202");
  assert.equal(r.ok, true, r.code);
  assert.equal(r.entrantCount, 2);
  assert.ok(r.matchId, "duel match created");
  state.match1 = r.matchId;

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [
    state.match1,
  ]);
  assert.equal(match.match_type, "role_collection");
  assert.equal(String(match.attacker_id), "9201", "first entrant = attacker");
  assert.equal(String(match.defender_id), "9202", "second entrant = defender");
  assert.equal(match.status, "scheduled");
  assert.equal(match.challenge_id, null);
  assert.equal(match.game_agreed_deadline_at, null, "no agreement window");

  const collection = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.odinCollection]
  );
  assert.equal(Number(collection.match_id), state.match1);

  assert.ok(
    sentTitles().some((title) => title.includes("Entrants locked")),
    "lock announced in #alerts"
  );

  // Third entrant rejected; unknown id rejected.
  r = await join(state.odinCollection, "9203");
  assert.equal(r.code, "FULL");

  r = await join(999999, "9203");
  assert.equal(r.code, "NOT_FOUND");

  // Before the deadline the locked collection refuses more entrants.
  r = await join(state.odinCollection, "9209", new Date(WEDNESDAY.getTime() + 35 * 60_000));
  assert.equal(r.code, "FULL");
});

// ------------------------------------------------- duel negative checks

test("duel recording needs a started match, proof and valid outcomes", async (t) => {
  if (!guard(t)) return;

  // Without proof nothing is written, even before the match is started.
  let r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    proof: [],
  });
  assert.equal(r.code, "PROOF_REQUIRED");

  // Not started yet.
  r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    proof: [PROOF],
  });
  assert.equal(r.code, "NOT_IN_PROGRESS");

  const { startMatch } = require("../src/systems/match");
  const started = await startMatch({
    matchId: state.match1,
    game: "Chess",
    actorId: "9900",
    guild,
    config,
    at: new Date(WEDNESDAY.getTime() + 30 * 60_000),
  });
  assert.equal(started.ok, true, started.code);

  // No-shows are a staff decision - never auto-recorded.
  r = await record({
    matchId: state.match1,
    outcome: "abandon_attacker",
    proof: [PROOF],
  });
  assert.equal(r.code, "COLLECTION_NO_SHOW");

  // No winner choices exist for a vacant seat.
  r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    winnerChoice: "kill",
    proof: [PROOF],
  });
  assert.equal(r.code, "INVALID_CHOICE");

  r = await record({
    matchId: state.match1,
    outcome: "defender_victory",
    winnerChoice: "subdue",
    proof: [PROOF],
  });
  assert.equal(r.code, "INVALID_CHOICE");

  const saved = await row(`SELECT * FROM matches WHERE match_id = $1`, [
    state.match1,
  ]);
  assert.equal(saved.status, "in_progress", "failed attempts change nothing");
  assert.equal(saved.winner_id, null);
});

// ------------------------------------------------------ sweep scenarios

test("set up the deadline sweep: empty, solo and void scenarios", async (t) => {
  if (!guard(t)) return;

  // 0 entrants.
  let r = await vacate("hades", "test: empty scenario");
  assert.equal(r.ok, true, r.code);
  state.hadesCollection = Number(
    (await row(`SELECT collection_id FROM role_collections WHERE seat_id = 'hades' AND status = 'open'`)).collection_id
  );

  // 1 entrant (will be granted the role by the sweep).
  r = await vacate("sun-wukong", "test: solo scenario");
  assert.equal(r.ok, true, r.code);
  state.wukongCollection = Number(
    (await row(`SELECT collection_id FROM role_collections WHERE seat_id = 'sun-wukong' AND status = 'open'`)).collection_id
  );
  r = await join(state.wukongCollection, "9204");
  assert.equal(r.ok, true, r.code);

  // 1 entrant who becomes ranked before the deadline -> void guard.
  r = await vacate("surya", "test: void scenario");
  assert.equal(r.ok, true, r.code);
  state.suryaCollection = Number(
    (await row(`SELECT collection_id FROM role_collections WHERE seat_id = 'surya' AND status = 'open'`)).collection_id
  );
  r = await join(state.suryaCollection, "9205");
  assert.equal(r.ok, true, r.code);
  // 9205 wins another throne in the meantime (simulated on a throwaway
  // seat so no real seat ever carries two open reigns).
  await handle.pool.query(
    `INSERT INTO seats (seat_id, display_name, modifier_role_name, source, sort_order, is_active)
     VALUES ('void-test', 'Void Test Throne', 'Void Test Throne', 'custom', 98, TRUE)`
  );
  await handle.pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at) VALUES ('void-test', '9205', now())`
  );

  // Joining after the window closed is refused.
  r = await join(state.wukongCollection, "9209", new Date(WEDNESDAY.getTime() + 4.25 * 3600_000));
  assert.equal(r.code, "EXPIRED");
  const wukongEntries = await rows(
    `SELECT * FROM role_collection_entries WHERE collection_id = $1`,
    [state.wukongCollection]
  );
  assert.equal(wukongEntries.length, 1, "expired join writes nothing");
});

test("deadline sweep: empty closes, solo grants, void guards, duel stays open", async (t) => {
  if (!guard(t)) return;
  const { processExpiredCollections } = require("../src/systems/collection");

  const at = new Date(WEDNESDAY.getTime() + 4.5 * 3600_000);
  const processed = await processExpiredCollections({ guild, config, at });
  assert.equal(processed.length, 3, `expected 3, got ${processed.length}`);

  // 0 entrants -> closed, reopens next Arena Day.
  const hades = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.hadesCollection]
  );
  assert.equal(hades.status, "closed");
  assert.equal(hades.resolution, "no_entrants");
  assert.ok(hades.closed_at);

  // 1 entrant -> solo grant.
  const wukong = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.wukongCollection]
  );
  assert.equal(wukong.status, "closed");
  assert.equal(wukong.resolution, "solo_entrant");
  assert.equal(String(wukong.winner_id), "9204");
  const newReign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'sun-wukong' AND ended_at IS NULL`
  );
  assert.equal(String(newReign.holder_id), "9204", "solo entrant installed");
  const winnerMember = await row(`SELECT * FROM members WHERE user_id = '9204'`);
  assert.equal(Number(winnerMember.throne_accepts), 1, "throne gain counts");
  assert.ok(hasAdded("9204", "999004"), "role granted");
  const winnerStats = await row(`SELECT * FROM stats WHERE user_id = '9204'`);
  assert.equal(Number(winnerStats.total_matches), 0, "no match was played");
  const achievement = await row(
    `SELECT * FROM achievements_unlocked
      WHERE user_id = '9204' AND achievement_key = 'throne_conqueror'`
  );
  assert.ok(achievement, "solo throne gain unlocks the achievement");

  // Entrant became ranked -> voided, seat stays vacant.
  const surya = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.suryaCollection]
  );
  assert.equal(surya.status, "closed");
  assert.equal(surya.winner_id, null, "voided grant writes no winner");
  assert.match(surya.notes, /voided/);
  const suryaReign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'surya' AND ended_at IS NULL`
  );
  assert.equal(suryaReign, null);

  // 2 entrants -> the duel collection is untouched (stays open; the duel
  // itself is recorded by the next test).
  const odin = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.odinCollection]
  );
  assert.equal(odin.status, "open", "sweep must not close a locked duel");

  // Announcements.
  assert.ok(sentTitles().some((title) => title.includes("nobody joined")));
  assert.ok(sentTitles().some((title) => title.includes("solo entrant")));
  assert.ok(
    sentDescriptions().some((d) => d.includes("reopens on the next Arena Day"))
  );

  // Idempotent.
  const second = await processExpiredCollections({ guild, config, at });
  assert.equal(second.length, 0);

  // No uriel cleanup needed: the void scenario now uses the throwaway
  // 'void-test' seat, which stays held by 9205 (an active held seat is
  // skipped by the Arena Day opener, so it never collects a window).
});

// ------------------------------------------------- duel result recording

test("recording the duel installs the winner and closes the collection", async (t) => {
  if (!guard(t)) return;

  const r = await record({
    matchId: state.match1,
    outcome: "attacker_victory",
    proof: [PROOF],
    notes: "chess 2-1",
  });
  assert.equal(r.ok, true, r.code);

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [
    state.match1,
  ]);
  assert.equal(match.status, "verified");
  assert.equal(String(match.winner_id), "9201");
  assert.equal(match.winner_choice, "none");
  assert.equal(String(match.verified_by), "9900");

  const evidence = await rows(
    `SELECT * FROM match_evidence WHERE match_id = $1`,
    [state.match1]
  );
  assert.equal(evidence.length, 1);

  const collection = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.odinCollection]
  );
  assert.equal(collection.status, "closed");
  assert.equal(collection.resolution, "two_entrants");
  assert.equal(String(collection.winner_id), "9201");
  assert.match(collection.notes, new RegExp(`duel recorded via match #${state.match1}`));

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'odin' AND ended_at IS NULL`
  );
  assert.equal(String(reign.holder_id), "9201");

  const winnerStats = await row(`SELECT * FROM stats WHERE user_id = '9201'`);
  assert.equal(Number(winnerStats.wins), 1, "duel stats count");
  assert.equal(Number(winnerStats.win_streak), 1);
  assert.equal(Number(winnerStats.total_matches), 1);
  const loserStats = await row(`SELECT * FROM stats WHERE user_id = '9202'`);
  assert.equal(Number(loserStats.losses), 1);
  assert.equal(Number(loserStats.win_streak), 0);

  const winnerMember = await row(`SELECT * FROM members WHERE user_id = '9201'`);
  assert.equal(Number(winnerMember.throne_accepts), 1, "collection win counts");

  assert.ok(hasAdded("9201", "999003"), "winner gains the role");

  assert.ok(
    sentTitles().some((title) => title.includes("Role Collection decided"))
  );
  assert.ok(sentTitles().some((title) => title.includes("New Constellation")));

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'match.record' AND target_id = $1`,
    [String(state.match1)]
  );
  assert.ok(audit, "duel result audited");

  // Closed collection rejects joins and new openings.
  const joinClosed = await join(state.odinCollection, "9209", new Date(WEDNESDAY.getTime() + 45 * 60_000));
  assert.equal(joinClosed.code, "NOT_OPEN");
  const { openCollectionForSeat } = require("../src/systems/collection");
  const reopen = await openCollectionForSeat("odin", { guild, config, at: WEDNESDAY });
  assert.equal(reopen.code, "SEAT_HELD");

  // Recording twice is impossible.
  const again = await record({
    matchId: state.match1,
    outcome: "defender_victory",
    proof: [PROOF],
  });
  assert.equal(again.code, "NOT_IN_PROGRESS");
});

// -------------------------------------------------- staff collection tools

test("/collection-manage award hands the seat to a member", async (t) => {
  if (!guard(t)) return;
  const {
    vacateThrone,
    joinCollection,
    awardCollection,
    getOpenCollectionForSeat,
  } = require("../src/systems/collection");

  const at = new Date(WEDNESDAY.getTime() + 6 * 3600_000);
  let r = await vacateThrone({
    seatId: "abyssal-black-flame-dragon",
    reason: "test: award scenario",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.ok, true, r.code);

  const collection = await getOpenCollectionForSeat("abyssal-black-flame-dragon");
  assert.ok(collection);
  state.abyssalCollection = Number(collection.collection_id);

  r = await joinCollection({
    collectionId: state.abyssalCollection,
    userId: "9206",
    guild,
    config,
    at,
  });
  assert.equal(r.ok, true, r.code);

  const base = {
    collectionId: state.abyssalCollection,
    actorId: "9900",
    guild,
    config,
    at,
  };

  // Reason is mandatory.
  r = await awardCollection({ ...base, userId: "9206", reason: "   " });
  assert.equal(r.code, "REASON_REQUIRED");

  // A throne holder cannot receive a collection.
  r = await awardCollection({ ...base, userId: "9101", reason: "cannot" });
  assert.equal(r.code, "ENTRANT_REQUIRED");

  r = await awardCollection({ ...base, userId: "9206", reason: "only entrant shown up" });
  assert.equal(r.ok, true, r.code);

  const closed = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [state.abyssalCollection]
  );
  assert.equal(closed.status, "closed");
  assert.equal(String(closed.winner_id), "9206");
  assert.equal(closed.resolution, "solo_entrant");
  assert.match(closed.notes, /awarded by staff \(9900\): only entrant shown up/);

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'abyssal-black-flame-dragon' AND ended_at IS NULL`
  );
  assert.equal(String(reign.holder_id), "9206");
  const member = await row(`SELECT * FROM members WHERE user_id = '9206'`);
  assert.equal(Number(member.throne_accepts), 1, "award counts as a throne gain");
  assert.ok(hasAdded("9206", "999006"));

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'collection.award'`
  );
  assert.ok(audit);
  assert.equal(audit.reason, "only entrant shown up");

  assert.ok(
    sentTitles().some((title) => title.includes("Role Collection awarded"))
  );

  // Awarding a closed collection fails.
  r = await awardCollection({ ...base, userId: "9207", reason: "again" });
  assert.equal(r.code, "NOT_OPEN");
  assert.equal(await getOpenCollectionForSeat("abyssal-black-flame-dragon"), null);
});

test("/collection-manage close cancels a pending duel", async (t) => {
  if (!guard(t)) return;
  const {
    vacateThrone,
    joinCollection,
    closeCollection,
    getCollectionDetails,
  } = require("../src/systems/collection");

  const at = new Date(WEDNESDAY.getTime() + 6.5 * 3600_000);
  let r = await vacateThrone({
    seatId: "custom-x",
    reason: "test: close scenario",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.ok, true, r.code);

  const open = await rows(
    `SELECT collection_id FROM role_collections WHERE seat_id = 'custom-x' AND status = 'open'`
  );
  const collectionId = Number(open[0].collection_id);
  state.customCollection = collectionId;

  r = await joinCollection({ collectionId, userId: "9203", guild, config, at });
  assert.equal(r.ok, true, r.code);
  r = await joinCollection({ collectionId, userId: "9208", guild, config, at });
  assert.equal(r.ok, true, r.code);
  assert.ok(r.matchId, "second entrant created the duel");
  state.match2 = r.matchId;

  const base = { collectionId, actorId: "9900", guild, config, at };

  r = await closeCollection({ ...base, reason: "  " });
  assert.equal(r.code, "REASON_REQUIRED");

  r = await closeCollection({ ...base, reason: "both no-showed, nobody gets it" });
  assert.equal(r.ok, true, r.code);

  const closed = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [collectionId]
  );
  assert.equal(closed.status, "closed");
  assert.equal(closed.winner_id, null);
  assert.equal(closed.resolution, null, "manual close has no resolution");
  assert.match(closed.notes, /closed by staff \(9900\): both no-showed/);

  const match = await row(`SELECT * FROM matches WHERE match_id = $1`, [
    state.match2,
  ]);
  assert.equal(match.status, "cancelled", "pending duel cancelled");
  assert.match(match.notes, /collection closed by staff/);

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'collection.close'`
  );
  assert.ok(audit);
  assert.equal(audit.reason, "both no-showed, nobody gets it");

  assert.ok(sentTitles().some((title) => title.includes("Role Collection closed")));

  r = await closeCollection({ ...base, reason: "again" });
  assert.equal(r.code, "NOT_OPEN");

  const details = await getCollectionDetails(collectionId);
  assert.ok(details);
  assert.deepEqual(details.entrantIds, ["9203", "9208"]);
  assert.equal(details.match.status, "cancelled");
});

// ------------------------------------------------------- throne tools

test("/throne-grant seats a holder on a vacant throne", async (t) => {
  if (!guard(t)) return;
  const { grantThrone, vacateThrone } = require("../src/systems/collection");

  // Held seat refused.
  let r = await grantThrone({
    seatId: "zeus",
    userId: "9207",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "SEAT_HELD");

  // Unknown seat refused.
  r = await grantThrone({
    seatId: "nope",
    userId: "9207",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "SEAT_NOT_FOUND");

  // Vacate uriel first (opens a collection), then grant over it.
  const at = new Date(WEDNESDAY.getTime() + 7 * 3600_000);
  r = await vacateThrone({
    seatId: "uriel",
    reason: "test: grant scenario",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.ok, true, r.code);
  assert.ok(hasRemoved("9106", "999007"));
  const uriCollection = await row(
    `SELECT * FROM role_collections WHERE seat_id = 'uriel' AND status = 'open'`
  );
  assert.ok(uriCollection, "vacate opened a collection");

  r = await grantThrone({
    seatId: "uriel",
    userId: "9207",
    actorId: "9900",
    guild,
    config,
    at: new Date(at.getTime() + 5 * 60_000),
  });
  assert.equal(r.ok, true, r.code);
  assert.equal(Number(r.closedCollectionId), Number(uriCollection.collection_id));
  assert.ok(hasAdded("9207", "999007"), "role granted");

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'uriel' AND ended_at IS NULL`
  );
  assert.equal(String(reign.holder_id), "9207");

  // Staff grant does NOT count as accepting a throne (documented decision).
  const member = await row(`SELECT * FROM members WHERE user_id = '9207'`);
  assert.equal(Number(member.throne_accepts), 0);

  const closed = await row(
    `SELECT * FROM role_collections WHERE collection_id = $1`,
    [Number(uriCollection.collection_id)]
  );
  assert.equal(closed.status, "closed");
  assert.match(closed.notes, /seat filled by staff \/throne-grant/);

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'throne.grant'`
  );
  assert.ok(audit);
  assert.equal(String(audit.target_id), "uriel");
  assert.ok(sentTitles().some((title) => title.includes("Throne granted")));

  // Granting an occupied seat again fails.
  r = await grantThrone({
    seatId: "uriel",
    userId: "9208",
    actorId: "9900",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "SEAT_HELD");
});

test("/throne-strip removes a specific holder and opens a collection", async (t) => {
  if (!guard(t)) return;
  const { stripThrone } = require("../src/systems/collection");

  const at = new Date(WEDNESDAY.getTime() + 7.5 * 3600_000);

  // Wrong member.
  let r = await stripThrone({
    seatId: "zeus",
    userId: "9201",
    reason: "wrong",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.code, "NOT_HOLDER");

  // Missing reason.
  r = await stripThrone({
    seatId: "zeus",
    userId: "9101",
    reason: "  ",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.code, "REASON_REQUIRED");

  // Vacant seat.
  r = await stripThrone({
    seatId: "hades",
    userId: "9102",
    reason: "nobody home",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.code, "SEAT_VACANT");

  // Real strip.
  const before = guild.sent.length;
  r = await stripThrone({
    seatId: "zeus",
    userId: "9101",
    reason: "rule violation",
    actorId: "9900",
    guild,
    config,
    at,
  });
  assert.equal(r.ok, true, r.code);

  const reign = await row(
    `SELECT * FROM reigns WHERE seat_id = 'zeus' AND ended_at IS NOT NULL`
  );
  assert.equal(reign.end_reason, "staff_strip");
  const holder = await row(`SELECT * FROM members WHERE user_id = '9101'`);
  assert.ok(holder.throne_lost_at, "strip arms the waiting gate");
  assert.ok(hasRemoved("9101", "999001"));

  const collection = await row(
    `SELECT * FROM role_collections WHERE seat_id = 'zeus' AND status = 'open'`
  );
  assert.ok(collection, "strip opens a collection");
  assert.match(collection.notes, /staff strip: rule violation/);
  state.zeusCollection = Number(collection.collection_id);

  assert.ok(guild.sent.length > before);
  assert.ok(
    sentDescriptions().some((d) => d.includes("staff strip: rule violation"))
  );

  const audit = await row(
    `SELECT * FROM staff_actions WHERE action = 'throne.strip'`
  );
  assert.ok(audit);
  assert.equal(audit.reason, "rule violation");
});

// --------------------------------------------------------- Arena Day opener

test("Arena Day opener re-opens vacant seats at COLLECTION_OPEN_HOUR", async (t) => {
  if (!guard(t)) return;
  const { openArenaDayCollections } = require("../src/systems/collection");

  // Not an Arena Day.
  let opened = await openArenaDayCollections({ guild, config, at: FRIDAY_0030 });
  assert.equal(opened.length, 0);

  // Arena Day but before the configured open hour.
  config.collection.openHour = 6;
  opened = await openArenaDayCollections({ guild, config, at: SAT_0300 });
  assert.equal(opened.length, 0, "no opening before the configured hour");

  // Arena Day at/after the open hour: every vacant seat without a
  // collection today opens one (hades, surya, custom-x).
  config.collection.openHour = 0;
  const beforeTitles = sentTitles().filter((t2) => t2.includes("Role Collection open")).length;
  opened = await openArenaDayCollections({ guild, config, at: SAT_0030 });
  const openedIds = opened.map((c) => c.seat_id).sort();
  assert.deepEqual(openedIds, ["custom-x", "hades", "surya"]);
  for (const collection of opened) {
    assert.equal(collection.status, "open");
    assert.equal(collection.arena_day, "2026-11-14");
    assert.equal(
      new Date(collection.deadline_at).toISOString(),
      new Date(SAT_0030.getTime() + 4 * 3600_000).toISOString()
    );
    assert.equal(collection.notes, "arena_day_reopen");
  }
  const afterTitles = sentTitles().filter((t2) => t2.includes("Role Collection open")).length;
  assert.equal(afterTitles, beforeTitles + 3, "one announcement per opened collection");

  // Held seats and today's opened collections are skipped.
  const heldOpen = await rows(
    `SELECT * FROM role_collections
      WHERE seat_id IN ('zeus', 'odin', 'sun-wukong', 'abyssal-black-flame-dragon', 'uriel')
        AND status = 'open'`
  );
  assert.equal(heldOpen.length, 1, "only zeus (stripped) has an open collection");

  // Idempotent within the same Arena Day.
  opened = await openArenaDayCollections({ guild, config, at: SAT_0035 });
  assert.equal(opened.length, 0, "one window per seat per Arena Day");
});

// ------------------------------------------------------------ persistence

test("everything survives a simulated restart (migrations re-run + re-read)", async (t) => {
  if (!guard(t)) return;
  const { runMigrations } = require("../src/db/migrate");
  await runMigrations(handle.pool);

  const holders = await rows(
    `SELECT seat_id, holder_id FROM reigns WHERE ended_at IS NULL ORDER BY seat_id`
  );
  const bySeat = Object.fromEntries(
    holders.map((h) => [h.seat_id, String(h.holder_id)])
  );
  assert.equal(bySeat.odin, "9201");
  assert.equal(bySeat["sun-wukong"], "9204");
  assert.equal(bySeat["abyssal-black-flame-dragon"], "9206");
  assert.equal(bySeat.uriel, "9207");
  assert.equal(bySeat.zeus, undefined, "zeus stays vacant after the strip");

  const stats = await row(`SELECT * FROM stats WHERE user_id = '9201'`);
  assert.equal(Number(stats.wins), 1);
  assert.equal(Number(stats.total_matches), 1);
  const soloStats = await row(`SELECT * FROM stats WHERE user_id = '9204'`);
  assert.equal(Number(soloStats.total_matches), 0);

  const accepts = await rows(
    `SELECT user_id, throne_accepts FROM members
      WHERE user_id IN ('9201', '9204', '9206', '9207') ORDER BY user_id`
  );
  const acceptMap = Object.fromEntries(
    accepts.map((a) => [String(a.user_id), Number(a.throne_accepts)])
  );
  assert.deepEqual(acceptMap, { "9201": 1, "9204": 1, "9206": 1, "9207": 0 });

  // Every staff action of this stage is in the audit log.
  const actions = await rows(
    `SELECT action, COUNT(*)::int AS n FROM staff_actions GROUP BY action`
  );
  const actionMap = Object.fromEntries(actions.map((a) => [a.action, a.n]));
  assert.ok(actionMap["throne.vacate"] >= 5, `vacates: ${actionMap["throne.vacate"]}`);
  assert.equal(actionMap["throne.strip"], 1);
  assert.equal(actionMap["throne.grant"], 1);
  assert.equal(actionMap["collection.award"], 1);
  assert.equal(actionMap["collection.close"], 1);
  assert.equal(actionMap["match.record"], 1);
  assert.equal(actionMap["match.start"], 1);

  // Open collections: zeus (stripped) + the three Arena Day re-opens.
  const { getOpenCollections } = require("../src/db/queries/collections");
  const open = await getOpenCollections();
  assert.equal(open.length, 4, `expected 4 open, got ${open.length}`);
  const openSeats = open.map((c) => c.seat_id).sort();
  assert.deepEqual(openSeats, ["custom-x", "hades", "surya", "zeus"]);
  for (const c of open) {
    assert.ok(c.deadline_at, "deadline persisted");
  }

  // Closed duel collection keeps its full record.
  const { getCollectionDetails } = require("../src/systems/collection");
  const odinDetails = await getCollectionDetails(state.odinCollection);
  assert.equal(odinDetails.collection.resolution, "two_entrants");
  assert.equal(String(odinDetails.collection.winner_id), "9201");
  assert.deepEqual(odinDetails.entrantIds, ["9201", "9202"]);
  assert.equal(odinDetails.match.status, "verified");

  const { listMatches: lm } = require("../src/systems/match");
  const list = await lm({ limit: 10 });
  assert.ok(list.some((m) => Number(m.match_id) === state.match1));
  assert.ok(list.some((m) => Number(m.match_id) === state.match2));
});

// ------------------------------------------------------- permission keys

test("stage 5 staff commands declare the right permission keys", async (t) => {
  if (!guard(t)) return;
  const { loadCommands } = require("../src/commands");
  const { loadComponents, getComponent } = require("../src/components");
  const { PERMISSIONS, ALL_PERMISSION_KEYS } = require("../src/config/permissions");
  const { hasPermission } = require("../src/systems/permissions");

  const commands = loadCommands();
  assert.equal(commands.get("throne-grant").permission, PERMISSIONS.THRONE_GRANT);
  assert.equal(commands.get("throne-strip").permission, PERMISSIONS.THRONE_STRIP);
  assert.equal(commands.get("throne-vacate").permission, PERMISSIONS.THRONE_VACATE);
  assert.equal(
    commands.get("collection-manage").permission,
    PERMISSIONS.COLLECTION_MANAGE
  );
  assert.ok(!commands.get("collection").permission, "member command stays open");

  for (const name of ["throne-grant", "throne-strip", "throne-vacate", "collection-manage"]) {
    const json = commands.get(name).data.toJSON();
    assert.ok(json.description.length > 0 && json.description.length <= 100);
    assert.ok(
      json.default_member_permissions === undefined ||
        json.default_member_permissions === null,
      `/${name} must not hardcode Discord-side permissions`
    );
    assert.ok(
      ALL_PERMISSION_KEYS.includes(commands.get(name).permission),
      `/${name} key must be configurable`
    );
  }

  // The Join button routes through the component loader.
  const components = loadComponents();
  assert.ok(components.has("collection"), "collection component registered");
  const component = getComponent("collection:join:123");
  assert.equal(typeof component.execute, "function");

  // DB-configured role grants.
  await handle.pool.query(
    `INSERT INTO staff_permissions (permission_key, role_id) VALUES ($1, '777')
     ON CONFLICT DO NOTHING`,
    [PERMISSIONS.COLLECTION_MANAGE]
  );
  const mod = {
    permissions: { has: () => false },
    roles: { cache: new Set(["777"]) },
  };
  assert.equal(await hasPermission(mod, PERMISSIONS.COLLECTION_MANAGE), true);
  assert.equal(await hasPermission(mod, PERMISSIONS.THRONE_GRANT), false);

  const nobody = {
    permissions: { has: () => false },
    roles: { cache: new Set() },
  };
  assert.equal(await hasPermission(nobody, PERMISSIONS.COLLECTION_MANAGE), false);
});
