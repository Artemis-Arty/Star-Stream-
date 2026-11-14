"use strict";

/**
 * Stage 4: match supervision, verification and disputes.
 *
 * Flow (every mechanic below is an approved decision, nothing invented):
 *  - An accepted challenge creates a `scheduled` match carrying a persisted
 *    15-minute game-agreement window (matches.game_agreed_deadline_at).
 *  - /match-start records the agreed game and moves the match to
 *    `in_progress`. If the window lapses first, the sweeper cancels the
 *    match and refunds the challenger's daily chance (challenge -> cancelled).
 *  - /match-result records the outcome WITH at least one proof link. Staff
 *    attach all evidence (approved); no proof = no recording, and the throne
 *    switches immediately on recording:
 *      attacker_victory + accept_throne -> challenger takes the seat. A
 *        challenger who ALREADY holds a throne picks 'won' (take the new
 *        seat, their old one is released to a Role Collection) or 'current'
 *        (keep their old seat, the won seat is released to a Role Collection).
 *      attacker_victory + kill          -> seat vacated, +1 Kill.
 *      defender_victory + subdue        -> defender keeps the throne, +1 Subdued.
 *      defender_victory + swap          -> defender picks 'won' or 'current';
 *        the seat they do not keep is released to a Role Collection.
 *      abandon_attacker                 -> challenger forfeits: defender gets a
 *        full win (wins, streak, Subdued + defense event), chance consumed.
 *      abandon_defender                 -> holder no-show counts as a refusal:
 *        refusal counter +1; the 4th strips the role (same as Refuse).
 *  - Subdued increases on EVERY successful defense (merged-stat decision).
 *  - Stats: win = wins+1 / streak+1 (best updated), loss = losses+1 / streak 0;
 *    the accept-throne choice resets the winner's streak after the win counts.
 *  - Disputes: members ping staff; staff open/resolve via /resolve-dispute.
 *    Effects of a recorded result stay in place while disputed (approved);
 *    corrections use the staff data-correction tools.
 *
 * All state changes run in transactions with row locks (each result applies
 * exactly once); Discord role changes and announcements run AFTER commit so
 * a Discord failure can never roll back game state.
 */

const { withTransaction, query } = require("../db/pool");
const RULES = require("../config/rules");
const { postTo } = require("../utils/channels");
const { baseEmbed, COLORS } = require("../utils/embeds");
const { logger } = require("../logging/logger");
const { ensureMember } = require("../db/queries/members");
const {
  stripThroneTx,
  removeModifierRole,
  grantModifierRole,
  seatLabel,
  getSeat,
  announceStrip,
} = require("./challenge");
const { openCollectionForSeat } = require("./collection");
const { evaluateAchievements } = require("./achievements");
const { recordStaffAction } = require("./audit");

const DEFAULT_GAME_LABEL = RULES.DEFAULT_GAMES.map((g) => g.label).join(" or ");

const SUPPORTED_OUTCOMES = Object.freeze([
  "attacker_victory",
  "defender_victory",
  "abandon_attacker",
  "abandon_defender",
]);

const CHOICES_BY_OUTCOME = Object.freeze({
  attacker_victory: ["accept_throne", "kill"],
  defender_victory: ["subdue", "swap"],
  abandon_attacker: ["none"],
  abandon_defender: ["none"],
});

/** User-facing messages for every failure code. */
const MESSAGES = Object.freeze({
  NOT_FOUND: "That match does not exist.",
  NOT_SCHEDULED: "That match has already been started.",
  WINDOW_EXPIRED:
    "The 15-minute game-agreement window has passed - that match must be cancelled instead.",
  NOT_IN_PROGRESS:
    "That match is not accepting a result. Start it first with /match-start, and record a result only once.",
  UNSUPPORTED_TYPE:
    "Only challenge and Role Collection matches are managed by /match-result.",
  INVALID_OUTCOME: "That outcome does not exist for a challenge match.",
  INVALID_CHOICE:
    "That winner choice does not fit the outcome (attacker wins choose accept_throne or kill; defender wins choose subdue or swap).",
  ILLEGAL_CHOICE:
    "Swap requires the defeated Challenger to hold a throne - use subdue instead.",
  SEAT_CHOICE_REQUIRED:
    "The winner already holds a throne: pass seat_choice 'won' (take the won throne) or 'current' (keep the one you hold).",
  INVALID_PROOF: "Every proof link must be a full http(s) URL.",
  PROOF_REQUIRED:
    "A result cannot be recorded without at least one screenshot/proof link - paste the screenshot URL(s) in the proof option.",
  HOLDER_GONE:
    "The seat has no current holder matching that match - fix the throne first, then record the result.",
  COLLECTION_NO_SHOW:
    "No-shows in a Role Collection duel are a staff decision: record the victory of the entrant who played, or close the collection with /collection-manage.",
  COLLECTION_NOT_OPEN:
    "No Role Collection is open for that seat anymore - resolve it with /collection-manage first.",
  SEAT_NOT_VACANT:
    "That seat is no longer vacant, so the duel is void - use /collection-manage to resolve it.",
  NOT_VERIFIED: "Only a recorded result can be disputed.",
  ALREADY_DISPUTED: "That match already has an open dispute.",
  NOT_DISPUTED: "That match has no open dispute to resolve.",
  DISPUTE_REASON_REQUIRED: "A dispute needs a reason.",
  DB_CONFLICT:
    "That update conflicted with another action - check the match with /match-status and try again.",
});

function errorMessage(code) {
  return MESSAGES[code] || "That match could not be processed.";
}

/** Display labels shared by /match-status and /match-review. */
const STATUS_LABELS = Object.freeze({
  scheduled: "⏳ Scheduled",
  in_progress: "▶️ In progress",
  evidence_pending: "📎 Evidence pending",
  awaiting_verification: "🔍 Awaiting verification",
  verified: "✅ Verified",
  disputed: "⚠️ Disputed",
  cancelled: "🚫 Cancelled",
  abandoned: "🏳️ Abandoned",
});

