"use strict";

/**
 * Role Collection Join button.
 * customId: collection:join:<collectionId>
 *
 * Only unranked members may join, only while the 4-hour window is open,
 * and only the first two entrants are accepted (checked inside the
 * transaction that locks the collection row).
 */

const { joinCollection, processExpiredCollections, errorMessage } = require("../systems/collection");
const { errorEmbed, successEmbed } = require("../utils/embeds");

module.exports = {
  prefix: "collection",

  async execute(interaction, ctx) {
    const [, action, idRaw] = interaction.customId.split(":");
    const collectionId = Number.parseInt(idRaw, 10);

    if (!Number.isInteger(collectionId)) {
      await interaction.reply({
        embeds: [errorEmbed("This collection button is malformed.")],
        ephemeral: true,
      });
      return;
    }

    if (action !== "join") {
      await interaction.reply({
        embeds: [errorEmbed("Unknown collection action.")],
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

    let result = await joinCollection({
      collectionId,
      userId: interaction.user.id,
      guild,
      config,
      at,
    });

    // The window may have just closed before the sweep ran: resolve it now
    // (solo grant / no entrants / duel lock) and tell the user.
    if (!result.ok && result.code === "EXPIRED") {
      await processExpiredCollections({ guild, config, at });
      await respond({ embeds: [errorEmbed(errorMessage("EXPIRED"))] });
      return;
    }

    if (!result.ok) {
      await respond({ embeds: [errorEmbed(errorMessage(result.code))] });
      return;
    }

    const text =
      result.matchId
        ? `You are the second entrant - the Role Collection is now locked. ` +
          `The staff-supervised duel will decide the seat (Match #${result.matchId}).`
        : `You joined the Role Collection (${result.entrantCount}/2). ` +
          (result.entrantCount === 1
            ? `If nobody else joins by the deadline, you receive the role automatically.`
            : `Two entrants are in - staff will run the duel.`);

    await respond({ embeds: [successEmbed(text)] });
  },
};
