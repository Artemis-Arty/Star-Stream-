"use strict";

/**
 * Stage 3 tests: the challenge system.
 *
 * Covers issuance rules (Arena Day, eligibility, one-per-seat, once-per-day),
 * Accept/Refuse button flows, refusal counting, the fourth-refusal role strip,
 * timeout sweeps (idempotent), staff cancellation with audit, and the
 * auto-cancel that refunds a challenger when a throne changes hands.
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

/** Shared state between the sequential tests. */
const state = {};

// Known instants: Wed 2026-11-11 (Arena Day), Fri 2026-11-13 (not),
// Sat 2026-11-14 (Arena Day).
const WEDNESDAY = new Date("2026-11-11T12:00:00Z");
const FRIDAY = new Date("2026-11-13T12:00:00Z");
const SATURDAY = new Date("2026-11-14T12:00:00Z");

function makeGuild() {
  const sent = [];
  const removedRoles = [];
  return {
    sent,
    removedRoles,
    channels: {
      fetch: async (channelId) => ({
        id: String(channelId),
        isTextBased: () => true,
        send: async (payload) => {
          const message = {
            // Snowflake-style numeric id: message_id columns are BIGINT.
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
        },
      }),
    },
  };
}

test.before(async () => {
  handle = await startTestDatabase("stage3");
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
    [8001, "zeus-holder"],
    [8002, "challenger-a"],
    [8003, "hades-holder"],
    [8004, "challenger-b"],
    [8005, "recent-loser"],
    [8006, "challenger-c"],
    [8007, "challenger-d"],
    [8100, "odin-holder"],
    [8101, "odin-challenger"],
    [8102, "surya-challenger"],
    [8103, "surya-holder"],
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
     VALUES ('zeus', '8001', now() - interval '1 day'),
            ('hades', '8003', now() - interval '1 day'),
            ('odin', '8100', now() - interval '1 day'),
            ('surya', '8103', now() - interval '1 day')`
  );

  // Discord roles configured so role-stripping is observable in tests.
  await handle.pool.query(`UPDATE seats SET role_id = '999001' WHERE seat_id = 'zeus'`);
  await handle.pool.query(`UPDATE seats SET role_id = '999003' WHERE seat_id = 'hades'`);

  // 8005 lost a throne on Wednesday morning.
  await handle.pool.query(
    `UPDATE members SET throne_lost_at = '2026-11-11T08:00:00Z' WHERE user_id = '8005'`
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
    fs.rmSync(path.join(TMP_ROOT, `starstream-stage3-${process.pid}`), {
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

async function challengeRow(challengeId) {
  const result = await handle.pool.query(
    `SELECT * FROM challenges WHERE challenge_id = $1`,
    [challengeId]
  );
  return result.rows[0] || null;
}

async function openReign(seatId) {
  const result = await handle.pool.query(
    `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL`,
    [seatId]
  );
  return result.rows[0] || null;
}

// ------------------------------------------------------------- issuance

test("issues a challenge on an Arena Day and posts Accept/Refuse buttons", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge } = require("../src/systems/challenge");
  const before = guild.sent.length;

  const result = await issueChallenge({
    challengerId: "8002",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.challenge.status, "pending");
  assert.equal(
    Number(result.challenge.refusal_count_at_creation),
    0,
    "counter snapshot comes from the current reign"
  );

  // Deadline is the 4-hour response window from `at`.
  assert.equal(
    new Date(result.challenge.response_deadline_at).toISOString(),
    "2026-11-11T16:00:00.000Z"
  );

  // Arena day stored as the calendar day of `at` in the configured timezone.
  const stored = await handle.pool.query(
    `SELECT to_char(arena_day, 'YYYY-MM-DD') AS day FROM challenges WHERE challenge_id = $1`,
    [result.challenge.challenge_id]
  );
  assert.equal(stored.rows[0].day, "2026-11-11");

  // Exactly one new public post, in the challenge channel, with both buttons.
  assert.equal(guild.sent.length, before + 1);
  const post = guild.sent[guild.sent.length - 1];
  assert.equal(post.channel, "300");
  // ButtonBuilder keeps its payload under `.data.custom_id`.
  const ids = post.payload.components[0].components.map((c) => c.data.custom_id);
  assert.deepEqual(ids, [
    `challenge:accept:${result.challenge.challenge_id}`,
    `challenge:refuse:${result.challenge.challenge_id}`,
  ]);

  // The message reference is persisted so staff can find the original post.
  const row = await challengeRow(result.challenge.challenge_id);
  assert.equal(String(row.message_id), post.id);
  assert.equal(String(row.channel_id), "300");

  state.firstChallengeId = Number(result.challenge.challenge_id);
});

test("rejects invalid challenge attempts with specific codes", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge } = require("../src/systems/challenge");

  // Not an Arena Day.
  let r = await issueChallenge({
    challengerId: "8004",
    seatId: "hades",
    guild,
    config,
    at: FRIDAY,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NOT_ARENA_DAY");

  // Self-challenge.
  r = await issueChallenge({
    challengerId: "8001",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "SELF");

  // Vacant seat -> Role Collection handles it, not a challenge.
  r = await issueChallenge({
    challengerId: "8004",
    seatId: "uriel",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "VACANT");

  // Unknown seat.
  r = await issueChallenge({
    challengerId: "8004",
    seatId: "not-a-seat",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "SEAT_NOT_FOUND");

  // Another challenger on the same busy seat.
  r = await issueChallenge({
    challengerId: "8004",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "SEAT_BUSY");

  // Same challenger + seat + Arena Day (the pending challenge from test 1).
  r = await issueChallenge({
    challengerId: "8002",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "ALREADY_TODAY");

  // Nothing invalid was written.
  const count = await handle.pool.query(
    `SELECT COUNT(*)::int AS n FROM challenges WHERE status = 'pending'`
  );
  assert.equal(count.rows[0].n, 1, "only the valid challenge is pending");
});

test("throne-loss gate blocks until the next Arena Day, then allows", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge, cancelChallenge } = require("../src/systems/challenge");

  // Lost the throne on Wednesday morning -> still Wednesday: blocked.
  let r = await issueChallenge({
    challengerId: "8005",
    seatId: "hades",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "WAIT_ARENA_DAY");

  // Saturday (the next Arena Day) -> allowed.
  r = await issueChallenge({
    challengerId: "8005",
    seatId: "hades",
    guild,
    config,
    at: SATURDAY,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const firstId = Number(r.challenge.challenge_id);

  // Staff cancellation frees the challenger's once-per-day chance.
  const cancelled = await cancelChallenge({
    challengeId: firstId,
    actorId: "9001",
    reason: "test cleanup",
  });
  assert.equal(cancelled.ok, true);

  r = await issueChallenge({
    challengerId: "8005",
    seatId: "hades",
    guild,
    config,
    at: SATURDAY,
  });
  assert.equal(r.ok, true, "cancelled challenge must not consume the daily chance");

  // Leave no active challenge behind for later tests.
  await cancelChallenge({
    challengeId: Number(r.challenge.challenge_id),
    actorId: "9001",
    reason: "test cleanup",
  });
  const active = await handle.pool.query(
    `SELECT COUNT(*)::int AS n FROM challenges WHERE status IN ('pending','accepted')`
  );
  assert.equal(active.rows[0].n, 1, "only the original zeus challenge remains active");
});

// ------------------------------------------------------------ responses

test("only the seat holder can refuse; a refusal increments the counter", async (t) => {
  if (!guard(t)) return;
  const { refuseChallenge } = require("../src/systems/challenge");

  // A non-holder cannot respond.
  let r = await refuseChallenge({
    challengeId: state.firstChallengeId,
    userId: "8004",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "HOLDER_ONLY");
  assert.equal((await challengeRow(state.firstChallengeId)).status, "pending");

  // The holder refuses.
  r = await refuseChallenge({
    challengeId: state.firstChallengeId,
    userId: "8001",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.stripped, false);
  assert.equal(r.newCount, 1);

  const row = await challengeRow(state.firstChallengeId);
  assert.equal(row.status, "refused");
  assert.equal(String(row.refuser_id), "8001");
  assert.ok(row.responded_at);
  assert.ok(row.resolved_at);

  const reign = await openReign("zeus");
  assert.equal(Number(reign.refusal_count), 1);

  // The refusal was announced in the challenge channel.
  const posted = guild.sent.filter(
    (m) => m.channel === "300" && /refused/i.test(m.payload.embeds[0].data.title || "")
  );
  assert.ok(posted.length >= 1, "refusal announcement missing");
});

test("accept creates the match, starts the 15-minute game window and locks the seat", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge, acceptChallenge } = require("../src/systems/challenge");

  const issued = await issueChallenge({
    challengerId: "8004",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const challengeId = Number(issued.challenge.challenge_id);
  state.acceptedChallengeId = challengeId;

  // A non-holder cannot accept.
  let r = await acceptChallenge({
    challengeId,
    userId: "8002",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "HOLDER_ONLY");

  // The holder accepts.
  r = await acceptChallenge({
    challengeId,
    userId: "8001",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.challenge.status, "accepted");
  assert.ok(r.match.match_id);
  assert.equal(String(r.challenge.match_id), String(r.match.match_id));
  assert.equal(r.match.status, "scheduled");
  assert.equal(r.match.match_type, "challenge");
  assert.equal(String(r.match.attacker_id), "8004");
  assert.equal(String(r.match.defender_id), "8001");

  // 15-minute game-agreement window starts at accept.
  assert.equal(
    new Date(r.match.game_agreed_deadline_at).toISOString(),
    "2026-11-11T12:15:00.000Z"
  );

  // The accepted challenge keeps the seat locked (decision: until the match
  // result is recorded).
  const busy = await issueChallenge({
    challengerId: "8006",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(busy.code, "SEAT_BUSY");

  // Game-agreement announcement includes the neutral default.
  const post = guild.sent[guild.sent.length - 1];
  assert.equal(post.channel, "300");
  const text = JSON.stringify(post.payload.embeds[0].data);
  assert.match(text, /15 minutes/i);
  assert.match(text, /3 rounds of OwO Battle/);
  assert.match(text, /\/match-start/);
});

test("staff /challenge-cancel cancels, audits and refunds the daily chance", async (t) => {
  if (!guard(t)) return;
  const { PERMISSIONS } = require("../src/config/permissions");
  const command = require("../src/commands/staff/challenge-cancel");

  await handle.pool.query(
    `INSERT INTO staff_permissions (permission_key, role_id)
     VALUES ($1, '777') ON CONFLICT DO NOTHING`,
    [PERMISSIONS.CHALLENGE_CANCEL]
  );

  function staffInteraction({ allowed, id = null, reason = null } = {}) {
    const replies = [];
    return {
      replies,
      user: { id: "9001", username: "mod" },
      member: {
        permissions: { has: () => false },
        roles: { cache: allowed ? new Map([["777", {}]]) : new Map() },
      },
      options: {
        getUser: () => ({ id: "8004", username: "challenger-b" }),
        getInteger: () => id,
        getString: () => reason,
      },
      reply: async (payload) => {
        replies.push(payload);
      },
      followUp: async (payload) => {
        replies.push(payload);
      },
    };
  }

  // Without the configured role: denied.
  const denied = staffInteraction({ allowed: false });
  await command.execute(denied);
  assert.match(denied.replies[0].embeds[0].data.description, /permission/i);

  // With the role: cancels the single active challenge of challenger 8004.
  const allowed = staffInteraction({ allowed: true, reason: "match resolved elsewhere" });
  await command.execute(allowed);
  assert.match(
    allowed.replies[0].embeds[0].data.description,
    /Challenge #\d+ .* was cancelled/i
  );

  const row = await challengeRow(state.acceptedChallengeId);
  assert.equal(row.status, "cancelled");
  assert.match(row.notes, /cancelled by staff: match resolved elsewhere/);

  // Audit entry with actor, previous/new value and reason.
  const audit = await handle.pool.query(
    `SELECT * FROM staff_actions
      WHERE action = 'challenge.cancel' AND target_id = $1`,
    [String(state.acceptedChallengeId)]
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(String(audit.rows[0].actor_id), "9001");
  assert.equal(audit.rows[0].previous_value.status, "accepted");
  assert.equal(audit.rows[0].new_value.status, "cancelled");
  assert.equal(audit.rows[0].reason, "match resolved elsewhere");

  // Refund: the same challenger may challenge the same seat on the same day.
  const { issueChallenge } = require("../src/systems/challenge");
  const again = await issueChallenge({
    challengerId: "8004",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(again.ok, true, JSON.stringify(again));
  state.reissuedChallengeId = Number(again.challenge.challenge_id);
});

// -------------------------------------------------------------- sweeps

test("an expired challenge increments refusals exactly once", async (t) => {
  if (!guard(t)) return;
  const { processExpiredChallenges } = require("../src/systems/challenge");

  // Only the re-issued challenge is pending (its deadline already passed,
  // because `at` was Wednesday and the real clock is later).
  await handle.pool.query(
    `UPDATE challenges SET status = 'cancelled'
      WHERE status = 'pending' AND challenge_id <> $1`,
    [state.reissuedChallengeId]
  );

  const beforePosts = guild.sent.length;
  const first = await processExpiredChallenges({ guild, config, at: new Date() });
  assert.equal(first.length, 1);
  assert.equal(Number(first[0].challenge.challenge_id), state.reissuedChallengeId);
  assert.equal(first[0].stripped, false);
  assert.equal(first[0].newCount, 2);

  const row = await challengeRow(state.reissuedChallengeId);
  assert.equal(row.status, "expired");
  assert.ok(row.resolved_at);

  const reign = await openReign("zeus");
  assert.equal(Number(reign.refusal_count), 2);

  // Expiry was announced publicly.
  const posted = guild.sent.slice(beforePosts).filter(
    (m) => m.channel === "300" && /expired/i.test(m.payload.embeds[0].data.title || "")
  );
  assert.equal(posted.length, 1);

  // Second sweep: nothing left, no double increment.
  const second = await processExpiredChallenges({ guild, config, at: new Date() });
  assert.equal(second.length, 0);
  const reignAfter = await openReign("zeus");
  assert.equal(Number(reignAfter.refusal_count), 2, "counter must not double-count");
});

test("the fourth challenge refused actively strips the modifier role", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge, refuseChallenge } = require("../src/systems/challenge");

  await handle.pool.query(
    `UPDATE reigns SET refusal_count = 3 WHERE seat_id = 'zeus' AND ended_at IS NULL`
  );

  const issued = await issueChallenge({
    challengerId: "8007",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(Number(issued.challenge.refusal_count_at_creation), 3);

  // Respond inside the 4-hour window (issued at WEDNESDAY 12:00Z,
  // deadline 16:00Z) - the real clock is past the deadline.
  const refused = await refuseChallenge({
    challengeId: Number(issued.challenge.challenge_id),
    userId: "8001",
    guild,
    config,
    at: new Date("2026-11-11T14:00:00Z"),
  });
  assert.equal(refused.ok, true, JSON.stringify(refused));
  assert.equal(refused.stripped, true);
  assert.equal(refused.newCount, 4);

  const row = await challengeRow(Number(issued.challenge.challenge_id));
  assert.equal(row.status, "stripped");
  assert.equal(row.strip_applied, true);

  // Throne vacated with the reason, and the holder is now gated to the next
  // Arena Day.
  const ended = await handle.pool.query(
    `SELECT * FROM reigns WHERE seat_id = 'zeus' AND ended_at IS NOT NULL`
  );
  assert.equal(ended.rows.length, 1);
  assert.equal(ended.rows[0].end_reason, "refusal_limit");
  assert.equal(await openReign("zeus"), null);

  const holder = await handle.pool.query(
    `SELECT throne_lost_at FROM members WHERE user_id = '8001'`
  );
  assert.ok(holder.rows[0].throne_lost_at, "throne-loss gate must be armed");

  // Discord modifier role removed from the holder.
  assert.ok(
    guild.removedRoles.some(
      (r) => r.userId === "8001" && r.roleId === "999001"
    ),
    "modifier role was not removed"
  );

  // Vacancy announced in #alerts.
  const alerts = guild.sent.filter(
    (m) => m.channel === "200" && /Throne vacant/.test(m.payload.embeds[0].data.title || "")
  );
  assert.equal(alerts.length, 1);

  // The seat is now vacant: challenges are refused in favour of a collection.
  const { issueChallenge: issue } = require("../src/systems/challenge");
  const r = await issue({
    challengerId: "8006",
    seatId: "zeus",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(r.code, "VACANT");
});

test("the fourth challenge expiring unanswered also strips the role", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge, processExpiredChallenges } = require("../src/systems/challenge");

  await handle.pool.query(
    `UPDATE reigns SET refusal_count = 3 WHERE seat_id = 'hades' AND ended_at IS NULL`
  );

  const issued = await issueChallenge({
    challengerId: "8002",
    seatId: "hades",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  assert.equal(Number(issued.challenge.refusal_count_at_creation), 3);

  await handle.pool.query(
    `UPDATE challenges SET status = 'cancelled'
      WHERE status = 'pending' AND challenge_id <> $1`,
    [issued.challenge.challenge_id]
  );

  const processed = await processExpiredChallenges({ guild, config, at: new Date() });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].stripped, true);
  assert.equal(processed[0].newCount, 4);

  const row = await challengeRow(Number(issued.challenge.challenge_id));
  assert.equal(row.status, "stripped");
  assert.equal(row.strip_applied, true);
  assert.equal(await openReign("hades"), null);

  assert.ok(
    guild.removedRoles.some(
      (r) => r.userId === "8003" && r.roleId === "999003"
    ),
    "hades modifier role was not removed"
  );

  const alerts = guild.sent.filter(
    (m) => m.channel === "200" && /Throne vacant/.test(m.payload.embeds[0].data.title || "")
  );
  assert.equal(alerts.length, 2, "one vacancy announcement per strip");
});

test("losing a throne auto-cancels pending challenges and refunds challengers", async (t) => {
  if (!guard(t)) return;
  const { issueChallenge, cancelPendingChallengesForSeat } = require("../src/systems/challenge");

  const issued = await issueChallenge({
    challengerId: "8101",
    seatId: "odin",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  const cancelled = await cancelPendingChallengesForSeat({
    seatId: "odin",
    reason: "holder removed by staff",
    at: new Date(),
  });
  assert.equal(cancelled, 1);

  const row = await challengeRow(Number(issued.challenge.challenge_id));
  assert.equal(row.status, "cancelled");
  assert.match(row.notes, /auto-cancelled: holder removed by staff/);

  // The challenger's daily chance is refunded.
  const again = await issueChallenge({
    challengerId: "8101",
    seatId: "odin",
    guild,
    config,
    at: WEDNESDAY,
  });
  assert.equal(again.ok, true, JSON.stringify(again));

  await cancelPendingChallengesForSeat({
    seatId: "odin",
    reason: "test cleanup",
    at: new Date(),
  });
});

// -------------------------------------------------- command + component

test("/challenge posts the challenge and the Accept button completes the flow", async (t) => {
  if (!guard(t)) return;
  const command = require("../src/commands/member/challenge");
  const component = require("../src/components/challenge");

  // The command derives "now" itself: pin the clock to an Arena Day
  // (Wed 2026-11-11 12:00Z) so issuance is allowed on any test-run date.
  t.mock.timers.enable({ apis: ["Date"], now: WEDNESDAY.getTime() });
  t.after(() => t.mock.timers.reset());

  function chatInteraction({ userId, targetUser }) {
    const replies = [];
    return {
      replies,
      user: { id: userId, username: `user${userId}` },
      options: { getUser: () => targetUser },
      guild,
      reply: async (payload) => {
        replies.push(payload);
        return { id: "reply1" };
      },
      followUp: async (payload) => {
        replies.push(payload);
      },
    };
  }

  // Targeting a non-holder fails clearly.
  let interaction = chatInteraction({
    userId: "8102",
    targetUser: { id: "8006", username: "challenger-c" },
  });
  await command.execute(interaction, { config, client: {} });
  assert.equal(interaction.replies.length, 1);
  assert.match(
    interaction.replies[0].embeds[0].data.description,
    /does not hold a Constellation throne/
  );

  const before = guild.sent.length;

  // Happy path against the surya holder.
  interaction = chatInteraction({
    userId: "8102",
    targetUser: { id: "8103", username: "surya-holder" },
  });
  await command.execute(interaction, { config, client: {} });
  assert.equal(guild.sent.length, before + 1);
  assert.equal(guild.sent[before].channel, "300");
  assert.match(
    interaction.replies[0].embeds[0].data.description,
    /challenge against \*\*Supreme God of Light\*\*/i
  );
  assert.equal(interaction.replies[0].ephemeral, true);

  const posted = guild.sent[guild.sent.length - 1];
  const acceptId = posted.payload.components[0].components[0].data.custom_id;
  const challengeId = Number(acceptId.split(":")[2]);

  // A stranger pressing Accept is rejected.
  interaction = chatInteraction({ userId: "8101", targetUser: null });
  interaction.customId = acceptId;
  await component.execute(interaction, { config, client: {} });
  assert.match(
    interaction.replies[0].embeds[0].data.description,
    /only the current constellation holder/i
  );

  // The holder pressing Accept succeeds.
  interaction = chatInteraction({ userId: "8103", targetUser: null });
  interaction.customId = acceptId;
  await component.execute(interaction, { config, client: {} });
  assert.match(
    interaction.replies[0].embeds[0].data.description,
    /challenge accepted/i
  );

  const row = await challengeRow(challengeId);
  assert.equal(row.status, "accepted");
  assert.ok(row.match_id, "accept must create the match");
});