function outcomeLabel(match) {
  switch (match.outcome) {
    case "attacker_victory":
      if (match.winner_choice === "accept_throne") return "Throne taken";
      if (match.winner_choice === "kill") return "Kill - throne vacated";
      return "Attacker wins";
    case "defender_victory":
      if (match.winner_choice === "swap") return "Throne seized (swap)";
      if (match.winner_choice === "subdue") return "Defense held (subdue)";
      return "Defender wins";
    case "abandon_attacker":
      return "Challenger forfeited";
    case "abandon_defender":
      return "Holder no-show";
    case "role_collection":
      return "Role Collection match";
    case "other":
      return "Other";
    default:
      return "-";
  }
}

/**
 * Parse staff-supplied proof input into a validated URL list.
 * Returns null when a token is not an http(s) URL, [] when nothing given.
 */
function parseProofUrls(inputs) {
  const urls = [];
  for (const input of inputs || []) {
    if (!input) continue;
    for (const token of String(input).split(/\s+/)) {
      const cleaned = token.replace(/[,;.]+$/, "");
      if (!cleaned) continue;
      if (!/^https?:\/\/\S+$/i.test(cleaned)) return null;
      urls.push(cleaned);
    }
  }
  return urls;
}

// --------------------------------------------------------------- tx helpers

/** The member's open reign joined with seat info, locked FOR UPDATE. */
async function heldReignTx(client, userId) {
  const result = await client.query(
    `SELECT r.*, s.display_name, s.modifier_role_name, s.emoji, s.role_id
       FROM reigns r
       JOIN seats s ON s.seat_id = r.seat_id
      WHERE r.holder_id = $1 AND r.ended_at IS NULL AND s.is_active = TRUE
      ORDER BY s.sort_order
      LIMIT 1
      FOR UPDATE OF r`,
    [String(userId)]
  );
  return result.rows[0] || null;
}

/** Open reign of a seat, locked FOR UPDATE. */
async function openReignTx(client, seatId) {
  const result = await client.query(
    `SELECT * FROM reigns WHERE seat_id = $1 AND ended_at IS NULL FOR UPDATE`,
    [String(seatId)]
  );
  return result.rows[0] || null;
}

async function beginReignTx(client, { seatId, holderId, at }) {
  const result = await client.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [String(seatId), String(holderId), at]
  );
  return result.rows[0];
}

/**
 * Apply lifetime stat deltas inside a transaction.
 * delta: { win, loss, kill, subdued, matches, resetStreak, throneAccepts }
 * A win bumps the streak (and best) first; resetStreak (accept-throne)
 * then zeroes it, so best still records the peak.
 */
async function updateStatsTx(client, userId, delta) {
  const id = String(userId);
  let selected = await client.query(
    `SELECT * FROM stats WHERE user_id = $1 FOR UPDATE`,
    [id]
  );
  if (selected.rows.length === 0) {
    await client.query(
      `INSERT INTO stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [id]
    );
    selected = await client.query(
      `SELECT * FROM stats WHERE user_id = $1 FOR UPDATE`,
      [id]
    );
  }
  const stats = selected.rows[0];

  let wins = Number(stats.wins);
  let losses = Number(stats.losses);
  let kills = Number(stats.kills);
  let subdued = Number(stats.subdued);
  let total = Number(stats.total_matches);
  let streak = Number(stats.win_streak);
  let best = Number(stats.best_win_streak);

  if (delta.win) {
    wins += 1;
    streak += 1;
    if (streak > best) best = streak;
  }
  if (delta.loss) {
    losses += 1;
    streak = 0;
  }
  if (delta.kill) kills += 1;
  if (delta.subdued) subdued += 1;
  if (delta.matches) total += 1;
  if (delta.resetStreak) streak = 0;

  await client.query(
    `UPDATE stats
        SET wins = $2, losses = $3, kills = $4, subdued = $5,
            total_matches = $6, win_streak = $7, best_win_streak = $8,
            updated_at = now()
      WHERE user_id = $1`,
    [id, wins, losses, kills, subdued, total, streak, best]
  );

  if (delta.throneAccepts) {
    await client.query(
      `UPDATE members
          SET throne_accepts = throne_accepts + 1, updated_at = now()
        WHERE user_id = $1`,
      [id]
    );
  }
}

/**
 * Record a throne defense with the "one defense per opponent per 3 days"
 * reward gate (the gate only; EXP rewards are Stage 6).
 * @returns {Promise<boolean>} whether the defense counts toward the reward streak
 */
async function recordDefenseTx(client, { matchId, defenderId, opponentId, reignId, at }) {
  const gate = await client.query(
    `SELECT 1 FROM defense_events
      WHERE defender_id = $1 AND opponent_id = $2
        AND counted_for_reward
        AND occurred_at > $3::timestamptz - make_interval(days => $4)
      LIMIT 1`,
    [
      String(defenderId),
      String(opponentId),
      at,
      Number(RULES.DEFENSE_REWARD_SAME_OPPONENT_DAYS),
    ]
  );
  const counted = gate.rows.length === 0;
  await client.query(
    `INSERT INTO defense_events
       (match_id, defender_id, opponent_id, reign_id, occurred_at, counted_for_reward)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      String(matchId),
      String(defenderId),
      String(opponentId),
      reignId == null ? null : String(reignId),
      at,
      counted,
    ]
  );
  return counted;
}

// ------------------------------------------------------------ announcements

async function announceMatchStart({ match, seat, guild, config }) {
  await postTo("challenge", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.primary })
        .setTitle("▶️ Match started")
        .setDescription(
          `<@${match.attacker_id}> vs <@${match.defender_id}> — ${seatLabel(seat)}\n` +
            `**Game:** ${match.game_agreed}\n` +
            `Staff: record the result with \`/match-result\` once the match finishes ` +
            `(screenshot proof required).`
        )
        .setFooter({ text: `Match #${match.match_id} • Star Stream` }),
    ],
  });
}

