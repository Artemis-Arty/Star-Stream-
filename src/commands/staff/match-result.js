
"use strict";

/**
 * /match-result - record a match result with proof (permission: match.verify).
 *
 * Rules enforced by the system layer (approved decisions):
 *  - at least one screenshot/proof link is required (staff attach all
 *    evidence); without proof nothing is recorded,
 *  - the throne switches immediately on recording,
 *  - winner choices are validated per outcome (accept_throne/kill for the
 *    attacker, subdue/swap for the defender; swap needs the attacker to
 *    hold a throne),
 *  - a winner who already holds a throne must pass seat_choice ('won' or
 *    'current'); the seat they do not keep opens to a Role Collection.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const { recordResult, errorMessage, outcomeLabel } = require("../../systems/match");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("match-result")
    .setDescription("Record a match result with proof - applies immediately (staff)")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("Match ID (see /match-status)").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("outcome")
        .setDescription("What happened in the match")
        .setRequired(true)
        .addChoices(
          { name: "Attacker wins", value: "attacker_victory" },
          { name: "Defender wins", value: "defender_victory" },
          { name: "Challenger no-show (forfeit)", value: "abandon_attacker" },
          { name: "Holder no-show (counts as refusal)", value: "abandon_defender" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("proof")
        .setDescription("Screenshot/proof link(s), space-separated - required")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("winner_choice")
        .setDescription("Throne choice of the winner (not for no-shows)")
        .addChoices(
          { name: "Accept throne", value: "accept_throne" },
          { name: "Kill (vacate the seat)", value: "kill" },
          { name: "Subdue (keep throne, +1 Subdued)", value: "subdue" },
          { name: "Swap (take the challenger's throne)", value: "swap" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("seat_choice")
        .setDescription("Only when the winner already holds a throne")
        .addChoices(
          { name: "Take the won throne (old one opens to collection)", value: "won" },
          { name: "Keep the throne I hold (won one opens to collection)", value: "current" }
        )
    )
    .addStringOption((option) =>
      option.setName("proof2").setDescription("Extra proof link(s), space-separated")
    )
    .addStringOption((option) =>
      option.setName("notes").setDescription("Staff notes recorded with the result")
    ),

  permission: PERMISSIONS.MATCH_VERIFY,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.MATCH_VERIFY))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to record match results.")],
        ephemeral: true,
      });
      return;
    }

    const id = interaction.options.getInteger("id");
    const outcome = interaction.options.getString("outcome");
    const winnerChoice = interaction.options.getString("winner_choice");
    const seatChoice = interaction.options.getString("seat_choice");
    const proof = interaction.options.getString("proof");
    const proof2 = interaction.options.getString("proof2");
    const notes = interaction.options.getString("notes");

    const result = await recordResult({
      matchId: id,
      outcome,
      winnerChoice,
      seatChoice,
      proof: [proof, proof2],
      actorId: interaction.user.id,
      guild: interaction.guild,
      config: ctx.config,
      notes,
      at: new Date(),
    });

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(errorMessage(result.code))],
        ephemeral: true,
      });
      return;
    }

    const winnerLine = result.winnerId
      ? `Winner: <@${result.winnerId}> - ${outcomeLabel(result.match)}`
      : `${outcomeLabel(result.match)} - no winner recorded`;

    await interaction.reply({
      embeds: [
        successEmbed(
          `Match #${id} recorded: **${winnerLine}**.\n` +
            `Status: \`${result.match.status}\` - effects (stats, throne, roles) applied immediately.`
        ),
      ],
      ephemeral: true,
    });
  },
};
