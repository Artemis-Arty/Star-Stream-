"use strict";

/**
 * Challenge system - spec sections 2, 3, 4 and 5.
 *
 * Rules implemented (all approved decisions):
 *  - Challenges are only issued on Arena Days (Mon/Wed/Sat in TIMEZONE).
 *  - Exactly one active (pending or accepted) challenge per Constellation
 *    seat; an accepted challenge keeps the lock until the match result is
 *    recorded.
 *  - One challenge per Challenger per seat per Arena Day; a staff-cancelled
 *    challenge does not consume that chance (database-enforced).
 *  - 4-hour response window stored as a timestamp (survives restarts).
 *  - Refusals AND 4-hour timeouts both increment the holder's refusal
 *    counter; only a staff cancellation frees the challenger's daily chance.
 *  - After 3 refusals the 4th challenge must be accepted: refusing or
 *    ignoring it strips the modifier role and vacates the throne.
 *  - Accepting starts the 15-minute game-agreement window and creates the
 *    match row (staff then verify and record the result).
 *  - Losing a throne while a challenge is pending against you auto-cancels
 *    that challenge, refunding the challenger's daily chance.
 *
 * All state changes run inside transactions with row locks, so concurrent
 * buttons/timers can never double-apply a refusal, strip or reward.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const RULES = require("../config/rules");
const { withTransaction, query } = require("../db/pool");
const {
  isArenaDay,
  dayKey,
  eligibleToChallengeAfterThroneLoss,
  hoursFromNow,
  minutesFromNow,
  unixSeconds,
  WEEKDAYS,
} = require("../utils/time");
const { resolveChannelId, sendToChannel, postTo } = require("../utils/channels");
const { baseEmbed, COLORS } = require("../utils/embeds");
const { ensureMember } = require("../db/queries/members");
const { logger } = require("../logging/logger");

/** User-facing messages for every failure code. */
const MESSAGES = Object.freeze({
  NOT_ARENA_DAY:
    "Challenges can only be issued on Arena Days: Monday, Wednesday and Saturday.",
  SEAT_NOT_FOUND: "That member does not hold a Constellation throne.",
  VACANT:
    "That throne is vacant - a Role Collection opens it instead of a challenge.",
  SELF: "You cannot challenge yourself.",
  WAIT_ARENA_DAY:
    "You recently lost a throne and must wait until the next Arena Day before challenging again.",
  ALREADY_TODAY:
    "You have already challenged that Constellation today. Your chance against that seat is used - try a different one.",
  SEAT_BUSY:
    "That Constellation already has an active challenge. You can challenge a different seat.",
  HOLDER_ONLY: "Only the current Constellation holder can respond to this challenge.",
  NOT_PENDING: "This challenge has already been resolved.",
  EXPIRED: "The 4-hour response window for that challenge has already passed.",
  CHANNEL_ERROR:
    "Could not post in the challenge channel - a staff member must check the configured channel IDs.",
  DB_CONFLICT:
    "That challenge conflicts with an active rule (one challenge per seat, one per seat per Arena Day). Try again.",
  NOT_FOUND: "That challenge no longer exists.",
});

function errorMessage(code) {
  return MESSAGES[code] || "That challenge could not be processed.";
}

// ---------------------------------------------------------------- lookups

