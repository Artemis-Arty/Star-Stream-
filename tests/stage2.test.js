"use strict";

/**
 * Stage 2 tests: query layer, bounty math, achievement engine, title
 * equip flow, DB-backed permission checks and mocked command execution.
 *
 * Runs against an embedded PostgreSQL server. Skips with a reason if the
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

test.before(async () => {
  handle = await startTestDatabase("stage2");
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
  available = true;
});

test.after(async () => {
  if (available) {
    const { closePool } = require("../src/db/pool");
    await closePool().catch(() => {});
  }
  await stopTestDatabase(handle);
  try {
    fs.rmSync(path.join(TMP_ROOT, `starstream-stage2-${process.pid}`), {
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

// ---------------------------------------------------------------- bounty

test("bounty math follows the 14-day ladder", () => {
  const { computeBounty, nextBountyIncrease } = require("../src/systems/bounty");
  const start = new Date("2026-01-01T00:00:00Z");

  assert.equal(computeBounty(start, { at: new Date("2026-01-13T23:59:00Z") }), 0);
  assert.equal(computeBounty(start, { at: new Date("2026-01-15T00:00:00Z") }), 10000);
  assert.equal(computeBounty(start, { at: new Date("2026-01-29T00:00:00Z") }), 20000);
  assert.equal(computeBounty(start, { at: new Date("2026-02-12T00:00:00Z") }), 30000);
  assert.equal(computeBounty(start, { at: new Date("2026-02-26T00:00:00Z") }), 40000);

  // Reign ended: bounty frozen at the end moment.
  assert.equal(
    computeBounty(start, { endedAt: new Date("2026-01-20T00:00:00Z"), at: new Date("2026-03-01T00:00:00Z") }),
    10000
  );

  const next = nextBountyIncrease(start, { at: new Date("2026-01-05T00:00:00Z") });
  assert.equal(next.amount, 10000);
  assert.equal(next.daysTotal, 14);
  // 2026-01-01 + 14 days = 2026-01-15; from 2026-01-05 that is 10 days away.
  assert.equal(next.remainingMs, 10 * 86400000);
});

// --------------------------------------------------------------- members

test("ensureMember is idempotent and creates stats", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");

  await membersQ.ensureMember("1001", "alice");
  await membersQ.ensureMember("1001", "alice-renamed");

  const member = await membersQ.getMember("1001");
  assert.equal(member.username, "alice-renamed");
  const stats = await membersQ.getStats("1001");
  assert.equal(stats.kills, 0);

  const count = await handle.pool.query(
    `SELECT COUNT(*)::int AS n FROM members WHERE user_id = '1001'`
  );
  assert.equal(count.rows[0].n, 1);
});

// ----------------------------------------------------------- leaderboard

test("leaderboards order correctly and rank ties break by user id", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  const boardQ = require("../src/db/queries/leaderboard");

  const seeds = [
    ["1001", 1, 0],
    ["1002", 5, 2],
    ["1003", 3, 9],
    ["1004", 5, 1],
    ["1005", 0, 0],
  ];
  for (const [id, kills, subdued] of seeds) {
    await membersQ.ensureMember(id, `user${id}`);
    await handle.pool.query(
      `UPDATE stats SET kills = $2, subdued = $3 WHERE user_id = $1`,
      [id, kills, subdued]
    );
  }

  const topKills = await boardQ.getTop("kills");
  assert.deepEqual(
    topKills.map((r) => [String(r.user_id), r.score]),
    [
      ["1002", 5],
      ["1004", 5],
      ["1003", 3],
      ["1001", 1],
    ]
  );

  const topSubdued = await boardQ.getTop("subdued");
  assert.equal(String(topSubdued[0].user_id), "1003");
  assert.equal(topSubdued[0].score, 9);

  assert.deepEqual(await boardQ.getRank("1002", "kills"), { rank: 1, score: 5 });
  assert.deepEqual(await boardQ.getRank("1004", "kills"), { rank: 2, score: 5 });
  assert.deepEqual(await boardQ.getRank("1003", "kills"), { rank: 3, score: 3 });
  assert.equal(await boardQ.getRank("1005", "kills"), null);
});

// -------------------------------------------------------------- thrones

test("seat list shows holders, bounties and reign timers", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  const thronesQ = require("../src/db/queries/thrones");

  await membersQ.ensureMember("2001", "holder");
  // Reign started 15 days ago -> one bounty step accrued.
  await handle.pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ('zeus', '2001', now() - interval '15 days')`
  );

  const seats = await thronesQ.getSeatsWithHolders();
  assert.equal(seats.length, 7);
  const zeus = seats.find((s) => s.seat_id === "zeus");
  assert.equal(zeus.holderId, "2001");
  assert.equal(zeus.bounty, 10000);
  assert.ok(zeus.reignMs > 14 * 86400000);
  assert.equal(zeus.nextIncrease.amount, 20000);
  assert.ok(seats.find((s) => s.seat_id === "hades").holderId === null);

  const { occupied, total } = await thronesQ.getBountyBoard();
  assert.equal(occupied.length, 1);
  assert.equal(total, 10000);
});

// -------------------------------------------------------- match history

test("history, throne victories and opponents resolve correctly", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  const matchesQ = require("../src/db/queries/matches");

  for (const id of ["2001", "1001", "3003", "4004"]) {
    await membersQ.ensureMember(id, `user${id}`);
  }

  // 1001 beats the zeus holder (2001) while the reign is open -> victory.
  await handle.pool.query(
    `INSERT INTO matches (match_type, seat_id, attacker_id, defender_id, created_by,
                          status, winner_id, outcome, winner_choice, verified_at, created_at)
     VALUES ('challenge', 'zeus', '1001', '2001', '2001', 'verified', '1001',
             'attacker_victory', 'kill', now() - interval '2 days', now() - interval '2 days')`
  );

  // 1001 beats a NON-holder (3003) -> not a throne victory.
  await handle.pool.query(
    `INSERT INTO matches (match_type, seat_id, attacker_id, defender_id, created_by,
                          status, winner_id, outcome, winner_choice, verified_at, created_at)
     VALUES ('staff', 'hades', '1001', '3003', '1001', 'verified', '1001',
             'attacker_victory', 'none', now() - interval '1 day', now() - interval '1 day')`
  );

  // 4004 beats 1001 after 1001 takes the hades throne -> victory for 4004.
  await membersQ.ensureMember("1001", "user1001");
  await handle.pool.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ('hades', '1001', now() - interval '3 hours')`
  );
  await handle.pool.query(
    `INSERT INTO matches (match_type, seat_id, attacker_id, defender_id, created_by,
                          status, winner_id, outcome, winner_choice, verified_at, created_at)
     VALUES ('challenge', 'hades', '4004', '1001', '4004', 'verified', '4004',
             'attacker_victory', 'swap', now() - interval '1 hour', now() - interval '1 hour')`
  );

  assert.equal(await matchesQ.countThroneVictories("1001"), 1);
  assert.equal(await matchesQ.countThroneVictories("4004"), 1);
  assert.equal(await matchesQ.countThroneVictories("3003"), 0);

  const history = await matchesQ.getMatchHistory("1001", { limit: 10, offset: 0 });
  assert.equal(history.total, 3);
  // Newest first: the 4004 loss is most recent; opponent of match 3 is 4004.
  assert.equal(String(history.rows[0].opponent_id), "4004");
  assert.equal(history.rows[0].winner_id, "4004");
});

// ----------------------------------------------------------- achievements

test("achievement engine unlocks idempotently from lifetime stats", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  const { evaluateAchievements, getUnlockedKeys } = require("../src/systems/achievements");

  await membersQ.ensureMember("1002", "user1002");

  // First Blood (1 kill) and Throne Breaker (5 kills) both qualify.
  await handle.pool.query(`UPDATE stats SET kills = 5 WHERE user_id = '1002'`);
  let unlocked = await evaluateAchievements("1002");
  assert.deepEqual(
    unlocked.map((a) => a.key),
    ["first_blood", "throne_breaker"]
  );

  // Idempotent: nothing new on a second run.
  unlocked = await evaluateAchievements("1002");
  assert.equal(unlocked.length, 0);

  // Unyielding: 3 Subdued. (1002 already has subdued=2 from leaderboard seed.)
  await handle.pool.query(`UPDATE stats SET subdued = 3 WHERE user_id = '1002'`);
  unlocked = await evaluateAchievements("1002");
  assert.deepEqual(
    unlocked.map((a) => a.key),
    ["unyielding"]
  );

  // Throne Conqueror: accepted a throne once.
  await handle.pool.query(`UPDATE members SET throne_accepts = 1 WHERE user_id = '1002'`);
  unlocked = await evaluateAchievements("1002");
  assert.deepEqual(
    unlocked.map((a) => a.key),
    ["throne_conqueror"]
  );

  // Absolute Sovereign: forged the King title.
  await handle.pool.query(`INSERT INTO king_records (user_id) VALUES ('1002')`);
  unlocked = await evaluateAchievements("1002");
  assert.deepEqual(
    unlocked.map((a) => a.key),
    ["absolute_sovereign"]
  );

  const keys = await getUnlockedKeys("1002");
  assert.ok(keys.has("first_blood"));
  assert.ok(keys.has("unyielding"));
});

test("star devourer unlocks after 5 throne victories", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  const { evaluateAchievements } = require("../src/systems/achievements");

  // Fresh member 5005 beats the zeus holder 5 times.
  await membersQ.ensureMember("5005", "devourer");
  for (let i = 0; i < 5; i += 1) {
    await handle.pool.query(
      `INSERT INTO matches (match_type, seat_id, attacker_id, defender_id, created_by,
                            status, winner_id, outcome, winner_choice, verified_at, created_at)
       VALUES ('challenge', 'zeus', '5005', '2001', '5005', 'verified', '5005',
               'attacker_victory', 'kill', now() - (interval '1 hour' * $1), now() - (interval '1 hour' * $1))`,
      [i + 1]
    );
  }

  const unlocked = await evaluateAchievements("5005");
  assert.deepEqual(
    unlocked.map((a) => a.key),
    ["star_devourer"]
  );
});

// ---------------------------------------------------------------- titles

test("titles unlock with achievements and enforce a single equip", async (t) => {
  if (!guard(t)) return;
  const titlesQ = require("../src/db/queries/titles");

  const titles = await titlesQ.getTitlesFor("1002");
  const firstBlood = titles.find((t2) => t2.key === "title_first_blood");
  assert.equal(firstBlood.unlocked, true);
  const locked = titles.find((t2) => t2.key === "title_doom_of_the_star_stream");
  assert.equal(locked.unlocked, false);

  // Locked titles cannot be equipped.
  await assert.rejects(
    () => titlesQ.equipTitle("1002", "title_doom_of_the_star_stream"),
    (err) => err.message === "TITLE_LOCKED"
  );

  await titlesQ.equipTitle("1002", "title_first_blood");
  let equipped = await titlesQ.getEquippedTitle("1002");
  assert.equal(equipped.key, "title_first_blood");

  // Equipping a second title moves the flag.
  await titlesQ.equipTitle("1002", "title_unyielding");
  equipped = await titlesQ.getEquippedTitle("1002");
  assert.equal(equipped.key, "title_unyielding");

  const equippedCount = await handle.pool.query(
    `SELECT COUNT(*)::int AS n FROM member_titles WHERE user_id = '1002' AND equipped`
  );
  assert.equal(equippedCount.rows[0].n, 1);

  const removed = await titlesQ.unequipTitle("1002");
  assert.equal(removed, true);
  assert.equal(await titlesQ.getEquippedTitle("1002"), null);
});

// ----------------------------------------------------------- collections

test("open Role Collections report entrant counts", async (t) => {
  if (!guard(t)) return;
  const collectionsQ = require("../src/db/queries/collections");

  const inserted = await handle.pool.query(
    `INSERT INTO role_collections (seat_id, arena_day, deadline_at)
     VALUES ('odin', CURRENT_DATE, now() + interval '4 hours')
     RETURNING collection_id`
  );
  const collectionId = inserted.rows[0].collection_id;
  await handle.pool.query(
    `INSERT INTO role_collection_entries (collection_id, user_id)
     VALUES ($1, '6001'), ($1, '6002')`,
    [collectionId]
  );

  const open = await collectionsQ.getOpenCollections();
  const odin = open.find((c) => c.seat_id === "odin");
  assert.ok(odin, "odin collection should be open");
  assert.equal(odin.entrants, 2);
  assert.deepEqual(odin.entrant_ids.map(String), ["6001", "6002"]);
});

// ----------------------------------------------------------- permissions

test("permission checks honour configured staff roles", async (t) => {
  if (!guard(t)) return;
  const { hasPermission, getAuthorizedKeys } = require("../src/systems/permissions");
  const { PERMISSIONS } = require("../src/config/permissions");

  await handle.pool.query(
    `INSERT INTO staff_permissions (permission_key, role_id) VALUES ($1, '555')`,
    [PERMISSIONS.MATCH_VERIFY]
  );

  const mod = {
    permissions: { has: () => false },
    roles: { cache: new Map([["555", {}]]) },
  };
  assert.equal(await hasPermission(mod, PERMISSIONS.MATCH_VERIFY), true);
  // Not configured for this key -> default deny.
  assert.equal(await hasPermission(mod, PERMISSIONS.STATS_CORRECT), false);

  const keys = await getAuthorizedKeys(mod);
  assert.ok(keys.has(PERMISSIONS.MATCH_VERIFY));
  assert.equal(keys.has(PERMISSIONS.STATS_CORRECT), false);

  const nobody = {
    permissions: { has: () => false },
    roles: { cache: new Map() },
  };
  assert.equal((await getAuthorizedKeys(nobody)).size, 0);
});

// --------------------------------------------------- command execution

function mockUser(id, username) {
  return {
    id,
    username,
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
  };
}

function mockInteraction({ userId = "7001", username = "tester", optionUser = null } = {}) {
  const replies = [];
  const client = {
    commands: require("../src/commands").loadCommands(),
    users: {
      cache: new Map([[userId, mockUser(userId, username)]]),
      fetch: async (id) => mockUser(id, `user${id}`),
    },
    config: {},
  };
  return {
    replies,
    client,
    user: mockUser(userId, username),
    options: { getUser: () => optionUser },
    member: { permissions: { has: () => true }, roles: { cache: new Map() } },
    guild: {
      members: {
        fetch: async (id) => ({
          id,
          user: mockUser(id, `user${id}`),
          permissions: { has: () => false },
          roles: { cache: new Map() },
        }),
      },
    },
    reply: async (payload) => {
      replies.push(payload);
      return {
        id: "reply1",
        createMessageComponentCollector: () => ({ on() {} }),
        edit: async () => {},
      };
    },
    followUp: async (payload) => {
      replies.push(payload);
    },
  };
}

function fieldNames(payload) {
  return (payload.embeds?.[0]?.data?.fields || []).map((f) => f.name);
}

test("/profile shows a Constellation card for a throne holder", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  await membersQ.ensureMember("7001", "tester");

  // Give 7001 a throne.
  const existing = await handle.pool.query(
    `SELECT 1 FROM reigns WHERE holder_id = '7001' AND ended_at IS NULL`
  );
  if (existing.rows.length === 0) {
    await handle.pool.query(
      `INSERT INTO reigns (seat_id, holder_id, started_at)
       VALUES ('surya', '7001', now() - interval '2 days')`
    );
  }

  const command = require("../src/commands/member/profile");
  const interaction = mockInteraction();
  await command.execute(interaction, { client: interaction.client, config: {} });

  assert.equal(interaction.replies.length, 1);
  const names = fieldNames(interaction.replies[0]);
  assert.ok(names.includes("⭐ Constellation"), `fields: ${names.join(", ")}`);
  assert.ok(names.includes("🛡️ Refusals"));
  assert.ok(names.includes("💰 Current bounty"));
  assert.ok(names.includes("⚔️ Kills"));
});

test("/profile hides throne information from unranked members", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  await membersQ.ensureMember("7002", "challenger");

  const command = require("../src/commands/member/profile");
  const interaction = mockInteraction({ userId: "7002", username: "challenger" });
  await command.execute(interaction, { client: interaction.client, config: {} });

  const names = fieldNames(interaction.replies[0]);
  assert.ok(names.includes("📊 Status"));
  assert.ok(names.includes("🌟 Constellations defeated"));
  assert.ok(names.includes("🧬 Custom Constellations"));
  // Spec section 4: no throne-specific information for unranked members.
  assert.ok(!names.includes("🛡️ Refusals"), "refusals must be hidden");
  assert.ok(!names.includes("💰 Current bounty"), "bounty must be hidden");
  assert.ok(!names.includes("⏳ Reign"), "reign must be hidden");
  assert.ok(!names.includes("⭐ Constellation"), "throne must be hidden");
});

test("/stats reports ranks and lifetime totals", async (t) => {
  if (!guard(t)) return;
  const membersQ = require("../src/db/queries/members");
  await membersQ.ensureMember("7003", "statsy");
  await handle.pool.query(
    `UPDATE stats SET kills = 4, total_matches = 6, wins = 4, losses = 2, win_streak = 3
      WHERE user_id = '7003'`
  );

  const command = require("../src/commands/member/stats");
  const interaction = mockInteraction({ userId: "7003", username: "statsy" });
  await command.execute(interaction, { client: interaction.client, config: {} });

  const names = fieldNames(interaction.replies[0]);
  assert.ok(names.includes("🎮 Total matches"));
  assert.ok(names.includes("📈 Wins / Losses"));
  assert.ok(names.includes("📍 Leaderboard ranks"));
  assert.ok(names.includes("👑 Total reigns"));

  const totalField = interaction.replies[0].embeds[0].data.fields.find(
    (f) => f.name === "🎮 Total matches"
  );
  assert.equal(totalField.value, "6");
});

test("/leaderboard renders both boards", async (t) => {
  if (!guard(t)) return;
  const command = require("../src/commands/member/leaderboard");
  const interaction = mockInteraction({ userId: "7004", username: "lurker" });
  await command.execute(interaction, { client: interaction.client, config: {} });

  const embed = interaction.replies[0].embeds[0];
  const names = embed.data.fields.map((f) => f.name);
  assert.ok(names.includes("⚔️ Kill Leaderboard"));
  assert.ok(names.includes("🌙 Subdued Leaderboard"));
  assert.ok(names.includes("📍 Your position"));
  // Seeded data: 1002/1004 lead with 5 kills.
  const kills = embed.data.fields.find((f) => f.name === "⚔️ Kill Leaderboard");
  assert.match(kills.value, /user1002|user1004/);
});

test("/titles renders unlocked and locked sections", async (t) => {
  if (!guard(t)) return;
  const command = require("../src/commands/member/titles");
  const interaction = mockInteraction({ userId: "1002", username: "user1002" });
  await command.execute(interaction, { client: interaction.client, config: {} });

  const payload = interaction.replies[0];
  const names = fieldNames(payload);
  assert.ok(names.includes("🎖️ Equipped"));
  assert.ok(names.some((n) => n.startsWith("✅ Unlocked")));
  assert.ok(names.some((n) => n.startsWith("🔒 Locked")));
  // Select menu + unequip button offered to the owner.
  assert.equal(payload.components.length, 2);
});

test("/help renders three categories", async (t) => {
  if (!guard(t)) return;
  const command = require("../src/commands/member/help");
  const interaction = mockInteraction({ userId: "7005", username: "helper" });
  await command.execute(interaction, { client: interaction.client, config: {} });

  const payload = interaction.replies[0];
  const title = payload.embeds[0].data.title;
  assert.match(title, /Member Commands/);

  // Navigate to the constellation info page via the collector? The first
  // page is enough here; verify structure only.
  assert.ok(payload.components.length === 1);
});
