"use strict";

/**
 * /stats [member] - detailed lifetime statistics.
 * No seasons exist (approved decision): "seasonal ranking" from the spec
 * becomes the member's overall leaderboard ranks (Kills and Subdued).
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS, formatExp } = require("../../utils/embeds");
const { resolveTarget } = require("../../utils/members");
const { formatDuration } = require("../../utils/time");
const membersQ = require("../../db/queries/members");
const leaderboardQ = require("../../db/queries/leaderboard");
const { computeBounty } = require("../../systems/bounty");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Display detailed Star Stream statistics")
    .addUserOption((option) =>
      option.setName("member").setDescription("Member to inspect (defaults to you)")
    ),

  async execute(interaction) {
    const { userId, user } = await resolveTarget(
      interaction,
      interaction.options.getUser("member")
    );

    await membersQ.ensureMember(userId, user.username);
    const [stats, memberRow, reign, reignSummary] = await Promise.all([
      membersQ.getStats(userId),
      membersQ.getMember(userId),
      membersQ.getActiveReign(userId),
      membersQ.getReignSummary(userId),
    ]);

    const [killsRank, subduedRank] = await Promise.all([
      leaderboardQ.getRank(userId, "kills"),
      leaderboardQ.getRank(userId, "subdued"),
    ]);

    const longestReign = reignSummary.longestReignMs > 0
      ? formatDuration(reignSummary.longestReignMs)
      : "—";

    const embed = baseEmbed()
      .setAuthor({ name: `${user.username} — Statistics`, iconURL: user.displayAvatarURL({ size: 256 }) })
      .addFields(
        { name: "🎮 Total matches", value: String(stats.total_matches), inline: true },
        {
          name: "📈 Wins / Losses",
          value: `${stats.wins} / ${stats.losses}`,
          inline: true,
        },
        { name: "⚔️ Kills", value: String(stats.kills), inline: true },
        {
          name: "🌙 Subdued",
          value: `${stats.subdued}  *(incl. throne defenses)*`,
          inline: true,
        },
        { name: "🔥 Current streak", value: String(stats.win_streak), inline: true },
        { name: "🏆 Best streak", value: String(stats.best_win_streak), inline: true },
        {
          name: "🛡️ Refusals",
          value: reign ? `${reign.refusal_count}/3` : "—",
          inline: true,
        },
        {
          name: "💰 Total bounty earned",
          value: formatExp(stats.bounty_earned),
          inline: true,
        },
        {
          name: "💎 Current bounty",
          value: reign ? formatExp(computeBounty(reign.started_at)) : "—",
          inline: true,
        },
        { name: "👑 Total reigns", value: String(reignSummary.total_reigns), inline: true },
        { name: "⏳ Longest reign", value: longestReign, inline: true },
        {
          name: "📍 Leaderboard ranks",
          value: `Kills: ${killsRank ? `#${killsRank.rank}` : "unranked"} • Subdued: ${
            subduedRank ? `#${subduedRank.rank}` : "unranked"
          }`,
          inline: false,
        }
      );

    await interaction.reply({ embeds: [embed] });
  },
};