/** Public result announcement in the challenge channel. */
function resultEmbed({ match, seat, choice, seatChoice, refusal, proofUrls }) {
  const embed = baseEmbed({ color: COLORS.primary });
  const attacker = `<@${match.attacker_id}>`;
  const defender = `<@${match.defender_id}>`;

  switch (match.outcome) {
    case "attacker_victory":
      if (choice === "kill") {
        embed.setTitle("⚔️ Kill — throne vacated").setColor(COLORS.danger);
        embed.setDescription(
          `${attacker} defeated ${defender} — ${seatLabel(seat)} is now vacant ` +
            `(+1 Kill). A Role Collection will open for the seat.`
        );
      } else if (seatChoice === "current") {
        embed.setTitle("👑 Throne offered — kept current seat").setColor(COLORS.gold);
        embed.setDescription(
          `${attacker} defeated ${defender} and kept their own throne; ` +
            `${seatLabel(seat)} is now vacant and opens to a Role Collection.`
        );
      } else {
        embed.setTitle("👑 Throne taken").setColor(COLORS.gold);
        embed.setDescription(
          `${attacker} defeated ${defender} and became the new holder of ` +
            `${seatLabel(seat)}.`
        );
      }
      break;
    case "defender_victory":
      if (choice === "swap" && seatChoice === "won") {
        embed.setTitle("🔁 Throne seized (swap)").setColor(COLORS.gold);
        embed.setDescription(
          `${defender} defeated ${attacker}, took their throne and released ` +
            `${seatLabel(seat)} to a Role Collection.`
        );
      } else if (choice === "swap") {
        embed.setTitle("🔁 Swap — won seat released").setColor(COLORS.gold);
        embed.setDescription(
          `${defender} defeated ${attacker}, kept ${seatLabel(seat)} and released ` +
            `the defeated throne to a Role Collection.`
        );
      } else {
        embed.setTitle("🛡️ Constellation defends").setColor(COLORS.success);
        embed.setDescription(
          `${defender} defended ${seatLabel(seat)} against ${attacker} (+1 Subdued).`
        );
      }
      break;
    case "abandon_attacker":
      embed.setTitle("🏳️ Challenger forfeited").setColor(COLORS.danger);
      embed.setDescription(
        `${attacker} did not show up and forfeits the match.\n` +
          `${defender} wins by default: full win (+1 Subdued, defense recorded).`
      );
      break;
    case "abandon_defender":
      embed
        .setTitle(refusal?.stripped ? "❌ Fourth no-show — role stripped" : "⏳ Holder no-show — counted as refusal")
        .setColor(refusal?.stripped ? COLORS.danger : COLORS.primary);
      embed.setDescription(
        `${defender} did not show up for the match against ${attacker}.\n` +
          `Counted as a refusal: **${refusal?.newCount ?? "?"}/${RULES.REFUSAL_LIMIT}**` +
          (refusal?.stripped
            ? ` — the modifier role was stripped and ${seatLabel(seat)} is vacant.`
            : `. The challenger's daily chance is used.`)
      );
      break;
    default:
      embed.setTitle("Match result").setDescription(`${attacker} vs ${defender}`);
  }

  embed.addFields(
    { name: "Game", value: match.game_agreed || DEFAULT_GAME_LABEL, inline: true },
    {
      name: "Proof",
      value: proofUrls && proofUrls.length ? proofUrls.join("\n") : "-",
      inline: false,
    }
  );
  embed.setFooter({ text: `Match #${match.match_id} • Star Stream` });
  return embed;
}

/** Public result announcement for a Role Collection duel (#alerts). */
function collectionResultEmbed(result) {
  return baseEmbed({ color: COLORS.gold })
    .setTitle("🌟 Role Collection decided")
    .setDescription(
      `<@${result.winnerId}> won the staff-supervised duel against ` +
        `<@${result.loserId}> and becomes the new holder of ${seatLabel(result.seat)}.`
    )
    .addFields({
      name: "Proof",
      value: result.proofUrls && result.proofUrls.length
        ? result.proofUrls.join("\n")
        : "-",
      inline: false,
    })
    .setFooter({ text: `Match #${result.match.match_id} • Star Stream` });
}

async function announceThroneChange({ change, guild, config }) {
  const seat = change.seat;
  if (change.kind === "transfer") {
    await postTo("alerts", config, guild, {
      embeds: [
        baseEmbed({ color: COLORS.gold })
          .setTitle("👑 Throne changed hands")
          .setDescription(
            `${seatLabel(seat)} passes from <@${change.from}> to <@${change.to}>.`
          )
          .setFooter({ text: `Match #${change.matchId} • Star Stream` }),
      ],
    });
    return;
  }
  await postTo("alerts", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.danger })
        .setTitle("🌟 Throne vacant")
        .setDescription(
          `${seatLabel(seat)} (held by <@${change.from}>) is now vacant.\n` +
            `The official role has been removed from the holder.\n` +
            `A **Role Collection** for this seat will be announced in this channel.`
        )
        .setFooter({ text: `Match #${change.matchId} • Star Stream` }),
    ],
  });
}

// ------------------------------------------------------------- start match

/**
 * Register and start a match inside the 15-minute game-agreement window.
 * @param {{matchId:number|string, game?:string, actorId:string, guild:object, config:object, at?:Date}} args
 * @returns {Promise<{ok:true, match:object} | {ok:false, code:string}>}
 */
