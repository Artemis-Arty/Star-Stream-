"use strict";

/**
 * Stage 5: Role Collections and throne management.
 *
 * Role Collection (spec section 6 + approved decisions):
 *  - A vacated seat opens a 4-hour collection in #alerts with a Join button.
 *  - Only unranked members may join (no throne-loss waiting gate - approved);
 *    the first two eligible members enter (DB cap + row lock).
 *  - 1 entrant at the deadline -> receives the role automatically (+1
 *    throne_accepts); 0 entrants -> closes and reopens on the next Arena Day
 *    at COLLECTION_OPEN_HOUR (env, approved); 2 entrants -> stays open,
 *    locked, awaiting the staff-supervised duel recorded via /match-result.
 *  - No-shows in the duel are a staff case-by-case decision: award the seat
 *    with /collection-manage award, or close it with /collection-manage close.
 *
 * Throne management (approved scope):
 *  - /throne-grant  - manually seat a holder (repair tool; closes any open
 *                     collection; does NOT count as throne_accepts).
 *  - /throne-strip  - remove a specific holder + role (punitive).
 *  - /throne-vacate - empty the seat (structural).
 *    Both strip and vacate arm the holder's Arena-Day waiting gate and open
 *    a Role Collection through announceStrip.
 *
 * Everything transactional; Discord role changes and announcements run after
 * commit. Automated actions (deadline sweeps, solo grants) are not staff
 * actions and are not written to the staff audit log; staff commands are.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { withTransaction, query } = require("../db/pool");
const RULES = require("../config/rules");
const {
  dayKey,
  isArenaDay,
  zonedParts,
  hoursFromNow,
  unixSeconds,
} = require("../utils/time");
const { postTo } = require("../utils/channels");
const { baseEmbed, COLORS } = require("../utils/embeds");
const { logger } = require("../logging/logger");
const { ensureMember } = require("../db/queries/members");
const {
  seatLabel,
  getSeat,
  removeModifierRole,
  grantModifierRole,
  announceStrip,
} = require("./challenge");
const { evaluateAchievements } = require("./achievements");
const { recordStaffAction } = require("./audit");

/** User-facing messages for every failure code. */
const MESSAGES = Object.freeze({
  NOT_FOUND: "That Role Collection no longer exists.",
  NOT_OPEN: "That Role Collection is closed.",
  EXPIRED: "The join window for that Role Collection has closed.",
  RANKED:
    "Only unranked members may join a Role Collection - you currently hold a throne.",
  ALREADY_JOINED: "You already joined that Role Collection.",
  FULL: "The first two eligible members have already entered.",
  SEAT_NOT_FOUND: "That Constellation seat does not exist.",
  SEAT_HELD: "That seat already has a holder - use /throne-strip first.",
  SEAT_VACANT: "That seat is already vacant.",
  NOT_HOLDER: "That member is not the current holder of that seat.",
  REASON_REQUIRED: "This staff action needs a reason for the audit log.",
  ENTRANT_REQUIRED:
    "The award target must be unranked - a throne holder cannot receive a collection.",
});

function errorMessage(code) {
  return MESSAGES[code] || "That Role Collection action could not be processed.";
}

// ------------------------------------------------------------- presentation

function collectionActionRow(collectionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`collection:join:${collectionId}`)
      .setLabel("Join Role Collection")
      .setStyle(ButtonStyle.Primary)
  );
}

/** The public #alerts announcement for an open collection. */
function collectionEmbed(collection, seat) {
  return baseEmbed({ color: COLORS.gold })
    .setTitle("🌟 Role Collection open")
    .setDescription(
      `${seatLabel(seat)} is **vacant** - the modifier role is up for grabs!\n` +
        `Unranked members may join with the button below for the next ` +
        `**${RULES.ROLE_COLLECTION_HOURS} hours** (closes <t:${unixSeconds(
          collection.deadline_at
        )}:f>).\n` +
        `• The first two eligible members enter a staff-supervised duel.\n` +
        `• A single entrant receives the role automatically.\n` +
        `• If nobody joins, the collection reopens on the next Arena Day.`
    )
    .setFooter({
      text: `Collection #${collection.collection_id} • ${collection.arena_day} • Star Stream`,
    });
}