/** The seat a member currently holds (lowest sort order if several). */
async function findHolderSeat(userId) {
  const result = await query(
    `SELECT s.seat_id, s.display_name, s.modifier_role_name, s.emoji, s.role_id,
            s.sort_order, r.reign_id, r.refusal_count, r.started_at, r.holder_id
       FROM reigns r
       JOIN seats s ON s.seat_id = r.seat_id
      WHERE r.holder_id = $1 AND r.ended_at IS NULL AND s.is_active = TRUE
      ORDER BY s.sort_order
      LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

/** Seat row plus its open reign (null holder = vacant). */
async function getSeatWithHolder(seatId) {
  const result = await query(
    `SELECT s.seat_id, s.display_name, s.modifier_role_name, s.emoji, s.role_id,
            s.is_active, r.reign_id, r.holder_id, r.refusal_count, r.started_at
       FROM seats s
       LEFT JOIN reigns r ON r.seat_id = s.seat_id AND r.ended_at IS NULL
      WHERE s.seat_id = $1`,
    [seatId]
  );
  return result.rows[0] || null;
}

async function getSeat(seatId) {
  const result = await query(`SELECT * FROM seats WHERE seat_id = $1`, [seatId]);
  return result.rows[0] || null;
}

function seatLabel(seat) {
  return `${seat.emoji || "🌌"} **${seat.display_name}**`;
}

/**
 * Best-effort removal of the seat's Discord modifier role after a strip.
 * Runs AFTER the transaction commits; a Discord failure must never undo the
 * database state (the announcement still tells staff what happened).
 */
async function removeModifierRole({ guild, seat, userId }) {
  if (!seat?.role_id || !guild?.members) return false;
  try {
    const member = await guild.members.fetch(String(userId));
    await member.roles.remove(String(seat.role_id));
    return true;
  } catch (err) {
    logger.warn(
      `Strip: could not remove role ${seat.role_id} from ${userId}: ${err.message}`
    );
    return false;
  }
}

/**
 * Best-effort grant of the seat's Discord modifier role after a throne is
 * won or assigned. Same contract as removeModifierRole: runs AFTER commit,
 * a Discord failure is logged, never thrown.
 */
async function grantModifierRole({ guild, seat, userId }) {
  if (!seat?.role_id || !guild?.members) return false;
  try {
    const member = await guild.members.fetch(String(userId));
    await member.roles.add(String(seat.role_id));
    return true;
  } catch (err) {
    logger.warn(
      `Throne: could not grant role ${seat.role_id} to ${userId}: ${err.message}`
    );
    return false;
  }
}

// ---------------------------------------------------------------- helpers

function challengeActionRow(challengeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge:accept:${challengeId}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`challenge:refuse:${challengeId}`)
      .setLabel("Refuse")
      .setStyle(ButtonStyle.Danger)
  );
}

async function challengeEmbed(challenge, seat, config) {
  const dow = WEEKDAYS[new Date(`${challenge.arena_day}T00:00:00Z`).getUTCDay()];
  return baseEmbed({ color: COLORS.gold })
    .setTitle("⚔️ New Challenge")
    .addFields(
      {
        name: "Challenger",
        value: `<@${challenge.challenger_id}>`,
        inline: true,
      },
      {
        name: "Constellation",
        value: `<@${seat.holder_id}> — ${seatLabel(seat)}`,
        inline: true,
      },
      {
        name: "Refusals",
        value: `${seat.refusal_count}/${RULES.REFUSAL_LIMIT}`,
        inline: true,
      },
      {
        name: "Response window",
        value:
          `**4 hours** — expires <t:${unixSeconds(challenge.response_deadline_at)}:R>\n` +
          `Issued on the Arena Day of ${challenge.arena_day} (${dow}).`,
        inline: false,
      },
      {
        name: "What happens next",
        value:
          "The Constellation must **Accept** or **Refuse** within 4 hours.\n" +
          "A refusal or timeout adds to their refusal counter; after " +
          `${RULES.REFUSAL_LIMIT}, the fourth challenge must be accepted or the role is lost.`,
        inline: false,
      }
    )
    .setFooter({ text: `Challenge #${challenge.challenge_id} • Star Stream` });
}

/**
 * Strip the modifier role from a holder and vacate the throne.
 * MUST be called inside the transaction that resolved the challenge.
 * `matchId` (optional) records which match ended the reign.
 * Returns true when the throne was vacated.
 */
async function stripThroneTx(client, { reign, seatId, at, reason, matchId = null }) {
  const ended = await client.query(
    `UPDATE reigns
        SET ended_at = $2, end_reason = $3,
            ended_by_match_id = COALESCE($4, ended_by_match_id)
      WHERE reign_id = $1 AND ended_at IS NULL
      RETURNING reign_id`,
    [reign.reign_id, at, reason, matchId == null ? null : String(matchId)]
  );
  if (ended.rows.length === 0) return false; // already ended elsewhere

  await client.query(
    `UPDATE members
        SET throne_lost_at = $2, updated_at = now()
      WHERE user_id = $1`,
    [reign.holder_id, at]
  );

  // Any other pending challenge against this seat is void: the holder is gone.
  await cancelPendingChallengesForSeatTx(client, {
    seatId,
    reason: `holder lost the throne (${reason})`,
    at,
  });
  return true;
}

/** Cancel every pending/accepted challenge on a seat (inside a transaction). */
async function cancelPendingChallengesForSeatTx(client, { seatId, reason, at }) {
  const result = await client.query(
    `UPDATE challenges
        SET status = 'cancelled',
            resolved_at = $2,
            notes = COALESCE(CONCAT(notes, ' | '), '') || $3
      WHERE seat_id = $1 AND status IN ('pending', 'accepted')`,
    [seatId, at, `auto-cancelled: ${reason}`]
  );
  return result.rowCount;
}

// ---------------------------------------------------------------- issuing

/**
 * Issue a challenge against a Constellation seat.
 * @param {{challengerId:string, seatId:string, guild:object, config:object, at?:Date}} args
 * @returns {Promise<{ok:true, challenge:object, seat:object} | {ok:false, code:string}>}
 */
async function issueChallenge({ challengerId, seatId, guild, config, at = new Date() }) {
  const tz = config.timezone;

  if (!isArenaDay(at, tz)) return { ok: false, code: "NOT_ARENA_DAY" };

  const seat = await getSeatWithHolder(seatId);
  if (!seat || !seat.is_active) return { ok: false, code: "SEAT_NOT_FOUND" };
  if (!seat.holder_id) return { ok: false, code: "VACANT" };
  if (String(seat.holder_id) === String(challengerId)) {
    return { ok: false, code: "SELF" };
  }

  await ensureMember(challengerId);

  // Challenger eligibility: an active holder is always eligible; an unranked
  // member must have waited out the next-Arena-Day gate after a throne loss.
  const ownReign = await findHolderSeat(challengerId);
  if (!ownReign) {
    const memberRow = await query(
      `SELECT throne_lost_at FROM members WHERE user_id = $1`,
      [challengerId]
    );
    const lostAt = memberRow.rows[0]?.throne_lost_at || null;
    if (!eligibleToChallengeAfterThroneLoss(lostAt, at, tz)) {
      return { ok: false, code: "WAIT_ARENA_DAY" };
    }
  }

  // Friendly pre-checks (the database unique indexes are the real guard).
  const arenaDay = dayKey(at, tz);
  const already = await query(
    `SELECT challenge_id FROM challenges
      WHERE challenger_id = $1 AND seat_id = $2 AND arena_day = $3
        AND status <> 'cancelled'
      LIMIT 1`,
    [challengerId, seatId, arenaDay]
  );
  if (already.rows.length > 0) return { ok: false, code: "ALREADY_TODAY" };

  const active = await query(
    `SELECT challenge_id FROM challenges
      WHERE seat_id = $1 AND status IN ('pending', 'accepted')
      LIMIT 1`,
    [seatId]
  );
  if (active.rows.length > 0) return { ok: false, code: "SEAT_BUSY" };

  const channelId = await resolveChannelId("challenge", config);
  if (!channelId) return { ok: false, code: "CHANNEL_ERROR" };

  const deadline = hoursFromNow(RULES.CHALLENGE_RESPONSE_HOURS, at);
  let challenge;
  try {
    const inserted = await query(
      `INSERT INTO challenges
         (seat_id, challenger_id, arena_day, response_deadline_at,
          refusal_count_at_creation, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [seatId, challengerId, arenaDay, deadline, seat.refusal_count, channelId]
    );
    challenge = inserted.rows[0];
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }

  // Post the challenge; if the channel is broken, remove the row again so a
  // ghost challenge never blocks the seat for 4 hours.
  const message = await sendToChannel(guild, channelId, {
    embeds: [await challengeEmbed(challenge, seat, config)],
    components: [challengeActionRow(challenge.challenge_id)],
  });
  if (!message) {
    await query(`DELETE FROM challenges WHERE challenge_id = $1`, [
      challenge.challenge_id,
    ]);
    return { ok: false, code: "CHANNEL_ERROR" };
  }

  await query(
    `UPDATE challenges SET message_id = $2 WHERE challenge_id = $1`,
    [challenge.challenge_id, message.id]
  );

  return {
    ok: true,
    challenge: { ...challenge, message_id: message.id },
    seat,
  };
}

// -------------------------------------------------------------- responses

/** Load and lock a pending challenge inside a transaction. */
async function loadPendingChallengeTx(client, challengeId, at) {
  const rows = await client.query(
    `SELECT * FROM challenges WHERE challenge_id = $1 FOR UPDATE`,
    [challengeId]
  );
  const challenge = rows.rows[0];
  if (!challenge) return { error: "NOT_FOUND" };
  if (challenge.status !== "pending") return { error: "NOT_PENDING" };
  if (new Date(challenge.response_deadline_at).getTime() <= at.getTime()) {
    return { error: "EXPIRED" };
  }
  return { challenge };
}

/** Lock and return the seat's open reign; verifies the responder is the holder. */
async function loadHolderReignTx(client, seatId, userId) {
  const rows = await client.query(
    `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL FOR UPDATE`,
    [seatId]
  );
  const reign = rows.rows[0];
  if (!reign || String(reign.holder_id) !== String(userId)) {
    return { error: "HOLDER_ONLY" };
  }
  return { reign };
}

/**
 * The Constellation accepts: the challenge locks the seat, the match row is
 * created and the 15-minute game-agreement window starts.
 */
async function acceptChallenge({ challengeId, userId, guild, config, at = new Date() }) {
  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const loaded = await loadPendingChallengeTx(client, challengeId, at);
      if (loaded.error) return { ok: false, code: loaded.error };

      const held = await loadHolderReignTx(client, loaded.challenge.seat_id, userId);
      if (held.error) return { ok: false, code: held.error };

      const updated = await client.query(
        `UPDATE challenges
            SET status = 'accepted', responded_at = $2
          WHERE challenge_id = $1 AND status = 'pending'
          RETURNING *`,
        [challengeId, at]
      );
      if (updated.rows.length === 0) return { ok: false, code: "NOT_PENDING" };

      const match = await client.query(
        `INSERT INTO matches
           (match_type, challenge_id, seat_id, attacker_id, defender_id,
            created_by, status, game_agreed_deadline_at)
         VALUES ('challenge', $1, $2, $3, $4, $4, 'scheduled', $5)
         RETURNING *`,
        [
          challengeId,
          loaded.challenge.seat_id,
          loaded.challenge.challenger_id,
          userId,
          minutesFromNow(RULES.GAME_AGREE_MINUTES, at),
        ]
      );
      await client.query(
        `UPDATE challenges SET match_id = $2 WHERE challenge_id = $1`,
        [challengeId, match.rows[0].match_id]
      );

      return {
        ok: true,
        // The RETURNING row above predates the match link: merge it in so
        // callers see the committed state.
        challenge: { ...updated.rows[0], match_id: match.rows[0].match_id },
        match: match.rows[0],
      };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }

  if (!outcome.ok) return outcome;

  const seat = await getSeat(outcome.challenge.seat_id);
  await postTo("challenge", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.success })
        .setTitle("✅ Challenge accepted")
        .addFields(
          {
            name: "Match",
            value: `<@${outcome.challenge.challenger_id}> vs <@${userId}> — ${seatLabel(seat)}`,
            inline: false,
          },
          {
            name: "🎮 Game agreement — 15 minutes",
            value:
              `Both players have 15 minutes to agree on any mutually accepted 1v1 game or bot ` +
              `(Free Fire, PUBG, Chess, OwO Battle, Rock-Paper-Scissors…).\n` +
              `If no game is agreed by <t:${unixSeconds(
                outcome.match.game_agreed_deadline_at
              )}:R>, the neutral default applies: **3 rounds of OwO Battle** or **3 rounds of Rock-Paper-Scissors**.`,
            inline: false,
          },
          {
            name: "Staff",
            value: `Run \`/match-start\` to register match #${outcome.match.match_id}, verify evidence, then record the result.`,
            inline: false,
          }
        ),
    ],
  });

  return outcome;
}