async function startMatch({ matchId, game, actorId, guild, config, at = new Date() }) {
  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM matches WHERE match_id = $1 FOR UPDATE`,
        [String(matchId)]
      );
      const match = rows.rows[0];
      if (!match) return { ok: false, code: "NOT_FOUND" };
      if (match.status !== "scheduled") return { ok: false, code: "NOT_SCHEDULED" };
      if (
        match.game_agreed_deadline_at &&
        new Date(match.game_agreed_deadline_at).getTime() <= at.getTime()
      ) {
        return { ok: false, code: "WINDOW_EXPIRED" };
      }

      const agreed = String(game || "").trim() || DEFAULT_GAME_LABEL;
      const updated = await client.query(
        `UPDATE matches
            SET status = 'in_progress', game_agreed = $2, started_at = $3,
                updated_at = now()
          WHERE match_id = $1 AND status = 'scheduled'
          RETURNING *`,
        [String(matchId), agreed, at]
      );
      if (updated.rows.length === 0) return { ok: false, code: "NOT_SCHEDULED" };
      return { ok: true, match: updated.rows[0] };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  const seat = await getSeat(outcome.match.seat_id);
  await announceMatchStart({ match: outcome.match, seat, guild, config });
  await recordStaffAction({
    actorId,
    action: "match.start",
    targetType: "match",
    targetId: String(matchId),
    previousValue: { status: "scheduled" },
    newValue: { status: "in_progress", game: outcome.match.game_agreed },
    reason: null,
  });
  return outcome;
}

// ----------------------------------------------------------- record result

/**
 * Record a Role Collection duel result - runs INSIDE recordResult's
 * transaction (match row already locked, status verified as in_progress).
 *
 * Approved decisions:
 *  - only attacker_victory / defender_victory exist; no-shows are a staff
 *    case-by-case decision (/collection-manage), never auto-recorded,
 *  - no winner choices (the seat is vacant - the winner simply takes it),
 *  - proof is still required (staff-supervised match rules),
 *  - stats count as a normal match (wins/losses/streak) and the winner
 *    gains +1 throne_accepts (any throne gain counts),
 *  - no defense event, no refusal counter, no bounty (vacant seat).
 */
async function recordCollectionDuelTx(
  client,
  { match, at, actorId, outcomeCode, winnerChoice, seatChoice, proofUrls, notes }
) {
  if (outcomeCode === "abandon_attacker" || outcomeCode === "abandon_defender") {
    return { ok: false, code: "COLLECTION_NO_SHOW" };
  }
  if (outcomeCode !== "attacker_victory" && outcomeCode !== "defender_victory") {
    return { ok: false, code: "INVALID_OUTCOME" };
  }
  if (winnerChoice && winnerChoice !== "none") {
    return { ok: false, code: "INVALID_CHOICE" };
  }

  const seat = (
    await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [match.seat_id])
  ).rows[0];
  if (!seat || !seat.is_active) return { ok: false, code: "SEAT_NOT_FOUND" };

  // The seat must still be vacant: a staff grant may have filled it.
  const held = await client.query(
    `SELECT reign_id FROM reigns WHERE seat_id = $1 AND ended_at IS NULL`,
    [String(match.seat_id)]
  );
  if (held.rows.length > 0) return { ok: false, code: "SEAT_NOT_VACANT" };

  const c = await client.query(
    `SELECT * FROM role_collections
      WHERE seat_id = $1 AND status = 'open'
      FOR UPDATE`,
    [String(match.seat_id)]
  );
  const collection = c.rows[0];
  if (!collection) return { ok: false, code: "COLLECTION_NOT_OPEN" };

  const winnerId =
    outcomeCode === "attacker_victory"
      ? String(match.attacker_id)
      : String(match.defender_id);
  const loserId =
    outcomeCode === "attacker_victory"
      ? String(match.defender_id)
      : String(match.attacker_id);

  const updated = await client.query(
    `UPDATE matches
        SET status = 'verified',
            winner_id = $2,
            outcome = $3,
            winner_choice = 'none',
            result_submitted_at = $4,
            result_submitted_by = $5,
            verified_at = $4,
            verified_by = $5,
            notes = CASE WHEN $6::text IS NULL THEN notes
                         ELSE COALESCE(CONCAT(notes, ' | '), '') || $6 END,
            updated_at = now()
      WHERE match_id = $1 AND status = 'in_progress'
      RETURNING *`,
    [
      String(match.match_id),
      winnerId,
      outcomeCode,
      at,
      String(actorId),
      notes || null,
    ]
  );
  if (updated.rows.length === 0) return { ok: false, code: "NOT_IN_PROGRESS" };

  for (const url of proofUrls) {
    await client.query(
      `INSERT INTO match_evidence (match_id, submitted_by, url)
       VALUES ($1, $2, $3)`,
      [String(match.match_id), String(actorId), url]
    );
  }

  // Close the collection as a two-entrant duel.
  await client.query(
    `UPDATE role_collections
        SET status = 'closed',
            winner_id = $2,
            resolution = 'two_entrants',
            closed_at = $3,
            notes = COALESCE(CONCAT(notes, ' | '), '') || $4
      WHERE collection_id = $1 AND status = 'open'`,
    [
      String(collection.collection_id),
      winnerId,
      at,
      `duel recorded via match #${match.match_id}`,
    ]
  );

  // The winner takes the vacant seat.
  await client.query(
    `INSERT INTO reigns (seat_id, holder_id, started_at)
     VALUES ($1, $2, $3)`,
    [String(match.seat_id), winnerId, at]
  );

  await updateStatsTx(client, winnerId, { win: true, matches: true });
  await updateStatsTx(client, loserId, { loss: true, matches: true });
  await client.query(
    `UPDATE members
        SET throne_accepts = throne_accepts + 1, updated_at = now()
      WHERE user_id = $1`,
    [winnerId]
  );

  return {
    ok: true,
    collectionResult: true,
    match: updated.rows[0],
    seat,
    choice: "none",
    seatChoice: null,
    winnerId,
    loserId,
    refusal: null,
    defenseCounted: false,
    roleOps: [{ type: "add", seat, userId: winnerId }],
    throneChanges: [],
    proofUrls,
    challengeId: null,
  };
}

/**
 * Record a match result (proof required) and apply every effect immediately:
 * stats, defense events, refusal counting, throne transfer/vacancy, roles.
 * @param {{matchId:number|string, outcome:string, winnerChoice?:string,
 *          seatChoice?:string, proof:Array<string>, actorId:string,
 *          guild:object, config:object, notes?:string, at?:Date}} args
 * @returns {Promise<{ok:true, match:object, ...} | {ok:false, code:string}>}
 */