// ------------------------------------------------------------------ opening

/**
 * Open a Role Collection for a vacant seat. Idempotent: an open collection
 * or a live reign means nothing to do (the unique index also guards races).
 * @returns {Promise<{ok:true, created:boolean, collection:object} | {ok:false, code:string}>}
 */
async function openCollectionForSeat(
  seatId,
  { guild, config, at = new Date(), reason = null }
) {
  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const s = await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [
        String(seatId),
      ]);
      const seat = s.rows[0];
      if (!seat || !seat.is_active) return { ok: false, code: "SEAT_NOT_FOUND" };

      const open = await client.query(
        `SELECT * FROM role_collections WHERE seat_id = $1 AND status = 'open'`,
        [String(seatId)]
      );
      if (open.rows.length > 0) {
        return { ok: true, created: false, collection: open.rows[0] };
      }

      const reign = await client.query(
        `SELECT reign_id FROM reigns WHERE seat_id = $1 AND ended_at IS NULL`,
        [String(seatId)]
      );
      if (reign.rows.length > 0) return { ok: false, code: "SEAT_HELD" };

      const inserted = await client.query(
        `INSERT INTO role_collections
           (seat_id, arena_day, opened_at, deadline_at, notes)
         VALUES ($1, $2::date, $3, $4, $5)
         RETURNING *`,
        [
          String(seatId),
          dayKey(at, config.timezone),
          at,
          hoursFromNow(RULES.ROLE_COLLECTION_HOURS, at),
          reason,
        ]
      );
      return { ok: true, created: true, collection: inserted.rows[0], seat };
    });
  } catch (err) {
    if (err.code === "23505") {
      // Lost the race with a concurrent opener: the collection exists.
      const existing = await query(
        `SELECT * FROM role_collections WHERE seat_id = $1 AND status = 'open'`,
        [String(seatId)]
      );
      return { ok: true, created: false, collection: existing.rows[0] || null };
    }
    throw err;
  }
  if (!outcome.ok || !outcome.created) return outcome;

  const seat = outcome.seat || (await getSeat(seatId));
  const message = await postTo("alerts", config, guild, {
    embeds: [collectionEmbed(outcome.collection, seat)],
    components: [collectionActionRow(outcome.collection.collection_id)],
  });
  if (message?.id) {
    // Best effort: remember where the announcement lives (/collection and
    // staff tooling can find it; a failure never affects the collection).
    try {
      await query(
        `UPDATE role_collections SET channel_id = $2, message_id = $3
          WHERE collection_id = $1`,
        [
          String(outcome.collection.collection_id),
          String(message.channel?.id ?? message.channel ?? ""),
          String(message.id),
        ]
      );
    } catch (err) {
      logger.warn(`Collection: could not store announcement ids: ${err.message}`);
    }
  }
  return outcome;
}

/**
 * Arena Day opener: every vacant seat with no collection yet today gets its
 * 4-hour window at COLLECTION_OPEN_HOUR (in TIMEZONE). One window per seat
 * per Arena Day; a mid-day vacancy always opens immediately regardless.
 */
async function openArenaDayCollections({ guild, config, at = new Date() }) {
  const tz = config.timezone;
  if (!isArenaDay(at, tz)) return [];

  const { hour } = zonedParts(at, tz);
  const openHour = config.collection?.openHour ?? 0;
  if (hour < openHour) return [];

  const today = dayKey(at, tz);
  const vacant = await query(
    `SELECT s.seat_id
       FROM seats s
      WHERE s.is_active
        AND NOT EXISTS (SELECT 1 FROM reigns r
                         WHERE r.seat_id = s.seat_id AND r.ended_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM role_collections c
                         WHERE c.seat_id = s.seat_id AND c.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM role_collections c2
                         WHERE c2.seat_id = s.seat_id AND c2.arena_day = $1::date)
      ORDER BY s.sort_order`,
    [today]
  );

  const opened = [];
  for (const row of vacant.rows) {
    try {
      const result = await openCollectionForSeat(row.seat_id, {
        guild,
        config,
        at,
        reason: "arena_day_reopen",
      });
      if (result.ok && result.created) opened.push(result.collection);
    } catch (err) {
      logger.warn(
        `Collection: Arena Day open failed for ${row.seat_id}: ${err.message}`
      );
    }
  }
  return opened;
}

