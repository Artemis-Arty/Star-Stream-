
"use strict";

/**
 * /collection-manage - resolve an open Role Collection (permission:
 * collection.manage).
 *
 * The bot never decides a no-show automatically (approved: staff decides
 * case-by-case), so staff has exactly two tools:
 *   award - hand the vacant seat to a member (cancels a pending duel),
 *   close - nobody gets the seat; it reopens on the next Arena Day
 *           (cancels a pending duel).
 * Recording an actually-played duel is done with /match-start + /match-result.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const {
  getOpenCollectionForSeat,
  awardCollection,
  closeCollection,
  errorMessage,
} = require("../../systems/collection");
const { errorEmbed, successEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("collection-manage")
    .setDescription("Resolve an open Role Collection: award the seat or close it (staff)")
    .addStringOption((option) =>
      option
        .setName("seat")
        .setDescription("Seat ID of the open collection (e.g. zeus)")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("What happens to the collection")
        .setRequired(true)
        .addChoices(
          { name: "Award the seat to a member", value: "award" },
          { name: "Close with no winner (reopens next Arena Day)", value: "close" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason recorded in the audit log")
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Recipient of the seat (required for award)")
    ),

  permission: PERMISSIONS.COLLECTION_MANAGE,

  async execute(interaction, ctx) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.COLLECTION_MANAGE))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to manage collections.")],
        ephemeral: true,
      });
      return;
    }

    const seatId = interaction.options.getString("seat").trim().toLowerCase();
    const action = interaction.options.getString("action");
    const member = interaction.options.getUser("member");
    const reason = interaction.options.getString("reason");

    const collection = await getOpenCollectionForSeat(seatId);
    if (!collection) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            `No open Role Collection for \`${seatId}\`.` +
              ` Use \`/collection\` to see open collections.`
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    if (action === "award" && !member) {
      await interaction.reply({
        embeds: [errorEmbed("Awarding needs a member option - who receives the seat?")],
        ephemeral: true,
      });
      return;
    }

    const args = {
      collectionId: Number(collection.collection_id),
      reason,
      actorId: interaction.user.id,
      guild: interaction.guild,
      config: ctx.config,
      at: new Date(),
    };

    const result =
      action === "award"
        ? await awardCollection({ ...args, userId: member.id })
        : await closeCollection(args);

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(errorMessage(result.code))],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        action === "award"
          ? successEmbed(
              `Awarded \`${collection.display_name}\` (${collection.emoji || ""}) ` +
                `to <@${member.id}>. The collection is closed and any pending ` +
                `duel was cancelled.`
            )
          : successEmbed(
              `Closed the Role Collection for \`${collection.display_name}\` ` +
                `with no winner. It reopens on the next Arena Day (Mon/Wed/Sat).`
            ),
      ],
      ephemeral: true,
    });
  },
};
