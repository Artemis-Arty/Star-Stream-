"use strict";

/**
 * /bounty - all active bounties, highest first, with time remaining
 * until the next 14-day increase and the total available bounty.
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS, formatExp, formatAgo } = require("../../utils/embeds");
const { paginate } = require("../../utils/pagination");
const { formatRemaining } = require("../../utils/time");
const { getBountyBoard } = require("../../db/queries/thrones");

const PER_PAGE = 8;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("bounty")
    .setDescription("Display all active Constellation bounties"),

  async execute(interaction) {
    const { occupied, total } = await getBountyBoard();

    if (occupied.length === 0) {
      await interaction.reply({
        embeds: [
          baseEmbed().setDescription("💤 No thrones are currently occupied — no bounties are growing."),
        ],
      });
      return;
    }

    const pages = [];
    for (let i = 0; i < occupied.length; i += PER_PAGE) {
      const chunk = occupied.slice(i, i + PER_PAGE);
      pages.push(() => {
        const embed = baseEmbed({ color: COLORS.gold }).setTitle("💰 Active Bounties");
        for (const seat of chunk) {
          const value = [
            `**Holder:** <@${seat.holderId}>`,
            `**Bounty:** ${formatExp(seat.bounty)}`,
            `**Reign:** ${formatAgo(seat.reignMs)}`,
            `**Next increase:** ${formatRemaining(seat.nextIncrease.remainingMs)} → ${formatExp(
              seat.nextIncrease.amount
            )}`,
          ].join("\n");
          embed.addFields({
            name: `${seat.emoji || "🌌"} ${seat.display_name}`,
            value,
            inline: true,
          });
        }
        embed.setFooter({ text: `Total available: ${formatExp(total)} • Star Stream` });
        return embed;
      });
    }

    await paginate(interaction, pages, { prefix: `bounty:${interaction.id}` });
  },
};