// ------------------------------------------------------------------- joining

/**
 * Join an open Role Collection via the #alerts button.
 * The collection row is locked, so two members can never squeeze past the
 * two-entrant cap concurrently.
 * @returns {Promise<{ok:true, entrantCount:number, matchId?:number} | {ok:false, code:string}>}
 */
async function joinCollection({ collectionId, userId, guild, config, at = new Date() }) {
  await ensureMember(userId);

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM role_collections WHERE collection_id = $1 FOR UPDATE`,
        [String(collectionId)]
      );
      const collection = rows.rows[0];
      if (!collection) return { ok: false, code: "NOT_FOUND" };
      if (collection.status !== "open") return { ok: false, code: "NOT_OPEN" };
      if (new Date(collection.deadline_at).getTime() <= at.getTime()) {
        return { ok: false, code: "EXPIRED" };
      }

      // Unranked only (approved: no throne-loss waiting gate for collections).
      const held = await client.query(
        `SELECT 1 FROM reigns r
           JOIN seats s ON s.seat_id = r.seat_id
          WHERE r.holder_id = $1 AND r.ended_at IS NULL AND s.is_active = TRUE
          LIMIT 1`,
        [String(userId)]
      );
      if (held.rows.length > 0) return { ok: false, code: "RANKED" };

      const entries = await client.query(
        `SELECT user_id FROM role_collection_entries
          WHERE collection_id = $1
          ORDER BY joined_at`,
        [String(collectionId)]
      );
      if (entries.rows.some((e) => String(e.user_id) === String(userId))) {
        return { ok: false, code: "ALREADY_JOINED" };
      }
      if (entries.rows.length >= RULES.ROLE_COLLECTION_MAX_ENTRANTS) {
        return { ok: false, code: "FULL" };
      }

      await client.query(
        `INSERT INTO role_collection_entries (collection_id, user_id, joined_at)
         VALUES ($1, $2, $3)`,
        [String(collectionId), String(userId), at]
      );
      const entrantCount = entries.rows.length + 1;

      let matchId = null;
      if (entrantCount >= RULES.ROLE_COLLECTION_MAX_ENTRANTS) {
        // Entry locks: create the staff-supervised duel. No 15-minute
        // agreement window - both entrants opted in by joining, so the
        // match is started with /match-start whenever staff is ready.
        const inserted = await client.query(
          `INSERT INTO matches
             (match_type, seat_id, attacker_id, defender_id, created_by, status)
           VALUES ('role_collection', $1, $2, $3, $4, 'scheduled')
           RETURNING match_id`,
          [
            String(collection.seat_id),
            String(entries.rows[0].user_id),
            String(userId),
            String(userId),
          ]
        );
        matchId = Number(inserted.rows[0].match_id);
        await client.query(
          `UPDATE role_collections SET match_id = $2 WHERE collection_id = $1`,
          [String(collectionId), String(matchId)]
        );
      }

      return {
        ok: true,
        entrantCount,
        matchId,
        seatId: collection.seat_id,
        firstEntrantId: entrantCount >= 2 ? String(entries.rows[0].user_id) : null,
      };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "ALREADY_JOINED" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  if (outcome.matchId) {
    const seat = await getSeat(outcome.seatId);
    await postTo("alerts", config, guild, {
      embeds: [
        baseEmbed({ color: COLORS.primary })
          .setTitle("⚔️ Entrants locked")
          .setDescription(
            `Two members entered the Role Collection for ${seatLabel(seat)}:\n` +
              `<@${outcome.firstEntrantId}> vs <@${userId}>\n` +
              `Staff: run the supervised duel and record it with ` +
              `\`/match-start\` then \`/match-result\`, or resolve a no-show ` +
              `case-by-case with \`/collection-manage\`.`
          )
          .setFooter({ text: `Match #${outcome.matchId} • Star Stream` }),
      ],
    });
  }
  return outcome;
}

