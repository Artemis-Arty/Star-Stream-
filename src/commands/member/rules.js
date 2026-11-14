"use strict";

/**
 * /rules - official Star Stream rules with section navigation.
 * Content lives in src/config/rules-content.js (editable without code
 * changes to the bot logic).
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS } = require("../../utils/embeds");
const { paginate } = require("../../utils/pagination");
const { RULES_SECTIONS } = require("../../config/rules-content");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("rules")
    .setDescription("Display the official Star Stream rules"),

  async execute(interaction) {
    const pages = RULES_SECTIONS.map((section, index) => () =>
      baseEmbed({ color: COLORS.gold })
        .setTitle(section.title)
        .setDescription(section.lines.join("\n"))
        .setFooter({
          text: `Section ${index + 1} of ${RULES_SECTIONS.length} • Star Stream Rules`,
        })
    );

    await paginate(interaction, pages, { prefix: `rules:${interaction.id}` });
  },
};