async function recordResult({
  matchId,
  outcome: outcomeInput,
  winnerChoice = null,
  seatChoice = null,
  proof = [],
  actorId,
  guild,
  config,
  notes = null,
  at = new Date(),
}) {
  const outcomeCode = String(outcomeInput || "");
  if (!SUPPORTED_OUTCOMES.includes(outcomeCode)) {
    return { ok: false, code: "INVALID_OUTCOME" };
  }
  const proofUrls = parseProofUrls(proof);
  if (proofUrls === null) return { ok: false, code: "INVALID_PROOF" };
  if (proofUrls.length === 0) return { ok: false, code: "PROOF_REQUIRED" };

  // Participants must exist before the transaction (idempotent upserts).
  const pre = await query(
    `SELECT attacker_id, defender_id FROM matches WHERE match_id = $1`,
    [String(matchId)]
  );
  if (pre.rows.length === 0) return { ok: false, code: "NOT_FOUND" };
  await ensureMember(pre.rows[0].attacker_id);
  await ensureMember(pre.rows[0].defender_id);

  let result;
  try {
    result = await withTransaction(async (client) => {
      // ---- lock & validate the match --------------------------------
      const mRows = await client.query(
        `SELECT * FROM matches WHERE match_id = $1 FOR UPDATE`,
        [String(matchId)]
      );
      const match = mRows.rows[0];
      if (!match) return { ok: false, code: "NOT_FOUND" };
      if (match.status !== "in_progress") return { ok: false, code: "NOT_IN_PROGRESS" };
      if (match.match_type === "role_collection") {
        return await recordCollectionDuelTx(client, {
          match,
          at,
          actorId,
          outcomeCode,
          winnerChoice,
          seatChoice,
          proofUrls,
          notes,
        });
      }
      if (match.match_type !== "challenge") return { ok: false, code: "UNSUPPORTED_TYPE" };

      const seat = (
        await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [match.seat_id])
      ).rows[0];

      // ---- lock the challenge (expected for challenge matches) ------
      let challenge = null;
      if (match.challenge_id) {
        const c = await client.query(
          `SELECT * FROM challenges WHERE challenge_id = $1 FOR UPDATE`,
          [String(match.challenge_id)]
        );
        challenge = c.rows[0] || null;
      }

      const attackerId = String(match.attacker_id);
      const defenderId = String(match.defender_id);

      // ---- lock the contested seat's reign ---------------------------
      const defenderReign = await openReignTx(client, match.seat_id);
      if (!defenderReign || String(defenderReign.holder_id) !== defenderId) {
        return { ok: false, code: "HOLDER_GONE" };
      }

      // ---- winner / loser --------------------------------------------
      let winnerId = null;
      let loserId = null;
      if (outcomeCode === "attacker_victory") {
        winnerId = attackerId;
        loserId = defenderId;
      } else if (outcomeCode === "defender_victory" || outcomeCode === "abandon_attacker") {
        winnerId = defenderId;
        loserId = attackerId;
      }

      // ---- winner choice validation ----------------------------------
      let choice = winnerChoice;
      if (outcomeCode.startsWith("abandon")) {
        choice = "none";
      } else if (!CHOICES_BY_OUTCOME[outcomeCode].includes(choice)) {
        return { ok: false, code: "INVALID_CHOICE" };
      }

      // ---- seat choice validation (winner already holds a throne) -----
      let attackerHeld = null;
      let effectiveSeatChoice = null;
      if (choice === "accept_throne" || choice === "swap") {
        attackerHeld = await heldReignTx(client, attackerId);
      }
      if (choice === "swap" && !attackerHeld) {
        return { ok: false, code: "ILLEGAL_CHOICE" };
      }
      if (choice === "accept_throne") {
        if (attackerHeld && attackerHeld.seat_id !== match.seat_id) {
          if (seatChoice !== "won" && seatChoice !== "current") {
            return { ok: false, code: "SEAT_CHOICE_REQUIRED" };
          }
          effectiveSeatChoice = seatChoice;
        } else {
          effectiveSeatChoice = "won"; // unranked challenger: simply take it
        }
      } else if (choice === "swap") {
        if (seatChoice !== "won" && seatChoice !== "current") {
          return { ok: false, code: "SEAT_CHOICE_REQUIRED" };
        }
        effectiveSeatChoice = seatChoice;
      }

      // ---- write the match row (CAS: exactly once) -------------------
      const status = outcomeCode === "abandon_defender" ? "abandoned" : "verified";
      const verifiedAt = status === "verified" ? at : null;
      const abandonedBy =
        outcomeCode === "abandon_attacker"
          ? attackerId
          : outcomeCode === "abandon_defender"
            ? defenderId
            : null;

      const noteParts = [];
      if (notes) noteParts.push(String(notes));
      if (effectiveSeatChoice) {
        noteParts.push(`throne choice: ${effectiveSeatChoice}`);
      }
      const noteText = noteParts.length ? noteParts.join(" | ") : null;

      const updated = await client.query(
        `UPDATE matches
            SET status = $2,
                winner_id = $3,
                outcome = $4,
                winner_choice = $5,
                result_submitted_at = $6,
                result_submitted_by = $7,
                verified_at = $8,
                verified_by = $9,
                abandoned_by = $10,
                notes = CASE WHEN $11::text IS NULL THEN notes
                             ELSE COALESCE(CONCAT(notes, ' | '), '') || $11 END,
                updated_at = now()
          WHERE match_id = $1 AND status = 'in_progress'
          RETURNING *`,
        [
          String(matchId),
          status,
          winnerId,
          outcomeCode,
          choice,
          at,
          String(actorId),
          verifiedAt,
          verifiedAt == null ? null : String(actorId),
          abandonedBy,
          noteText,
        ]
      );
      if (updated.rows.length === 0) return { ok: false, code: "NOT_IN_PROGRESS" };
      const savedMatch = updated.rows[0];

      // ---- evidence (staff attach all proof) -------------------------
      for (const url of proofUrls) {
        await client.query(
          `INSERT INTO match_evidence (match_id, submitted_by, url)
           VALUES ($1, $2, $3)`,
          [String(matchId), String(actorId), url]
        );
      }

      // Post-commit Discord role ops and public throne announcements are
      // collected here (the fourth-refusal strip below adds to them too).
      const roleOps = [];
      const throneChanges = [];

      // ---- challenge resolution --------------------------------------
      let refusal = null;
      if (challenge) {
        if (outcomeCode === "abandon_defender") {
          const isFourth =
            Number(challenge.refusal_count_at_creation ?? 0) >= RULES.REFUSAL_LIMIT;
          const newCount = Number(defenderReign.refusal_count) + 1;
          await client.query(
            `UPDATE reigns SET refusal_count = $2 WHERE reign_id = $1`,
            [defenderReign.reign_id, newCount]
          );
          if (isFourth) {
            await client.query(
              `UPDATE challenges
                  SET status = 'stripped', strip_applied = TRUE,
                      refuser_id = $2, responded_at = $3, resolved_at = $3
                WHERE challenge_id = $1`,
              [String(challenge.challenge_id), defenderId, at]
            );
            await stripThroneTx(client, {
              reign: defenderReign,
              seatId: match.seat_id,
              at,
              reason: "refusal_limit",
              matchId: String(matchId),
            });
            roleOps.push({ type: "remove", seat, userId: defenderId });
            refusal = { newCount, stripped: true };
          } else {
            await client.query(
              `UPDATE challenges
                  SET status = 'refused', refuser_id = $2,
                      responded_at = $3, resolved_at = $3
                WHERE challenge_id = $1`,
              [String(challenge.challenge_id), defenderId, at]
            );
            refusal = { newCount, stripped: false };
          }
        } else {
          await client.query(
            `UPDATE challenges SET status = 'completed', resolved_at = $2
              WHERE challenge_id = $1`,
            [String(challenge.challenge_id), at]
          );
        }
      }

      // ---- throne effects --------------------------------------------

      if (outcomeCode === "attacker_victory" && choice === "kill") {
        await stripThroneTx(client, {
          reign: defenderReign,
          seatId: match.seat_id,
          at,
          reason: "match_kill",
          matchId: String(matchId),
        });
        roleOps.push({ type: "remove", seat, userId: defenderId });
        throneChanges.push({ kind: "vacancy", seat, from: defenderId });
      } else if (outcomeCode === "attacker_victory" && choice === "accept_throne") {
        if (effectiveSeatChoice === "won") {
          await stripThroneTx(client, {
            reign: defenderReign,
            seatId: match.seat_id,
            at,
            reason: "match_defeat",
            matchId: String(matchId),
          });
          await beginReignTx(client, {
            seatId: match.seat_id,
            holderId: attackerId,
            at,
          });
          roleOps.push({ type: "remove", seat, userId: defenderId });
          roleOps.push({ type: "add", seat, userId: attackerId });
          throneChanges.push({
            kind: "transfer",
            seat,
            from: defenderId,
            to: attackerId,
          });
          if (attackerHeld && attackerHeld.seat_id !== match.seat_id) {
            // Winner keeps the new seat: their old throne is released.
            const oldSeat = (
              await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [
                attackerHeld.seat_id,
              ])
            ).rows[0];
            await stripThroneTx(client, {
              reign: attackerHeld,
              seatId: attackerHeld.seat_id,
              at,
              reason: "seat_released",
              matchId: String(matchId),
            });
            roleOps.push({ type: "remove", seat: oldSeat, userId: attackerId });
            throneChanges.push({
              kind: "vacancy",
              seat: oldSeat,
              from: attackerId,
            });
          }
        } else {
          // Winner keeps their old seat: the won throne is released.
          await stripThroneTx(client, {
            reign: defenderReign,
            seatId: match.seat_id,
            at,
            reason: "match_defeat",
            matchId: String(matchId),
          });
          roleOps.push({ type: "remove", seat, userId: defenderId });
          throneChanges.push({ kind: "vacancy", seat, from: defenderId });
        }
      } else if (outcomeCode === "defender_victory" && choice === "swap") {
        const attackerSeat = (
          await client.query(`SELECT * FROM seats WHERE seat_id = $1`, [
            attackerHeld.seat_id,
          ])
        ).rows[0];
        if (effectiveSeatChoice === "won") {
          // Defender takes the Challenger's throne and releases their own.
          await stripThroneTx(client, {
            reign: attackerHeld,
            seatId: attackerHeld.seat_id,
            at,
            reason: "match_defeat",
            matchId: String(matchId),
          });
          await beginReignTx(client, {
            seatId: attackerHeld.seat_id,
            holderId: defenderId,
            at,
          });
          await stripThroneTx(client, {
            reign: defenderReign,
            seatId: match.seat_id,
            at,
            reason: "seat_released",
            matchId: String(matchId),
          });
          roleOps.push({ type: "remove", seat: attackerSeat, userId: attackerId });
          roleOps.push({ type: "remove", seat, userId: defenderId });
          roleOps.push({ type: "add", seat: attackerSeat, userId: defenderId });
          throneChanges.push({
            kind: "transfer",
            seat: attackerSeat,
            from: attackerId,
            to: defenderId,
          });
          throneChanges.push({ kind: "vacancy", seat, from: defenderId });
        } else {
          // Defender keeps their throne: the Challenger's seat is released.
          await stripThroneTx(client, {
            reign: attackerHeld,
            seatId: attackerHeld.seat_id,
            at,
            reason: "match_defeat",
            matchId: String(matchId),
          });
          roleOps.push({ type: "remove", seat: attackerSeat, userId: attackerId });
          throneChanges.push({
            kind: "vacancy",
            seat: attackerSeat,
            from: attackerId,
          });
        }
      }

      // ---- defense event (successful defenses only) -------------------
      let defenseCounted = false;
      if (outcomeCode === "defender_victory" || outcomeCode === "abandon_attacker") {
        defenseCounted = await recordDefenseTx(client, {
          matchId,
          defenderId,
          opponentId: attackerId,
          reignId: defenderReign.reign_id,
          at,
        });
      }

      // ---- lifetime stats ---------------------------------------------
      const deltas = {};
      if (outcomeCode === "attacker_victory") {
        deltas[attackerId] = {
          win: true,
          matches: true,
          kill: choice === "kill",
          throneAccepts: choice === "accept_throne" && effectiveSeatChoice === "won",
          resetStreak: choice === "accept_throne",
        };
        deltas[defenderId] = { loss: true, matches: true };
      } else if (outcomeCode === "defender_victory") {
        deltas[defenderId] = { win: true, matches: true, subdued: true };
        deltas[attackerId] = { loss: true, matches: true };
      } else if (outcomeCode === "abandon_attacker") {
        deltas[defenderId] = { win: true, matches: true, subdued: true };
        deltas[attackerId] = { loss: true, matches: true };
      }
      // abandon_defender: the match never happened - no stats (refusal only).
      for (const [userId, delta] of Object.entries(deltas)) {
        await updateStatsTx(client, userId, delta);
      }

      return {
        ok: true,
        match: savedMatch,
        seat,
        choice,
        seatChoice: effectiveSeatChoice,
        winnerId,
        loserId,
        refusal,
        defenseCounted,
        roleOps,
        throneChanges,
        proofUrls,
        challengeId: challenge ? Number(challenge.challenge_id) : null,
      };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!result.ok) return result;

  // ---- post-commit: Discord roles, announcements, achievements, audit ----
  for (const op of result.roleOps) {
    if (op.type === "remove") {
      await removeModifierRole({ guild, seat: op.seat, userId: op.userId });
    } else {
      await grantModifierRole({ guild, seat: op.seat, userId: op.userId });
    }
  }

  if (result.collectionResult) {
    // Role Collection duel: the seat was vacant, so both announcements go
    // to #alerts where the collection was posted.
    await postTo("alerts", config, guild, {
      embeds: [collectionResultEmbed(result)],
    });
    await postTo("alerts", config, guild, {
      embeds: [
        baseEmbed({ color: COLORS.gold })
          .setTitle("👑 New Constellation")
          .setDescription(
            `${seatLabel(result.seat)} has a new holder: <@${result.winnerId}>.`
          )
          .setFooter({ text: `Match #${result.match.match_id} • Star Stream` }),
      ],
    });
  } else {
    await postTo("challenge", config, guild, {
      embeds: [resultEmbed(result)],
    });

    for (const change of result.throneChanges) {
      await announceThroneChange({
        change: { ...change, matchId: result.match.match_id },
        guild,
        config,
      });
    }

    if (result.refusal?.stripped) {
      // announceStrip also opens the seat's Role Collection.
      await announceStrip({
        seat: result.seat,
        holderId: result.loserId || result.match.defender_id,
        guild,
        config,
        at,
      });
    }

    // Every vacated seat opens a Role Collection (spec section 6).
    // Strip paths already opened theirs through announceStrip above.
    for (const change of result.throneChanges) {
      if (change.kind !== "vacancy") continue;
      try {
        await openCollectionForSeat(change.seat.seat_id, {
          guild,
          config,
          at,
          reason: "match_vacancy",
        });
      } catch (err) {
        logger.warn(
          `Match: could not open a Role Collection for ${change.seat.seat_id}: ${err.message}`
        );
      }
    }
  }

  for (const userId of [result.winnerId, result.loserId].filter(Boolean)) {
    try {
      await evaluateAchievements(userId);
    } catch (err) {
      logger.warn(`Achievement evaluation failed for ${userId}: ${err.message}`);
    }
  }

  await recordStaffAction({
    actorId,
    action: "match.record",
    targetType: "match",
    targetId: String(matchId),
    previousValue: { status: "in_progress" },
    newValue: {
      status: result.match.status,
      outcome: outcomeCode,
      winner_id: result.winnerId,
      winner_choice: result.choice,
    },
    reason: notes || `recorded ${outcomeCode}`,
  });

  return result;
}