// ----------------------------------------------------------- deadline sweep

/**
 * Resolve every collection whose 4-hour window has passed:
 *   0 entrants -> close (no_entrants), reopens on the next Arena Day,
 *   1 entrant  -> close (solo_entrant) and grant the role automatically,
 *   2 entrants -> stays open (locked), awaiting the staff-recorded duel.
 * Idempotent: row locks + the status filter process each deadline once.
 */
async function processExpiredCollections({ guild, config, at = new Date() }) {
  const processed = [];

  await withTransaction(async (client) => {
    const rows = await client.query(
      `SELECT * FROM role_collections
        WHERE status = 'open' AND deadline_at <= $1
        ORDER BY deadline_at
        FOR UPDATE SKIP LOCKED`,
      [at]
    );

    for (const collection of rows.rows) {
      const entries = await client.query(
        `SELECT user_id FROM role_collection_entries
          WHERE collection_id = $1
          ORDER BY joined_at`,
        [String(collection.collection_id)]
      );
      const entrantIds = entries.rows.map((r) => String(r.user_id));

      if (entrantIds.length >= RULES.ROLE_COLLECTION_MAX_ENTRANTS) {
        // Duel pending - leave it open for staff (case-by-case no-shows).
        continue;
      }

      if (entrantIds.length === 1) {
        const winnerId = entrantIds[0];

        // The winner must still be unranked and the seat still vacant;
        // otherwise the solo grant is void (the seat reopens next Arena Day).
        const winnerHolds = await client.query(
          `SELECT 1 FROM reigns r
             JOIN seats s ON s.seat_id = r.seat_id
            WHERE r.holder_id = $1 AND r.ended_at IS NULL AND s.is_active = TRUE
            LIMIT 1`,
          [winnerId]
        );
        const seatHeld = await client.query(
          `SELECT 1 FROM reigns WHERE seat_id = $1 AND ended_at IS NULL`,
          [String(collection.seat_id)]
        );
        const eligible =
          winnerHolds.rows.length === 0 && seatHeld.rows.length === 0;

        const closed = await client.query(
          `UPDATE role_collections
              SET status = 'closed',
                  resolution = 'solo_entrant',
                  winner_id = $2,
                  closed_at = $3,
                  notes = COALESCE(CONCAT(notes, ' | '), '') || $4
            WHERE collection_id = $1 AND status = 'open'
            RETURNING *`,
          [
            String(collection.collection_id),
            eligible ? winnerId : null,
            at,
            eligible
              ? "solo entrant - role granted automatically"
              : "voided: winner no longer unranked or seat already filled",
          ]
        );

        if (eligible) {
          await client.query(
            `INSERT INTO reigns (seat_id, holder_id, started_at)
             VALUES ($1, $2, $3)`,
            [String(collection.seat_id), winnerId, at]
          );
          await client.query(
            `UPDATE members
                SET throne_accepts = throne_accepts + 1, updated_at = now()
              WHERE user_id = $1`,
            [winnerId]
          );
          processed.push({
            kind: "solo",
            collection: closed.rows[0],
            winnerId,
          });
        } else {
          processed.push({ kind: "voided", collection: closed.rows[0] });
        }
        continue;
      }

      const closed = await client.query(
        `UPDATE role_collections
            SET status = 'closed',
                resolution = 'no_entrants',
                closed_at = $2,
                notes = COALESCE(CONCAT(notes, ' | '), '') ||
                        'no entrants - reopens on the next Arena Day'
          WHERE collection_id = $1 AND status = 'open'
          RETURNING *`,
        [String(collection.collection_id), at]
      );
      processed.push({ kind: "empty", collection: closed.rows[0] });
    }
  });

  // Announcements after commit.
  for (const item of processed) {
    const seat = await getSeat(item.collection.seat_id);
    const reopenLine =
      `It reopens on the next Arena Day (Mon/Wed/Sat) at ` +
      `${String(config.collection?.openHour ?? 0).padStart(2, "0")}:00 ` +
      `${config.timezone}.`;

    if (item.kind === "solo") {
      await grantModifierRole({ guild, seat, userId: item.winnerId });
      await postTo("alerts", config, guild, {
        embeds: [
          baseEmbed({ color: COLORS.gold })
            .setTitle("🌟 Role Collection - solo entrant")
            .setDescription(
              `<@${item.winnerId}> was the only entrant for ${seatLabel(seat)} ` +
                `and receives the role automatically.`
            )
            .setFooter({
              text: `Collection #${item.collection.collection_id} • Star Stream`,
            }),
        ],
      });
      try {
        await evaluateAchievements(item.winnerId);
      } catch (err) {
        logger.warn(
          `Achievement evaluation failed for ${item.winnerId}: ${err.message}`
        );
      }
    } else {
      const title =
        item.kind === "voided"
          ? "🌟 Role Collection closed"
          : "🌟 Role Collection - nobody joined";
      const description =
        item.kind === "voided"
          ? `The Role Collection for ${seatLabel(seat)} closed without a winner ` +
            `(the entrant was no longer eligible or the seat was filled).\n${reopenLine}`
          : `Nobody joined the Role Collection for ${seatLabel(seat)}.\n${reopenLine}`;
      await postTo("alerts", config, guild, {
        embeds: [
          baseEmbed({ color: COLORS.primary })
            .setTitle(title)
            .setDescription(description)
            .setFooter({
              text: `Collection #${item.collection.collection_id} • Star Stream`,
            }),
        ],
      });
    }
  }

  return processed;
}