/**
 * The Constellation refuses: increments the refusal counter; on the fourth
 * challenge the modifier role is stripped and the throne is vacated.
 */
async function refuseChallenge({ challengeId, userId, guild, config, at = new Date() }) {
  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const loaded = await loadPendingChallengeTx(client, challengeId, at);
      if (loaded.error) return { ok: false, code: loaded.error };

      const held = await loadHolderReignTx(client, loaded.challenge.seat_id, userId);
      if (held.error) return { ok: false, code: held.error };

      const challenge = loaded.challenge;
      const reign = held.reign;
      const isFourth =
        Number(challenge.refusal_count_at_creation ?? 0) >= RULES.REFUSAL_LIMIT;
      const newCount = Number(reign.refusal_count) + 1;

      await client.query(
        `UPDATE reigns SET refusal_count = $2 WHERE reign_id = $1`,
        [reign.reign_id, newCount]
      );

      if (isFourth) {
        await client.query(
          `UPDATE challenges
              SET status = 'stripped', strip_applied = TRUE,
                  refuser_id = $2, responded_at = $3, resolved_at = $3
            WHERE challenge_id = $1`,
          [challengeId, userId, at]
        );
        await stripThroneTx(client, {
          reign,
          seatId: challenge.seat_id,
          at,
          reason: "refusal_limit",
        });
        return { ok: true, stripped: true, newCount, challenge };
      }

      const updated = await client.query(
        `UPDATE challenges
            SET status = 'refused', refuser_id = $2,
                responded_at = $3, resolved_at = $3
          WHERE challenge_id = $1 AND status = 'pending'
          RETURNING *`,
        [challengeId, userId, at]
      );
      if (updated.rows.length === 0) return { ok: false, code: "NOT_PENDING" };
      return { ok: true, stripped: false, newCount, challenge: updated.rows[0] };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }

  if (!outcome.ok) return outcome;

  const seat = await getSeat(outcome.challenge.seat_id);
  await postTo("challenge", config, guild, {
    embeds: [
      baseEmbed({ color: outcome.stripped ? COLORS.danger : COLORS.primary })
        .setTitle(outcome.stripped ? "❌ Fourth refusal — role stripped" : "❌ Challenge refused")
        .setDescription(
          `<@${outcome.challenge.challenger_id}> challenged ${seatLabel(seat)} ` +
            `(<@${userId}>), who refused.\n` +
            `Refusals: **${outcome.newCount}/${RULES.REFUSAL_LIMIT}**`
        )
        .setFooter({ text: `Challenge #${challengeId} • Star Stream` }),
    ],
  });

  if (outcome.stripped) {
    await removeModifierRole({ guild, seat, userId });
    await announceStrip({ seat, holderId: userId, guild, config, at });
  }

  return outcome;
}

