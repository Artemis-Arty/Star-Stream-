"use strict";

/**
 * /challenge <constellation> - issue a challenge against a Constellation.
 *
 * The public announcement (with Accept/Refuse buttons) is posted to the
 * challenge channel; this reply is ephemeral so the channel stays clean.
 */

const { SlashCommandBuilder } = require("discord.js");
const { findHolderSeat, issueChallenge, errorMessage } = require("../../systems/challenge");
const { successEmbed, errorEmbed } = require("../../utils/embeds");
const { unixSeconds } = require("../../utils/time");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Challenge a Constellation to a match for their throne")
    .addUserOption((option) =>
      option
        .setName("constellation")
        .setDescription("The Constellation (throne holder) to challenge")
        .setRequired(true)
    ),

  async execute(interaction, ctx) {
    const target = interaction.options.getUser("constellation");

    const seat = await findHolderSeat(target.id);
    if (!seat) {
      await interaction.reply({
        embeds: [errorEmbed(`${target.username} does not hold a Constellation throne.`)],
        ephemeral: true,
      });
      return;
    }

    const result = await issueChallenge({
      challengerId: interaction.user.id,
      seatId: seat.seat_id,
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
          `Your challenge against **${seat.display_name}** ` +
            `(<@${seat.holder_id}>) was posted in the challenge channel.\n` +
            `They have 4 hours to respond — expires ` +
            `<t:${unixSeconds(result.challenge.response_deadline_at)}:R>.`
        ),
      ],
      ephemeral: true,
    });
  },
};