// ---------------------------------------------------------------- disputes

/**
 * Flag a recorded result for review (staff-side; members ping staff).
 * Effects of the result stay in place while disputed (approved decision).
 */
async function openDispute({ matchId, reporterId, reason, actorId, guild, config, at = new Date() }) {
  const text = String(reason || "").trim();
  if (!text) return { ok: false, code: "DISPUTE_REASON_REQUIRED" };

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM matches WHERE match_id = $1 FOR UPDATE`,
        [String(matchId)]
      );
      const match = rows.rows[0];
      if (!match) return { ok: false, code: "NOT_FOUND" };

      const open = await client.query(
        `SELECT dispute_id FROM match_disputes
          WHERE match_id = $1 AND status = 'open' LIMIT 1`,
        [String(matchId)]
      );
      if (open.rows.length > 0) return { ok: false, code: "ALREADY_DISPUTED" };
      if (match.status !== "verified") return { ok: false, code: "NOT_VERIFIED" };

      const dispute = await client.query(
        `INSERT INTO match_disputes (match_id, reported_by, reason)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [String(matchId), String(reporterId || actorId), text]
      );
      const updated = await client.query(
        `UPDATE matches SET status = 'disputed', updated_at = now()
          WHERE match_id = $1 AND status = 'verified'
          RETURNING *`,
        [String(matchId)]
      );
      if (updated.rows.length === 0) return { ok: false, code: "NOT_VERIFIED" };
      return { ok: true, match: updated.rows[0], dispute: dispute.rows[0] };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  await postTo("challenge", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.danger })
        .setTitle("⚠️ Result disputed")
        .setDescription(
          `Match #${outcome.match.match_id} was flagged for review ` +
            `(reported by <@${outcome.dispute.reported_by}>).\n` +
            `**Reason:** ${outcome.dispute.reason}\n` +
            `Staff will resolve it with \`/resolve-dispute\`.`
        )
        .setFooter({ text: `Match #${outcome.match.match_id} • Star Stream` }),
    ],
  });
  await recordStaffAction({
    actorId,
    action: "match.dispute.open",
    targetType: "match",
    targetId: String(matchId),
    previousValue: { status: "verified" },
    newValue: { status: "disputed", dispute_id: Number(outcome.dispute.dispute_id) },
    reason: text,
  });
  return outcome;
}

