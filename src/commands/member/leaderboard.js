"use strict";

/**
 * /leaderboard - two lifetime boards: Kills and Subdued.
 * Only the invoker's own ranks are shown for them (privacy-friendly, low memory).
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS } = require("../../utils/embeds");
const { displayNameOf } = require("../../utils/members");
const leaderboardQ = require("../../db/queries/leaderboard");

function medal(index) {
  return ["🥇", "🥈", "🥉"][index] || `**${index + 1}.**`;
}

async function boardLines(column, client) {
  const top = await leaderboardQ.getTop(column, leaderboardQ.PAGE_SIZE);
  if (top.length === 0) return "*No records yet.*";
  const lines = await Promise.all(
    top.map(async (row, index) => {
      const name = await displayNameOf(client, row.user_id);
      return `${medal(index)} ${name} — **${row.score}**`;
    })
  );
  return lines.join("\n");
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Display the lifetime Kill and Subdued leaderboards"),

  async execute(interaction, ctx) {
    const { client } = ctx;
    const [killBoard, subduedBoard, myKills, mySubdued] = await Promise.all([
      boardLines("kills", client),
      boardLines("subdued", client),
      leaderboardQ.getRank(interaction.user.id, "kills"),
      leaderboardQ.getRank(interaction.user.id, "subdued"),
    ]);

    const myLine =
      `Your rank — Kills: ${myKills ? `#${myKills.rank} (${myKills.score})` : "unranked"} • ` +
      `Subdued: ${mySubdued ? `#${mySubdued.rank} (${mySubdued.score})` : "unranked"}`;

    const embed = baseEmbed({ color: COLORS.gold })
      .setTitle("📊 Star Stream Leaderboards")
      .addFields(
        { name: "⚔️ Kill Leaderboard", value: killBoard, inline: true },
        { name: "🌙 Subdued Leaderboard", value: subduedBoard, inline: true },
        { name: "📍 Your position", value: myLine, inline: false }
      );

    await interaction.reply({ embeds: [embed] });
  },
};
