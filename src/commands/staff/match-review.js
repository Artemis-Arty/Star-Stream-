"use strict";

/**
 * /match-review - recent matches with open ones first (permission: match.review).
 * Use /match-status <id> for the full detail of a single match.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const {
  listMatches,
  STATUS_LABELS,
  outcomeLabel,
} = require("../../systems/match");
const { baseEmbed, errorEmbed, infoEmbed, COLORS } = require("../../utils/embeds");

const PAGE_SIZE = 10;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("match-review")
    .setDescription("List recent matches - open ones first (staff)"),

  permission: PERMISSIONS.MATCH_REVIEW,

  async execute(interaction) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.MATCH_REVIEW))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to review matches.")],
        ephemeral: true,
      });
      return;
    }

    const rows = await listMatches({ limit: PAGE_SIZE });
    if (rows.length === 0) {
      await interaction.reply({
        embeds: [infoEmbed("No matches recorded yet.", "Match review")],
        ephemeral: true,
      });
      return;
    }

    const lines = rows.map((row) => {
      const status = STATUS_LABELS[row.status] || row.status;
      const outcome = row.outcome ? ` - ${outcomeLabel(row)}` : "";
      return (
        `\`${String(row.match_id).padStart(4, " ")}\` ` +
        `${row.seat_emoji || ""} **${row.seat_name}** — ` +
        `<@${row.attacker_id}> vs <@${row.defender_id}> — ${status}${outcome}`
      );
    });

    await interaction.reply({
      embeds: [
        baseEmbed({ color: COLORS.primary })
          .setTitle("📜 Match review")
          .setDescription(lines.join("\n"))
          .setFooter({
            text: `Showing ${rows.length} most recent • /match-status <id> for detail`,
          }),
      ],
      ephemeral: true,
    });
  },
};
