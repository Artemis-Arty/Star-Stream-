"use strict";

/**
 * /thrones - every Constellation seat: modifier, holder, status,
 * bounty and reign duration. Supports custom seats automatically.
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS, formatExp, formatAgo } = require("../../utils/embeds");
const { paginate } = require("../../utils/pagination");
const { getSeatsWithHolders } = require("../../db/queries/thrones");

const SEATS_PER_PAGE = 15;

module.exports = {
  data: new SlashCommandBuilder()
    .setName("thrones")
    .setDescription("Display all Constellation thrones and their holders"),

  async execute(interaction) {
    const seats = await getSeatsWithHolders();

    const pages = [];
    for (let i = 0; i < seats.length || i === 0; i += SEATS_PER_PAGE) {
      const chunk = seats.slice(i, i + SEATS_PER_PAGE);
      pages.push(() => {
        const embed = baseEmbed({ color: COLORS.gold }).setTitle("👑 Constellation Thrones");
        if (chunk.length === 0) {
          embed.setDescription("No Constellation seats are configured.");
          return embed;
        }
        for (const seat of chunk) {
          const holder = seat.holderId ? `<@${seat.holderId}>` : "*Vacant*";
          const value = [
            `**Holder:** ${holder}`,
            `**Status:** ${seat.holderId ? "Occupied" : " vacant"}`,
            `**Bounty:** ${formatExp(seat.bounty)}`,
            `**Reign:** ${seat.holderId ? formatAgo(seat.reignMs) : "—"}`,
          ].join("\n");
          embed.addFields({
            name: `${seat.emoji || "🌌"} ${seat.display_name} — \`${seat.modifier_role_name}\``,
            value,
            inline: true,
          });
        }
        return embed;
      });
      if (i + SEATS_PER_PAGE >= seats.length && seats.length > 0) break;
      if (seats.length === 0) break;
    }

    await paginate(interaction, pages, { prefix: `thrones:${interaction.id}` });
  },
};
