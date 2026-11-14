"use strict";

/**
 * /collection - current Role Collection information.
 * Joining always happens through the button on the #alerts announcement
 * (spec section 4), never through this command.
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS } = require("../../utils/embeds");
const { formatRemaining } = require("../../utils/time");
const { getOpenCollections } = require("../../db/queries/collections");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("collection")
    .setDescription("Display current Role Collection openings"),

  async execute(interaction) {
    const collections = await getOpenCollections();

    if (collections.length === 0) {
      await interaction.reply({
        embeds: [
          baseEmbed().setDescription(
            "🌟 No Role Collection is currently open.\nVacant thrones open one in `#alerts` on an Arena Day."
          ),
        ],
      });
      return;
    }

    const embed = baseEmbed({ color: COLORS.gold }).setTitle("🌟 Active Role Collections");
    for (const collection of collections) {
      const remaining = new Date(collection.deadline_at).getTime() - Date.now();
      const entrants = (collection.entrant_ids || []).map((id) => `<@${id}>`);
      const value = [
        `**Seat:** ${collection.emoji || "🌌"} ${collection.display_name} — \`${collection.modifier_role_name}\``,
        `**Entrants:** ${collection.entrants}/2 ${entrants.length ? `— ${entrants.join(", ")}` : ""}`,
        `**Closes in:** ${formatRemaining(remaining)}`,
        entrants.length >= 2
          ? "**Status:** Entrants locked — awaiting staff match"
          : "**Status:** Open — use the *Join Role Collection* button in `#alerts`",
      ].join("\n");
      embed.addFields({ name: collection.display_name, value, inline: false });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
