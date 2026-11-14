"use strict";

/**
 * /match-start - register and start a match inside the 15-minute
 * game-agreement window (permission: match.register).
 *
 * If nobody starts the match before the window lapses, the timer sweeper
 * cancels it and refunds the challenger's daily chance.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const {
  startMatch,
  errorMessage,
  DEFAULT_GAME_LABEL,
} = require("../../systems/match");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("match-start")
    .setDescription("Start a scheduled match within its 15-minute game window (staff)")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("Match ID (see /match-review)").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("game")
        .setDescription(`Agreed game (default: ${DEFAULT_GAME_LABEL})`)
    ),

  permission: PERMISSIONS.MATCH_REGISTER,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.MATCH_REGISTER))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to start matches.")],
        ephemeral: true,
      });
      return;
    }

    const id = interaction.options.getInteger("id");
    const game = interaction.options.getString("game");

    const result = await startMatch({
      matchId: id,
      game,
      actorId: interaction.user.id,
      guild: interaction.guild,
      config: ctx.config,
      at: new Date(),
    });

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(errorMessage(result.code))],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        successEmbed(
          `Match #${id} started - game: **${result.match.game_agreed}**.\n` +
            `Record the result with \`/match-result\` when the match finishes ` +
            `(screenshot proof required).`
        ),
      ],
      ephemeral: true,
    });
  },
};
