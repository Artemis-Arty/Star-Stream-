"use strict";

/**
 * /match-status - full detail for one match: status, players, game,
 * result, proof links, disputes and staff notes (permission: match.review).
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const {
  getMatchDetails,
  errorMessage,
  STATUS_LABELS,
  outcomeLabel,
} = require("../../systems/match");
const { baseEmbed, errorEmbed, COLORS } = require("../../utils/embeds");
const { unixSeconds } = require("../../utils/time");

function statusColor(status) {
  switch (status) {
    case "verified":
      return COLORS.success;
    case "disputed":
      return COLORS.danger;
    case "in_progress":
    case "scheduled":
      return COLORS.primary;
    case "cancelled":
    case "abandoned":
      return COLORS.dim;
    default:
      return COLORS.neutral;
  }
}

function stamp(date) {
  return date ? `<t:${unixSeconds(date)}:f>` : "-";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("match-status")
    .setDescription("Show the full status of one match (staff)")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("Match ID").setRequired(true)
    ),

  permission: PERMISSIONS.MATCH_REVIEW,

  async execute(interaction) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.MATCH_REVIEW))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to review matches.")],
        ephemeral: true,
      });
      return;
    }

    const id = interaction.options.getInteger("id");
    const details = await getMatchDetails(id);
    if (!details) {
      await interaction.reply({
        embeds: [errorEmbed(errorMessage("NOT_FOUND"))],
        ephemeral: true,
      });
      return;
    }

    const { match, evidence, disputes } = details;
    const resultLine = match.outcome
      ? `${outcomeLabel(match)}${match.winner_id ? ` - winner <@${match.winner_id}>` : ""}`
      : "not recorded yet";

    const embed = baseEmbed({ color: statusColor(match.status) })
      .setTitle(`Match #${match.match_id} - ${STATUS_LABELS[match.status] || match.status}`)
      .addFields(
        {
          name: "Seat",
          value: `${match.seat_emoji || ""} ${match.seat_name}`,
          inline: true,
        },
        { name: "Challenger", value: `<@${match.attacker_id}>`, inline: true },
        { name: "Constellation", value: `<@${match.defender_id}>`, inline: true },
        {
          name: "Game",
          value: match.game_agreed || "- not started -",
          inline: false,
        },
        {
          name: "Created / Started",
          value: `${stamp(match.created_at)} / ${stamp(match.started_at)}`,
          inline: false,
        },
        { name: "Result", value: resultLine, inline: false },
        {
          name: `Proof (${evidence.length})`,
          value: evidence.length ? evidence.map((e) => e.url).join("\n") : "-",
          inline: false,
        }
      )
      .setFooter({ text: `Match #${match.match_id} • Star Stream` });

    const openDispute = disputes.find((d) => d.status === "open");
    if (disputes.length > 0) {
      embed.addFields({
        name: "Disputes",
        value: disputes
          .map(
            (d) =>
              `#${d.dispute_id} [${d.status}] reported by <@${d.reported_by}>: ${d.reason}` +
              (d.resolution ? ` → ${d.resolution}` : "")
          )
          .join("\n"),
        inline: false,
      });
    }
    if (openDispute) {
      embed.setColor(COLORS.danger);
    }
    if (match.notes) {
      embed.addFields({ name: "Notes", value: String(match.notes), inline: false });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