// ------------------------------------------------------------ staff commands

/** Open collection for a seat with its seat row (for staff commands). */
async function getOpenCollectionForSeat(seatId) {
  const result = await query(
    `SELECT rc.*, s.display_name, s.emoji, s.modifier_role_name, s.role_id
       FROM role_collections rc
       JOIN seats s ON s.seat_id = rc.seat_id
      WHERE rc.seat_id = $1 AND rc.status = 'open'`,
    [String(seatId)]
  );
  return result.rows[0] || null;
}

/** Full collection detail (entrants, linked match) for /collection-manage. */
async function getCollectionDetails(collectionId) {
  const result = await query(
    `SELECT rc.*, s.display_name, s.emoji, s.modifier_role_name, s.role_id
       FROM role_collections rc
       JOIN seats s ON s.seat_id = rc.seat_id
      WHERE rc.collection_id = $1`,
    [String(collectionId)]
  );
  const collection = result.rows[0];
  if (!collection) return null;
  const entries = await query(
    `SELECT user_id FROM role_collection_entries
      WHERE collection_id = $1 ORDER BY joined_at`,
    [String(collectionId)]
  );
  let match = null;
  if (collection.match_id) {
    const m = await query(`SELECT * FROM matches WHERE match_id = $1`, [
      String(collection.match_id),
    ]);
    match = m.rows[0] || null;
  }
  return {
    collection,
    entrantIds: entries.rows.map((r) => String(r.user_id)),
    match,
  };
}

/**
 * Staff award: hand the vacant seat to a member (case-by-case no-show
 * resolution or direct award). Closes the collection and cancels a pending
 * duel. Counts as a throne gain (+1 throne_accepts - approved).
 */