/**
 * Public announcements after a throne is vacated. Every strip path funnels
 * here (refusal, 4th no-show, staff strip/vacate), and this is also where
 * the seat's Role Collection is opened - a vacancy always opens one
 * (spec section 6). The collection module is required lazily to avoid a
 * module cycle (collection.js imports this file at load time).
 *
 * @param {{seat:object, holderId:string, guild:object, config:object,
 *          at:Date, reason?:string, openCollection?:boolean}} args
 */
async function announceStrip({
  seat,
  holderId,
  guild,
  config,
  at,
  reason = null,
  openCollection = true,
}) {
  await postTo("alerts", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.danger })
        .setTitle("🌟 Throne vacant")
        .setDescription(
          `${seatLabel(seat)} (held by <@${holderId}>) lost the modifier role` +
            (reason
              ? ` (${reason}).\n`
              : ` after ${RULES.REFUSAL_LIMIT} unanswered challenges.\n`) +
            `The official role has been removed from the holder.\n` +
            `A **Role Collection** for this seat will be announced in this channel.`
        )
        .setFooter({ text: `Vacated at ${at.toISOString()} • Star Stream` }),
    ],
  });

  if (openCollection) {
    try {
      await require("./collection").openCollectionForSeat(seat.seat_id, {
        guild,
        config,
        at,
        reason: reason || "throne_vacated",
      });
    } catch (err) {
      logger.warn(
        `Strip: could not open a Role Collection for ${seat.seat_id}: ${err.message}`
      );
    }
  }
}

