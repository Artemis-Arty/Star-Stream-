"use strict";

/**
 * /titles components: equip via select menu, unequip via button.
 * customId format: title:equip:<userId> / title:unequip:<userId>
 * Only the owner of the message can use them.
 */

const { equipTitle, unequipTitle } = require("../db/queries/titles");
const { successEmbed, errorEmbed } = require("../utils/embeds");

module.exports = {
  prefix: "title",

  async execute(interaction) {
    const [, action, ownerUserId] = interaction.customId.split(":");

    if (ownerUserId !== interaction.user.id) {
      await interaction.reply({
        embeds: [errorEmbed("Only the person who opened `/titles` can use these controls.")],
        ephemeral: true,
      });
      return;
    }

    if (action === "equip" && interaction.isStringSelectMenu()) {
      const titleKey = interaction.values[0];
      try {
        const title = await equipTitle(interaction.user.id, titleKey);
        await interaction.reply({
          embeds: [successEmbed(`Equipped **${title.name}**.`)],
          ephemeral: true,
        });
      } catch (err) {
        if (err.message === "TITLE_LOCKED") {
          await interaction.reply({
            embeds: [errorEmbed("You have not unlocked that title yet.")],
            ephemeral: true,
          });
          return;
        }
        throw err;
      }
      return;
    }

    if (action === "unequip" && interaction.isButton()) {
      const removed = await unequipTitle(interaction.user.id);
      await interaction.reply({
        embeds: [
          removed
            ? successEmbed("Title unequipped.")
            : errorEmbed("You do not have a title equipped."),
        ],
        ephemeral: true,
      });
    }
  },
};