async function awardCollection({
  collectionId,
  userId,
  reason,
  actorId,
  guild,
  config,
  at = new Date(),
}) {
  const text = String(reason || "").trim();
  if (!text) return { ok: false, code: "REASON_REQUIRED" };
  await ensureMember(userId);

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM role_collections WHERE collection_id = $1 FOR UPDATE`,
        [String(collectionId)]
      );
      const collection = rows.rows[0];
      if (!collection) return { ok: false, code: "NOT_FOUND" };
      if (collection.status !== "open") return { ok: false, code: "NOT_OPEN" };

      const winnerHolds = await client.query(
        `SELECT 1 FROM reigns r
           JOIN seats s ON s.seat_id = r.seat_id
          WHERE r.holder_id = $1 AND r.ended_at IS NULL AND s.is_active = TRUE
          LIMIT 1`,
        [String(userId)]
      );
      if (winnerHolds.rows.length > 0) {
        return { ok: false, code: "ENTRANT_REQUIRED" };
      }
      const seatHeld = await client.query(
        `SELECT 1 FROM reigns WHERE seat_id = $1 AND ended_at IS NULL`,
        [String(collection.seat_id)]
      );
      if (seatHeld.rows.length > 0) return { ok: false, code: "SEAT_HELD" };

      const entries = await client.query(
        `SELECT user_id FROM role_collection_entries
          WHERE collection_id = $1 ORDER BY joined_at`,
        [String(collection.collection_id)]
      );
      const entrantIds = entries.rows.map((r) => String(r.user_id));
      const isEntrant = entrantIds.includes(String(userId));
      let resolution = null;
      if (entrantIds.length >= RULES.ROLE_COLLECTION_MAX_ENTRANTS) {
        resolution = "two_entrants";
      } else if (isEntrant && entrantIds.length === 1) {
        resolution = "solo_entrant";
      }

      const closed = await client.query(
        `UPDATE role_collections
            SET status = 'closed',
                winner_id = $2,
                resolution = $3,
                closed_at = $4,
                notes = COALESCE(CONCAT(notes, ' | '), '') || $5
          WHERE collection_id = $1 AND status = 'open'
          RETURNING *`,
        [
          String(collection.collection_id),
          String(userId),
          resolution,
          at,
          `awarded by staff (${actorId}): ${text}`,
        ]
      );

      if (collection.match_id) {
        await client.query(
          `UPDATE matches
              SET status = 'cancelled', updated_at = now(),
                  notes = COALESCE(CONCAT(notes, ' | '), '') ||
                          'collection resolved by staff award'
            WHERE match_id = $1 AND status IN ('scheduled', 'in_progress')`,
          [String(collection.match_id)]
        );
      }

      await client.query(
        `INSERT INTO reigns (seat_id, holder_id, started_at)
         VALUES ($1, $2, $3)`,
        [String(collection.seat_id), String(userId), at]
      );
      await client.query(
        `UPDATE members
            SET throne_accepts = throne_accepts + 1, updated_at = now()
          WHERE user_id = $1`,
        [String(userId)]
      );

      return {
        ok: true,
        collection: closed.rows[0],
        seatId: collection.seat_id,
        wasEntrant: isEntrant,
      };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "SEAT_HELD" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  const seat = await getSeat(outcome.seatId);
  await grantModifierRole({ guild, seat, userId });
  await postTo("alerts", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.gold })
        .setTitle("🌟 Role Collection awarded")
        .setDescription(
          `Staff awarded ${seatLabel(seat)} to <@${userId}>.\n` +
            `**Reason:** ${text}`
        )
        .setFooter({
          text: `Collection #${collectionId} • Star Stream`,
        }),
    ],
  });
  try {
    await evaluateAchievements(userId);
  } catch (err) {
    logger.warn(`Achievement evaluation failed for ${userId}: ${err.message}`);
  }
  await recordStaffAction({
    actorId,
    action: "collection.award",
    targetType: "collection",
    targetId: String(collectionId),
    previousValue: { status: "open", winner_id: null },
    newValue: { status: "closed", winner_id: String(userId) },
    reason: text,
  });
  return outcome;
}

/**
 * Staff close: end the collection with no winner (e.g. both entrants
 * no-showed and staff decided nobody gets the seat). The seat reopens on
 * the next Arena Day; a pending duel is cancelled.
 */
