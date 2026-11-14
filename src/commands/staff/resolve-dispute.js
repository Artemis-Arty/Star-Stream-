"use strict";

/**
 * /resolve-dispute - open or resolve a dispute on a recorded result
 * (permission: match.dispute.resolve).
 *
 * Members ping staff in chat when they disagree with a result; staff then
 * open the dispute here (the match flips to disputed, its effects stay
 * - approved) and resolve it after review. Corrections to stats/thrones
 * use the staff data-correction tools.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const { openDispute, resolveDispute, errorMessage } = require("../../systems/match");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resolve-dispute")
    .setDescription("Open or resolve a dispute on a recorded match result (staff)")
    .addIntegerOption((option) =>
      option.setName("id").setDescription("Match ID").setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Open a new dispute or resolve the open one")
        .setRequired(true)
        .addChoices(
          { name: "Open dispute (match → disputed)", value: "open" },
          { name: "Resolve dispute (match → verified)", value: "resolve" }
        )
    )
    .addUserOption((option) =>
      option
        .setName("reporter")
        .setDescription("Member who reported the problem (open only)")
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Dispute reason (open) or resolution text (resolve)")
    ),

  permission: PERMISSIONS.MATCH_DISPUTE_RESOLVE,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.MATCH_DISPUTE_RESOLVE))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to resolve disputes.")],
        ephemeral: true,
      });
      return;
    }

    const id = interaction.options.getInteger("id");
    const action = interaction.options.getString("action");
    const reporter = interaction.options.getUser("reporter");
    const reason = interaction.options.getString("reason");

    const args = {
      matchId: id,
      actorId: interaction.user.id,
      guild: interaction.guild,
      config: ctx.config,
      at: new Date(),
    };

    const result =
      action === "open"
        ? await openDispute({
            ...args,
            reporterId: reporter ? reporter.id : null,
            reason,
          })
        : await resolveDispute({ ...args, resolution: reason });

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
          action === "open"
            ? `Match #${id} is now **disputed** (reported by ${
                reporter ? `<@${reporter.id}>` : `<@${interaction.user.id}>`
              }). Resolve it with \`/resolve-dispute action:resolve\`.`
            : `Dispute on match #${id} resolved - the match is **verified** again.\n` +
              `Effects of the original record were kept; correct any data with the staff tools if needed.`
        ),
      ],
      ephemeral: true,
    });
  },
};