/** Close the open dispute; the match returns to verified. */
async function resolveDispute({ matchId, resolution, actorId, guild, config, at = new Date() }) {
  const text = String(resolution || "").trim() || "Resolved by staff.";

  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      const rows = await client.query(
        `SELECT * FROM matches WHERE match_id = $1 FOR UPDATE`,
        [String(matchId)]
      );
      const match = rows.rows[0];
      if (!match) return { ok: false, code: "NOT_FOUND" };
      if (match.status !== "disputed") return { ok: false, code: "NOT_DISPUTED" };

      const open = await client.query(
        `SELECT * FROM match_disputes
          WHERE match_id = $1 AND status = 'open'
          ORDER BY dispute_id DESC
          LIMIT 1
          FOR UPDATE`,
        [String(matchId)]
      );
      const dispute = open.rows[0];
      if (!dispute) return { ok: false, code: "NOT_DISPUTED" };

      await client.query(
        `UPDATE match_disputes
            SET status = 'resolved', resolved_by = $2, resolved_at = $3,
                resolution = $4
          WHERE dispute_id = $1`,
        [String(dispute.dispute_id), String(actorId), at, text]
      );
      const updated = await client.query(
        `UPDATE matches SET status = 'verified', updated_at = now()
          WHERE match_id = $1 AND status = 'disputed'
          RETURNING *`,
        [String(matchId)]
      );
      if (updated.rows.length === 0) return { ok: false, code: "NOT_DISPUTED" };
      return { ok: true, match: updated.rows[0], dispute };
    });
  } catch (err) {
    if (err.code === "23505") return { ok: false, code: "DB_CONFLICT" };
    throw err;
  }
  if (!outcome.ok) return outcome;

  await postTo("challenge", config, guild, {
    embeds: [
      baseEmbed({ color: COLORS.success })
        .setTitle("✅ Dispute resolved")
        .setDescription(
          `The dispute on match #${outcome.match.match_id} was resolved.\n` +
            `**Resolution:** ${text}`
        )
        .setFooter({ text: `Match #${outcome.match.match_id} • Star Stream` }),
    ],
  });
  await recordStaffAction({
    actorId,
    action: "match.dispute.resolve",
    targetType: "match",
    targetId: String(matchId),
    previousValue: { status: "disputed" },
    newValue: { status: "verified", dispute_id: Number(outcome.dispute.dispute_id) },
    reason: text,
  });
  return outcome;
}