async function closeCollection({
  collectionId,
  reason,
  actorId,
  guild,
  config,
  at = new Date(),
}) {
  const text = String(reason || "").trim();
  if (!text) return { ok: false, code: "REASON_REQUIRED" };

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM role_collections WHERE collection_id = $1 FOR UPDATE`,
        [String(collectionId)]
      );
      const collection = rows.rows[0];
      if (!collection) return { ok: false, code: "NOT_FOUND" };
      if (collection.status !== "open") return { ok: false, code: "NOT_OPEN" };

      const closed = await client.query(
        `UPDATE role_collections
            SET status = 'closed',
                closed_at = $2,
                notes = COALESCE(CONCAT(notes, ' | '), '') || $3
          WHERE collection_id = $1 AND status = 'open'
          RETURNING *`,
        [String(collection.collection_id), at, `closed by staff (${actorId}): ${text}`]
      );

      if (collection.match_id) {
        await client.query(
          `UPDATE matches
              SET status = 'cancelled', updated_at = now(),
                  notes = COALESCE(CONCAT(notes, ' | '), '') ||
                          'collection closed by staff'
            WHERE match_id = $1 AND status IN ('scheduled', 'in_progress')`,
          [String(collection.match_id)]
        );
      }
      return { ok: true, collection: closed.rows[0] };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  const seat = await getSeat(outcome.collection.seat_id);
  await postTo("alerts", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.primary })
        .setTitle("🌟 Role Collection closed")
        .setDescription(
          `Staff closed the Role Collection for ${seatLabel(seat)} with no winner.\n` +
            `**Reason:** ${text}\n` +
            `It reopens on the next Arena Day (Mon/Wed/Sat).`
        )
        .setFooter({ text: `Collection #${collectionId} • Star Stream` }),
    ],
  });
  await recordStaffAction({
    actorId,
    action: "collection.close",
    targetType: "collection",
    targetId: String(collectionId),
    previousValue: { status: "open" },
    newValue: { status: "closed", winner_id: null },
    reason: text,
  });
  return outcome;
}

// ------------------------------------------------------------ throne tools

/**
 * /throne-grant - manually seat a holder on a vacant seat (repair tool).
 * Closes any open Role Collection for the seat. Deliberately does NOT
 * increment throne_accepts (a staff assignment is not a member accepting
 * a throne - documented Stage 5 decision).
 */
