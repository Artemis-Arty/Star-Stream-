"use strict";

/**
 * /throne-vacate - empty a throne regardless of holder (structural;
 * permission: throne.vacate).
 *
 * Removes the role from the current holder, arms their waiting gate and
 * opens a Role Collection for the seat. A reason is required for the audit
 * log.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const { vacateThrone, errorMessage } = require("../../systems/collection");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("throne-vacate")
    .setDescription("Vacate a Constellation throne (staff)")
    .addStringOption((option) =>
      option
        .setName("seat")
        .setDescription("Seat ID (e.g. zeus, hades, odin - see /thrones)")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason recorded in the audit log")
        .setRequired(true)
    ),

  permission: PERMISSIONS.THRONE_VACATE,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.THRONE_VACATE))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to vacate thrones.")],
        ephemeral: true,
      });
      return;
    }

    const seatId = interaction.options.getString("seat").trim().toLowerCase();
    const reason = interaction.options.getString("reason");

    const result = await vacateThrone({
      seatId,
      reason,
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
          `Vacated \`${result.seat.display_name}\` (${result.seat.emoji || ""}) ` +
            `(was held by <@${result.holderId}>). The role was removed and a ` +
            `Role Collection opens in #alerts.`
        ),
      ],
      ephemeral: true,
    });
  },
};
