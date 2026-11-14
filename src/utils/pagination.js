"use strict";

/**
 * Button pagination for long content (history, rules, help...).
 *
 * - One message, prev/next buttons, 5 minute inactivity timeout.
 * - Only the invoking user can navigate.
 * - Buttons are disabled when the collector ends (no dead controls).
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require("discord.js");

const TIMEOUT_MS = 5 * 60 * 1000;

function buildRow(page, total, ownerId, prefix) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${prefix}:prev`)
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`${prefix}:page`)
      .setLabel(`${page + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${prefix}:next`)
      .setEmoji("▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= total - 1)
  );
}

/**
 * Send a paginated message.
 * @param {ChatInputCommandInteraction} interaction
 * @param {Array<() => EmbedBuilder>} pageBuilders functions returning embeds
 * @param {object} options { prefix, allowedUserId }
 */
async function paginate(interaction, pageBuilders, options = {}) {
  const prefix = options.prefix || `page:${interaction.id}`;
  const allowedUserId = options.allowedUserId || interaction.user.id;

  if (pageBuilders.length === 0) {
    throw new Error("paginate() requires at least one page");
  }

  let page = 0;
  const render = () => ({
    embeds: [pageBuilders[page]()],
    components:
      pageBuilders.length > 1 ? [buildRow(page, pageBuilders.length, allowedUserId, prefix)] : [],
  });

  const payload = render();
  const message = await interaction.reply({ ...payload, fetchReply: true });

  if (pageBuilders.length === 1) return message;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: TIMEOUT_MS,
    filter: (i) => i.customId.startsWith(`${prefix}:`) && i.user.id === allowedUserId,
  });

  collector.on("collect", async (buttonInteraction) => {
    const action = buttonInteraction.customId.split(":")[1];
    if (action === "prev" && page > 0) page -= 1;
    else if (action === "next" && page < pageBuilders.length - 1) page += 1;
    await buttonInteraction.update(render()).catch(() => {});
  });

  collector.on("end", async () => {
    const expired = {
      embeds: [pageBuilders[page]()],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${prefix}:expired`)
            .setLabel("Expired — run the command again")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true)
        ),
      ],
    };
    await message.edit(expired).catch(() => {});
  });

  return message;
}

module.exports = { paginate, TIMEOUT_MS };