async function grantThrone({
  seatId,
  userId,
  reason = null,
  actorId,
  guild,
  config,
  at = new Date(),
}) {
  await ensureMember(userId);

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const s = await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [
        String(seatId),
      ]);
      const seat = s.rows[0];
      if (!seat || !seat.is_active) return { ok: false, code: "SEAT_NOT_FOUND" };

      const held = await client.query(
        `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL FOR UPDATE`,
        [String(seatId)]
      );
      if (held.rows.length > 0) return { ok: false, code: "SEAT_HELD" };

      // A direct grant supersedes any open collection for this seat.
      const open = await client.query(
        `SELECT * FROM role_collections WHERE seat_id = $1 AND status = 'open'`,
        [String(seatId)]
      );
      if (open.rows.length > 0) {
        await client.query(
          `UPDATE role_collections
              SET status = 'closed', closed_at = $2,
                  notes = COALESCE(CONCAT(notes, ' | '), '') || $3
            WHERE collection_id = $1`,
          [
            String(open.rows[0].collection_id),
            at,
            `seat filled by staff /throne-grant (${actorId})`,
          ]
        );
      }

      const reign = await client.query(
        `INSERT INTO reigns (seat_id, holder_id, started_at)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [String(seatId), String(userId), at]
      );
      return {
        ok: true,
        seat,
        reign: reign.rows[0],
        closedCollectionId: open.rows[0]
          ? Number(open.rows[0].collection_id)
          : null,
      };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "SEAT_HELD" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  await grantModifierRole({ guild, seat: outcome.seat, userId });
  await postTo("alerts", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.gold })
        .setTitle("👑 Throne granted")
        .setDescription(
          `Staff assigned ${seatLabel(outcome.seat)} to <@${userId}>.` +
            (reason ? `\n**Reason:** ${reason}` : "")
        )
        .setFooter({ text: `Reign started ${at.toISOString()} • Star Stream` }),
    ],
  });
  try {
    await evaluateAchievements(userId);
  } catch (err) {
    logger.warn(`Achievement evaluation failed for ${userId}: ${err.message}`);
  }
  await recordStaffAction({
    actorId,
    action: "throne.grant",
    targetType: "seat",
    targetId: String(seatId),
    previousValue: { holder_id: null },
    newValue: { holder_id: String(userId) },
    reason,
  });
  return outcome;
}

/**
 * Strip the modifier role from a SPECIFIC holder (punitive) and vacate the
 * seat. Arms the holder's Arena-Day waiting gate; announceStrip opens the
 * Role Collection.
 */
async function stripThrone({
  seatId,
  userId,
  reason,
  actorId,
  guild,
  config,
  at = new Date(),
}) {
  const text = String(reason || "").trim();
  if (!text) return { ok: false, code: "REASON_REQUIRED" };

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const s = await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [
        String(seatId),
      ]);
      const seat = s.rows[0];
      if (!seat || !seat.is_active) return { ok: false, code: "SEAT_NOT_FOUND" };

      const held = await client.query(
        `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL FOR UPDATE`,
        [String(seatId)]
      );
      if (held.rows.length === 0) return { ok: false, code: "SEAT_VACANT" };
      const reign = held.rows[0];
      if (String(reign.holder_id) !== String(userId)) {
        return { ok: false, code: "NOT_HOLDER" };
      }

      await client.query(
        `UPDATE reigns
            SET ended_at = $2, end_reason = 'staff_strip'
          WHERE reign_id = $1 AND ended_at IS NULL`,
        [String(reign.reign_id), at]
      );
      await client.query(
        `UPDATE members SET throne_lost_at = $2, updated_at = now()
          WHERE user_id = $1`,
        [String(userId), at]
      );
      return { ok: true, seat, holderId: String(userId) };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  await removeModifierRole({ guild, seat: outcome.seat, userId: outcome.holderId });
  // announceStrip posts the vacancy and opens the Role Collection.
  await announceStrip({
    seat: outcome.seat,
    holderId: outcome.holderId,
    guild,
    config,
    at,
    reason: `staff strip: ${text}`,
  });
  await recordStaffAction({
    actorId,
    action: "throne.strip",
    targetType: "seat",
    targetId: String(seatId),
    previousValue: { holder_id: outcome.holderId },
    newValue: { holder_id: null },
    reason: text,
  });
  return outcome;
}

/**
 * /throne-vacate - empty the seat regardless of holder (structural).
 * Arms the holder's waiting gate; announceStrip opens the collection.
 */
async function vacateThrone({
  seatId,
  reason,
  actorId,
  guild,
  config,
  at = new Date(),
}) {
  const text = String(reason || "").trim();
  if (!text) return { ok: false, code: "REASON_REQUIRED" };

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const s = await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [
        String(seatId),
      ]);
      const seat = s.rows[0];
      if (!seat || !seat.is_active) return { ok: false, code: "SEAT_NOT_FOUND" };

      const held = await client.query(
        `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL FOR UPDATE`,
        [String(seatId)]
      );
      if (held.rows.length === 0) return { ok: false, code: "SEAT_VACANT" };
      const reign = held.rows[0];

      await client.query(
        `UPDATE reigns
            SET ended_at = $2, end_reason = 'staff_vacate'
          WHERE reign_id = $1 AND ended_at IS NULL`,
        [String(reign.reign_id), at]
      );
      await client.query(
        `UPDATE members SET throne_lost_at = $2, updated_at = now()
          WHERE user_id = $1`,
        [String(reign.holder_id), at]
      );
      return { ok: true, seat, holderId: String(reign.holder_id) };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  await removeModifierRole({ guild, seat: outcome.seat, userId: outcome.holderId });
  await announceStrip({
    seat: outcome.seat,
    holderId: outcome.holderId,
    guild,
    config,
    at,
    reason: `staff vacate: ${text}`,
  });
  await recordStaffAction({
    actorId,
    action: "throne.vacate",
    targetType: "seat",
    targetId: String(seatId),
    previousValue: { holder_id: outcome.holderId },
    newValue: { holder_id: null },
    reason: text,
  });
  return outcome;
}

module.exports = {
  MESSAGES,
  errorMessage,
  collectionActionRow,
  collectionEmbed,
  openCollectionForSeat,
  openArenaDayCollections,
  joinCollection,
  processExpiredCollections,
  getOpenCollectionForSeat,
  getCollectionDetails,
  awardCollection,
  closeCollection,
  grantThrone,
  stripThrone,
  vacateThrone,
};