// ------------------------------------------------------------------ timers

/**
 * Cancel every match whose 15-minute game-agreement window has passed
 * while still `scheduled`, refunding the challenger's daily chance
 * (challenge -> cancelled frees the once-per-Arena-Day unique index).
 * Idempotent: row locks + the status filter process each match exactly once.
 */
async function processExpiredMatches({ guild, config, at = new Date() }) {
  const processed = [];

  await withTransaction(async (client) => {
    const rows = await client.query(
      `SELECT * FROM matches
        WHERE status = 'scheduled'
          AND game_agreed_deadline_at IS NOT NULL
          AND game_agreed_deadline_at <= $1
        ORDER BY game_agreed_deadline_at
        FOR UPDATE SKIP LOCKED`,
      [at]
    );

    for (const match of rows.rows) {
      const updated = await client.query(
        `UPDATE matches SET status = 'cancelled', updated_at = now()
          WHERE match_id = $1 AND status = 'scheduled'
          RETURNING match_id`,
        [String(match.match_id)]
      );
      if (updated.rows.length === 0) continue;

      let refunded = false;
      if (match.challenge_id) {
        const c = await client.query(
          `SELECT * FROM challenges WHERE challenge_id = $1 FOR UPDATE`,
          [String(match.challenge_id)]
        );
        const challenge = c.rows[0];
        if (challenge && ["pending", "accepted"].includes(challenge.status)) {
          await client.query(
            `UPDATE challenges
                SET status = 'cancelled', resolved_at = $2,
                    notes = COALESCE(CONCAT(notes, ' | '), '') || $3
              WHERE challenge_id = $1`,
            [
              String(match.challenge_id),
              at,
              "auto-cancelled: 15-minute game-agreement window expired (daily chance refunded)",
            ]
          );
          refunded = true;
        }
      }
      processed.push({ match, refunded });
    }
  });

  // Announcements run after commit.
  for (const item of processed) {
    const seat = await getSeat(item.match.seat_id);
    await postTo("challenge", config, guild, {
      embeds: [
        baseEmbed({ color: COLORS.primary })
          .setTitle("⏱️ Match cancelled — no game agreed")
          .setDescription(
            `<@${item.match.attacker_id}> vs <@${item.match.defender_id}> — ${seatLabel(seat)}\n` +
              `The 15-minute game-agreement window expired before the match started.\n` +
              (item.refunded
                ? `<@${item.match.attacker_id}>'s daily challenge chance was refunded - ` +
                  `they may challenge that seat again today.`
                : `The linked challenge is already resolved.`)
          )
          .setFooter({ text: `Match #${item.match.match_id} • Star Stream` }),
      ],
    });
  }

  return processed;
}

// ---------------------------------------------------------------- queries

/** One match with its seat, evidence rows and disputes (for /match-status). */
async function getMatchDetails(matchId) {
  const rows = await query(
    `SELECT m.*, s.display_name AS seat_name, s.emoji AS seat_emoji,
            s.modifier_role_name
       FROM matches m
       JOIN seats s ON s.seat_id = m.seat_id
      WHERE m.match_id = $1`,
    [String(matchId)]
  );
  if (rows.rows.length === 0) return null;
  const evidence = await query(
    `SELECT * FROM match_evidence WHERE match_id = $1 ORDER BY evidence_id`,
    [String(matchId)]
  );
  const disputes = await query(
    `SELECT * FROM match_disputes WHERE match_id = $1 ORDER BY dispute_id`,
    [String(matchId)]
  );
  return {
    match: rows.rows[0],
    evidence: evidence.rows,
    disputes: disputes.rows,
  };
}

/** Recent matches, open ones first (for /match-review). */
async function listMatches({ limit = 10 } = {}) {
  const rows = await query(
    `SELECT m.match_id, m.status, m.outcome, m.winner_choice, m.winner_id,
            m.attacker_id, m.defender_id, m.created_at, m.game_agreed,
            m.seat_id, s.display_name AS seat_name, s.emoji AS seat_emoji
       FROM matches m
       JOIN seats s ON s.seat_id = m.seat_id
      ORDER BY (m.status IN ('scheduled', 'in_progress', 'disputed')) DESC,
               m.created_at DESC, m.match_id DESC
      LIMIT $1`,
    [Number(limit)]
  );
  return rows.rows;
}

module.exports = {
  MESSAGES,
  STATUS_LABELS,
  DEFAULT_GAME_LABEL,
  errorMessage,
  outcomeLabel,
  parseProofUrls,
  startMatch,
  recordResult,
  openDispute,
  resolveDispute,
  processExpiredMatches,
  getMatchDetails,
  listMatches,
};
