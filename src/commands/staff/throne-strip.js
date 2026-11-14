"use strict";

/**
 * /throne-strip - remove a SPECIFIC holder's modifier role and vacate the
 * throne (punitive; permission: throne.strip).
 *
 * Arms the holder's Arena-Day waiting gate and opens a Role Collection for
 * the seat (spec section 6). A reason is required for the audit log.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const { stripThrone, errorMessage } = require("../../systems/collection");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("throne-strip")
    .setDescription("Strip the modifier role from a Constellation and vacate the throne (staff)")
    .addStringOption((option) =>
      option
        .setName("seat")
        .setDescription("Seat ID (e.g. zeus, hades, odin - see /thrones)")
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("The current holder being stripped")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason recorded in the audit log")
        .setRequired(true)
    ),

  permission: PERMISSIONS.THRONE_STRIP,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.THRONE_STRIP))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to strip thrones.")],
        ephemeral: true,
      });
      return;
    }

    const seatId = interaction.options.getString("seat").trim().toLowerCase();
    const member = interaction.options.getUser("member");
    const reason = interaction.options.getString("reason");

    const result = await stripThrone({
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
          `Stripped <@${member.id}> from \`${result.seat.display_name}\` ` +
            `(${result.seat.emoji || ""}). The role was removed, the holder's ` +
            `waiting gate is armed and a Role Collection opens in #alerts.`
        ),
      ],
      ephemeral: true,
    });
  },
};