/**
 * Process every challenge whose 4-hour window has passed. Idempotent:
 * row locks + the pending filter guarantee each challenge is processed
 * exactly once, even across restarts or concurrent sweeps.
 */
async function processExpiredChallenges({ guild, config, at = new Date() }) {
  const processed = [];

  await withTransaction(async (client) => {
    const rows = await client.query(
      `SELECT * FROM challenges
        WHERE status = 'pending' AND response_deadline_at <= $1
        ORDER BY response_deadline_at
        FOR UPDATE SKIP LOCKED`,
      [at]
    );

    for (const challenge of rows.rows) {
      const reignRows = await client.query(
        `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL FOR UPDATE`,
        [challenge.seat_id]
      );
      const reign = reignRows.rows[0];

      if (!reign) {
        // Holder vanished without cleanup - resolve without touching counters.
        await client.query(
          `UPDATE challenges SET status = 'expired', resolved_at = $2
            WHERE challenge_id = $1`,
          [challenge.challenge_id, at]
        );
        processed.push({ challenge, stripped: false, holderGone: true });
        continue;
      }

      const isFourth =
        Number(challenge.refusal_count_at_creation ?? 0) >= RULES.REFUSAL_LIMIT;
      const newCount = Number(reign.refusal_count) + 1;

      await client.query(
        `UPDATE reigns SET refusal_count = $2 WHERE reign_id = $1`,
        [reign.reign_id, newCount]
      );

      if (isFourth) {
        await client.query(
          `UPDATE challenges
              SET status = 'stripped', strip_applied = TRUE, resolved_at = $2
            WHERE challenge_id = $1`,
          [challenge.challenge_id, at]
        );
        await stripThroneTx(client, {
          reign,
          seatId: challenge.seat_id,
          at,
          reason: "refusal_limit",
        });
        processed.push({ challenge, stripped: true, newCount, reign });
      } else {
        await client.query(
          `UPDATE challenges
              SET status = 'expired', resolved_at = $2
            WHERE challenge_id = $1 AND status = 'pending'`,
          [challenge.challenge_id, at]
        );
        processed.push({ challenge, stripped: false, newCount, reign });
      }
    }
  });

  // Announcements run after commit so readers never see half a state.
  for (const item of processed) {
    const seat = await getSeat(item.challenge.seat_id);
    if (item.holderGone) {
      logger.warn(
        `Challenge #${item.challenge.challenge_id} expired but the seat had no holder.`
      );
      continue;
    }
    const holderId = item.reign?.holder_id || "unknown";
    await postTo("challenge", config, guild, {
      embeds: [
        baseEmbed({ color: item.stripped ? COLORS.danger : COLORS.primary })
          .setTitle(item.stripped ? "⏳ Fourth challenge unanswered — role stripped" : "⏳ Challenge expired")
          .setDescription(
            `<@${item.challenge.challenger_id}> challenged ${seatLabel(seat)} ` +
              `(<@${holderId}>) did not respond within 4 hours.\n` +
              `Refusals: **${item.newCount}/${RULES.REFUSAL_LIMIT}**`
          )
          .setFooter({ text: `Challenge #${item.challenge.challenge_id} • Star Stream` }),
      ],
    });
    if (item.stripped) {
      await removeModifierRole({
        guild,
        seat,
        userId: item.reign.holder_id,
      });
      await announceStrip({
        seat,
        holderId: item.reign.holder_id,
        guild,
        config,
        at,
      });
    }
  }

  return processed;
}

