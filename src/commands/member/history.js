"use strict";

/**
 * /history [member] - permanent, paginated battle history.
 * Survives everything: history is never deleted (spec sections 4 & 14).
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS, formatExp } = require("../../utils/embeds");
const { resolveTarget, displayNameOf } = require("../../utils/members");
const { paginate } = require("../../utils/pagination");
const { getMatchHistory } = require("../../db/queries/matches");

const PER_PAGE = 5;

const STATUS_LABELS = {
  scheduled: "⏳ Scheduled",
  in_progress: "▶️ In progress",
  evidence_pending: "📎 Evidence pending",
  awaiting_verification: "🔍 Awaiting verification",
  verified: "✅ Verified",
  disputed: "⚠️ Disputed",
  cancelled: "🚫 Cancelled",
  abandoned: "🏳️ Abandoned",
};

function outcomeLabel(row) {
  switch (row.outcome) {
    case "attacker_victory":
      if (row.winner_choice === "accept_throne") return "Throne taken (accepted)";
      if (row.winner_choice === "kill") return "Kill — throne vacated";
      if (row.winner_choice === "swap") return "Throne swapped";
      if (row.winner_choice === "subdue") return "Subdued";
      return "Attacker victory";
    case "defender_victory":
      return "Throne defended";
    case "abandon_attacker":
      return "Attacker abandoned — automatic loss";
    case "abandon_defender":
      return "Defender abandoned";
    case "role_collection":
      return "Role Collection match";
    default:
      return "Match";
  }
}

function statEffect(row, viewerId) {
  const won = row.winner_id === viewerId;
  if (won) {
    if (row.winner_choice === "kill") return "+1 Kill";
    if (row.winner_choice === "subdue") return "+1 Subdued";
    if (row.winner_choice === "accept_throne") return "New throne claimed";
    if (row.winner_choice === "swap") return "Throne gained";
    if (row.outcome === "defender_victory") return "+1 Subdued (defense)";
    return "";
  }
  if (row.outcome === "attacker_victory" && row.winner_choice === "accept_throne") return "Throne lost";
  if (row.outcome === "attacker_victory" && row.winner_choice === "swap") return "Throne lost";
  if (row.outcome === "attacker_victory" && row.winner_choice === "kill") return "Role stripped";
  if (row.outcome === "defender_victory" || row.outcome === "abandon_attacker") return "Attack failed";
  return "";
}

async function pageEmbed(rows, viewerId, client) {
  const embed = baseEmbed().setTitle("📜 Battle History");
  for (const row of rows) {
    const opponent = await displayNameOf(client, row.opponent_id);
    const won = row.winner_id === viewerId;
    const result = row.winner_id ? (won ? "**WIN**" : "**LOSS**") : "*Unresolved*";
    const date = new Date(row.verified_at || row.created_at).toISOString().slice(0, 10);
    const effect = statEffect(row, viewerId);
    const bounty =
      row.bounty_paid && Number(row.bounty_paid) > 0 && won
        ? ` • Bounty: ${formatExp(row.bounty_paid)}`
        : "";
    embed.addFields({
      name: `${result} vs ${opponent} — ${date}`,
      value: [
        `**Outcome:** ${outcomeLabel(row)}${effect ? ` (${effect})` : ""}`,
        `**Match:** #${row.match_id} • ${STATUS_LABELS[row.status] || row.status}${bounty}`,
      ].join("\n"),
      inline: false,
    });
  }
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Display a member's permanent battle history")
    .addUserOption((option) =>
      option.setName("member").setDescription("Member to inspect (defaults to you)")
    ),

  async execute(interaction, ctx) {
    const { userId, user } = await resolveTarget(
      interaction,
      interaction.options.getUser("member")
    );
    const { total, rows } = await getMatchHistory(userId, { limit: 1000, offset: 0 });

    if (total === 0) {
      await interaction.reply({
        embeds: [
          baseEmbed().setDescription(
            `📜 **${user.username}** has no battle history yet.`
          ),
        ],
      });
      return;
    }

    // Pre-build all pages (display names resolved once).
    const builtPages = [];
    const totalPages = Math.ceil(rows.length / PER_PAGE);
    for (let i = 0; i < rows.length; i += PER_PAGE) {
      const chunk = rows.slice(i, i + PER_PAGE);
      const embed = await pageEmbed(chunk, userId, ctx.client);
      embed.setFooter({
        text: `Page ${builtPages.length + 1}/${totalPages} • Star Stream`,
      });
      builtPages.push(() => embed);
    }

    await paginate(interaction, builtPages, { prefix: `history:${interaction.id}` });
  },
};
