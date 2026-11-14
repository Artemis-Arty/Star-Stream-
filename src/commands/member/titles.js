"use strict";

/**
 * /titles - view unlocked/locked titles, equip or unequip one.
 * Titles are earned through their linked achievements (spec section 4).
 */

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { baseEmbed, COLORS } = require("../../utils/embeds");
const { resolveTarget } = require("../../utils/members");
const { getTitlesFor, getEquippedTitle } = require("../../db/queries/titles");
const { getAchievement } = require("../../config/achievements");

function requirementText(title) {
  const achievement = getAchievement(title.achievement);
  return achievement ? `Achievement: **${achievement.name}**` : "Locked";
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("titles")
    .setDescription("View, equip or unequip your Star Stream titles")
    .addUserOption((option) =>
      option.setName("member").setDescription("View another member's titles")
    ),

  async execute(interaction) {
    const { userId, user, member: targetMember } = await resolveTarget(
      interaction,
      interaction.options.getUser("member")
    );
    const isSelf = userId === interaction.user.id;
    const titles = await getTitlesFor(userId);
    const equipped = await getEquippedTitle(userId);

    const unlocked = titles.filter((t) => t.unlocked);
    const locked = titles.filter((t) => !t.unlocked);

    const embed = baseEmbed({ color: COLORS.gold })
      .setAuthor({
        name: `${user.username}'s Titles`,
        iconURL: user.displayAvatarURL({ size: 256 }),
      })
      .addFields({
        name: "🎖️ Equipped",
        value: equipped ? `**${equipped.name}**` : "None",
        inline: false,
      });

    embed.addFields({
      name: `✅ Unlocked (${unlocked.length})`,
      value: unlocked.length
        ? unlocked.map((t) => `**${t.name}**${t.equipped ? " — equipped" : ""}`).join("\n")
        : "*None yet — unlock their achievements first.*",
      inline: false,
    });

    embed.addFields({
      name: `🔒 Locked (${locked.length})`,
      value: locked.length
        ? locked.map((t) => `**${t.name}** — ${requirementText(t)}`).join("\n")
        : "*All titles unlocked!*",
      inline: false,
    });

    const components = [];
    if (isSelf && unlocked.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`title:equip:${userId}`)
        .setPlaceholder("Equip a title…")
        .addOptions(
          unlocked.slice(0, 25).map((t) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(t.name)
              .setValue(t.key)
              .setDescription(t.equipped ? "Currently equipped" : "Equip this title")
              .setDefault(Boolean(t.equipped))
          )
        );
      components.push(new ActionRowBuilder().addComponents(select));
    }
    if (isSelf) {
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`title:unequip:${userId}`)
            .setLabel("Unequip current title")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!equipped)
        )
      );
    }

    await interaction.reply({ embeds: [embed], components });
    void targetMember;
  },
};
