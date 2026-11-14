"use strict";

/**
 * /challenge-cancel - staff cancellation of a pending or accepted challenge.
 *
 * Cancelling frees BOTH the seat (the lock is released) and the challenger's
 * once-per-Arena-Day chance against that seat. Every cancellation is written
 * to the staff audit log with actor, previous/new value and reason.
 */

const { SlashCommandBuilder } = require("discord.js");
const { PERMISSIONS } = require("../../config/permissions");
const { hasPermission } = require("../../systems/permissions");
const { cancelChallenge, getSeatWithHolder, errorMessage } = require("../../systems/challenge");
const { recordStaffAction } = require("../../systems/audit");
const { query } = require("../../db/pool");
const { errorEmbed, successEmbed, infoEmbed } = require("../../utils/embeds");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("challenge-cancel")
    .setDescription("Cancel a pending or accepted challenge (staff)")
    .addUserOption((option) =>
      option
        .setName("challenger")
        .setDescription("Member who issued the challenge")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("id")
        .setDescription("Challenge ID (required when several are active)")
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason recorded in the audit log")
    ),

  permission: PERMISSIONS.CHALLENGE_CANCEL,

  async execute(interaction) {
    if (!(await hasPermission(interaction.member, PERMISSIONS.CHALLENGE_CANCEL))) {
      await interaction.reply({
        embeds: [errorEmbed("You do not have permission to cancel challenges.")],
        ephemeral: true,
      });
      return;
    }

    const challenger = interaction.options.getUser("challenger");
    const idOption = interaction.options.getInteger("id");
    const reason = interaction.options.getString("reason");

    const active = await query(
      `SELECT * FROM challenges
        WHERE challenger_id = $1 AND status IN ('pending', 'accepted')
        ORDER BY created_at DESC`,
      [challenger.id]
    );

    let challenge = null;
    if (idOption != null) {
      challenge = active.rows.find((row) => Number(row.challenge_id) === idOption) || null;
      if (!challenge) {
        const any = await query(`SELECT status FROM challenges WHERE challenge_id = $1`, [
          idOption,
        ]);
        await interaction.reply({
          embeds: [
            errorEmbed(
              any.rows.length === 0
                ? errorMessage("NOT_FOUND")
                : `Challenge #${idOption} is not active (status: ${any.rows[0].status}).`
            ),
          ],
          ephemeral: true,
        });
        return;
      }
    } else if (active.rows.length === 1) {
      challenge = active.rows[0];
    } else if (active.rows.length === 0) {
      await interaction.reply({
        embeds: [infoEmbed(`${challenger.username} has no active challenges.`)],
        ephemeral: true,
      });
      return;
    } else {
      const list = active.rows
        .map((row) => `#${row.challenge_id} → seat \`${row.seat_id}\` (${row.status})`)
        .join("\n");
      await interaction.reply({
        embeds: [
          infoEmbed(
            `${challenger.username} has ${active.rows.length} active challenges:\n${list}\n\n` +
              `Re-run with \`id:\` to pick one.`,
            "Multiple active challenges"
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    const challengeId = Number(challenge.challenge_id);
    const seat = await getSeatWithHolder(challenge.seat_id);

    const result = await cancelChallenge({
      challengeId,
      actorId: interaction.user.id,
      reason,
    });

    if (!result.ok) {
      await interaction.reply({
        embeds: [errorEmbed(errorMessage(result.code))],
        ephemeral: true,
      });
      return;
    }

    await recordStaffAction({
      actorId: interaction.user.id,
      action: "challenge.cancel",
      targetType: "challenge",
      targetId: String(challengeId),
      previousValue: {
        status: challenge.status,
        seat_id: challenge.seat_id,
        challenger_id: String(challenge.challenger_id),
      },
      newValue: { status: "cancelled" },
      reason,
    });

    await interaction.reply({
      embeds: [
        successEmbed(
          `Challenge #${challengeId} against **${seat?.display_name || challenge.seat_id}** ` +
            `was cancelled.\n` +
            `<@${challenge.challenger_id}> may challenge that seat again today.`
        ),
      ],
      ephemeral: true,
    });
  },
};
