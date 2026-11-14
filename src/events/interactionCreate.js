"use strict";

/**
 * Central interaction router:
 *  - slash commands  -> src/commands (member/ and staff/)
 *  - buttons/selects  -> src/components (by customId prefix)
 * Any failure is logged and answered with a safe ephemeral message so
 * users never see a dead interaction.
 */

const { Events } = require("discord.js");
const { getComponent } = require("../components");
const { hasPermission } = require("../systems/permissions");
const { logger } = require("../logging/logger");
const { errorEmbed } = require("../utils/embeds");

async function respondEphemeral(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ ...payload, ephemeral: true });
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch {
    /* interaction expired - nothing we can do */
  }
}

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) {
          await respondEphemeral(interaction, {
            embeds: [errorEmbed("This command is not registered. Run `/deploy` on the host.")],
          });
          return;
        }
        // Commands that declare a `permission` key are staff-only; the check
        // is centralized here so no staff command can forget it.
        if (command.permission && !(await hasPermission(interaction.member, command.permission))) {
          await respondEphemeral(interaction, {
            embeds: [errorEmbed("You do not have permission to use this command.")],
          });
          return;
        }
        await command.execute(interaction, { client, config: client.config });
        return;
      }

      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const component = getComponent(interaction.customId);
        if (component) {
          await component.execute(interaction, { client, config: client.config });
        }
        // Unknown component prefixes are ignored (e.g. expired pagination
        // buttons that already have disabled collectors).
      }
    } catch (err) {
      logger.error(
        `Interaction failed (${interaction.isChatInputCommand() ? interaction.commandName : interaction.customId}):`,
        err
      );
      await respondEphemeral(interaction, {
        embeds: [
          errorEmbed(
            "Something went wrong running that. The error has been logged — please try again."
          ),
        ],
      });
    }
  },
};