/**
 * Cancel every active challenge on a seat because the holder changed.
 * Used when a throne is vacated by any path (refusal strip, match result,
 * staff reassignment).
 * @returns {Promise<number>} how many challenges were cancelled
 */
async function cancelPendingChallengesForSeat({ seatId, reason, at = new Date() }) {
  return withTransaction((client) =>
    cancelPendingChallengesForSeatTx(client, { seatId, reason, at })
  );
}

/** Staff cancellation: frees the seat AND the challenger's daily chance. */
async function cancelChallenge({ challengeId, actorId, reason = null, at = new Date() }) {
  const result = await withTransaction(async (client) => {
    const rows = await client.query(
      `SELECT * FROM challenges WHERE challenge_id = $1 FOR UPDATE`,
      [challengeId]
    );
    const challenge = rows.rows[0];
    if (!challenge) return { ok: false, code: "NOT_FOUND" };
    if (!["pending", "accepted"].includes(challenge.status)) {
      return { ok: false, code: "NOT_PENDING" };
    }
    const updated = await client.query(
      `UPDATE challenges
          SET status = 'cancelled', resolved_at = $2,
              notes = COALESCE(CONCAT(notes, ' | '), '') || $3
        WHERE challenge_id = $1
        RETURNING *`,
      [challengeId, at, `cancelled by staff${reason ? `: ${reason}` : ""}`]
    );
    // An accepted challenge carries its match: cancelling the challenge
    // cancels the match too, so no orphan match stays open.
    if (challenge.match_id) {
      await client.query(
        `UPDATE matches
            SET status = 'cancelled', updated_at = now()
          WHERE match_id = $1 AND status IN ('scheduled', 'in_progress')`,
        [String(challenge.match_id)]
      );
    }
    return { ok: true, challenge: updated.rows[0] };
  });

  if (result.ok) {
    logger.info(
      `Challenge #${challengeId} cancelled by staff ${actorId}${
        reason ? ` (${reason})` : ""
      }`
    );
  }
  return result;
}

module.exports = {
  MESSAGES,
  errorMessage,
  findHolderSeat,
  getSeatWithHolder,
  getSeat,
  seatLabel,
  stripThroneTx,
  removeModifierRole,
  grantModifierRole,
  announceStrip,
  issueChallenge,
  acceptChallenge,
  refuseChallenge,
  processExpiredChallenges,
  cancelPendingChallengesForSeat,
  cancelChallenge,
  challengeActionRow,
  challengeEmbed,
};
