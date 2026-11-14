"use strict";

/**
 * /throne-grant - manually seat a holder on a VACANT Constellation throne
 * (repair tool; permission: throne.grant).
 *
 * Closes any open Role Collection for the seat. Does not count as a throne
 * accept (staff assignment - documented Stage 5 decision).
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const { grantThrone, errorMessage } = require("../../systems/collection");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("throne-grant")
    .setDescription("Manually seat a holder on a vacant Constellation throne (staff)")
    .addStringOption((option) =>
      option
        .setName("seat")
        .setDescription("Seat ID (e.g. zeus, hades, odin - see /thrones)")
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Member who receives the throne")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason recorded in the audit log")
    ),

  permission: PERMISSIONS.THRONE_GRANT,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.THRONE_GRANT))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to grant thrones.")],
        ephemeral: true,
      });
      return;
    }

    const seatId = interaction.options.getString("seat").trim().toLowerCase();
    const member = interaction.options.getUser("member");
    const reason = interaction.options.getString("reason");

    const result = await grantThrone({
      seatId,
      userId: member.id,
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
          `<@${member.id}> now holds \`${result.seat.display_name}\` ` +
            `(${result.seat.emoji || ""}).` +
            (result.closedCollectionId
              ? `\nThe open Role Collection #${result.closedCollectionId} was closed.`
              : "")
        ),
      ],
      ephemeral: true,
    });
  },
};
