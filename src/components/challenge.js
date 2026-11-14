"use strict";

/**
 * Challenge Accept/Refuse buttons.
 * customId: challenge:accept:<id> | challenge:refuse:<id>
 *
 * Only the CURRENT holder of the seat can respond (checked inside the
 * transaction), and only while the 4-hour window is open.
 */

const {
  acceptChallenge,
  refuseChallenge,
  processExpiredChallenges,
  errorMessage,
} = require("../systems/challenge");
const { errorEmbed, successEmbed } = require("../utils/embeds");

module.exports = {
  prefix: "challenge",

  async execute(interaction, ctx) {
    const [, action, idRaw] = interaction.customId.split(":");
    const challengeId = Number.parseInt(idRaw, 10);

    if (!Number.isInteger(challengeId)) {
      await interaction.reply({
        embeds: [errorEmbed("This challenge button is malformed.")],
        ephemeral: true,
      });
      return;
    }

    const config = ctx.config;
    const guild = interaction.guild;
    const at = new Date();
    const respond = (payload) =>
      interaction.replied || interaction.deferred
        ? interaction.followUp({ ...payload, ephemeral: true })
        : interaction.reply({ ...payload, ephemeral: true });

    let result;
    if (action === "accept") {
      result = await acceptChallenge({
        challengeId,
        userId: interaction.user.id,
        guild,
        config,
        at,
      });
    } else if (action === "refuse") {
      result = await refuseChallenge({
        challengeId,
        userId: interaction.user.id,
        guild,
        config,
        at,
      });
    } else {
      await respond({
        embeds: [errorEmbed("Unknown challenge action.")],
      });
      return;
    }

    // The window may have just closed before the sweep ran: process it now
    // so the counter/strip rules apply immediately, then tell the user.
    if (!result.ok && result.code === "EXPIRED") {
      await processExpiredChallenges({ guild, config, at });
      await respond({ embeds: [errorEmbed(errorMessage("EXPIRED"))] });
      return;
    }

    if (!result.ok) {
      await respond({ embeds: [errorEmbed(errorMessage(result.code))] });
      return;
    }

    const text =
      action === "accept"
        ? "Challenge accepted — the 15-minute game-agreement window has started."
        : result.stripped
          ? "Challenge refused — this was the fourth, so the modifier role has been stripped."
          : "Challenge refused. The challenger's chance against this seat is consumed for today.";

    await respond({ embeds: [successEmbed(text)], });
  },
};
