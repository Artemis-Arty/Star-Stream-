"use strict";

/**
 * /achievements - every achievement with unlocked/locked state.
 * Based on LIFETIME statistics; never lost (spec section 4).
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS } = require("../../utils/embeds");
const { resolveTarget } = require("../../utils/members");
const membersQ = require("../../db/queries/members");
const { evaluateAchievements, getUnlockedKeys } = require("../../systems/achievements");
const { ACHIEVEMENTS } = require("../../config/achievements");
const { logger } = require("../../logging/logger");

const CATEGORY_LABELS = {
  kill: "⚔️ Kill achievements",
  conquest: "👑 Conquest achievements",
  subdued: "🛡️ Subdued achievements",
};

function requirementText(requirement) {
  switch (requirement.type) {
    case "kills":
      return `${requirement.value} Kills`;
    case "subdued":
      return `${requirement.value} Subdued`;
    case "thrones_taken":
      return "Claim a throne";
    case "constellations_defeated":
      return `Defeat ${requirement.value} Constellations`;
    case "custom_unlocks":
      return "Unlock a custom Constellation";
    case "king":
      return "Become King of Constellations";
    default:
      return "Unknown requirement";
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("achievements")
    .setDescription("Display unlocked and locked achievements")
    .addUserOption((option) =>
      option.setName("member").setDescription("Member to inspect (defaults to you)")
    ),

  async execute(interaction) {
    const { userId, user } = await resolveTarget(
      interaction,
      interaction.options.getUser("member")
    );

    await membersQ.ensureMember(userId, user.username);
    try {
      await evaluateAchievements(userId);
    } catch (err) {
      logger.warn(`Achievement evaluation failed for ${userId}:`, err.message);
    }

    const unlocked = await getUnlockedKeys(userId);

    const embed = baseEmbed({ color: COLORS.gold })
      .setAuthor({
        name: `${user.username} — Achievements (${unlocked.size}/${ACHIEVEMENTS.length})`,
        iconURL: user.displayAvatarURL({ size: 256 }),
      });

    for (const [category, label] of Object.entries(CATEGORY_LABELS)) {
      const lines = ACHIEVEMENTS.filter((a) => a.category === category).map((a) => {
        const isUnlocked = unlocked.has(a.key);
        return isUnlocked
          ? `✅ **${a.name}** — ${a.description}`
          : `🔒 **${a.name}** — requires ${requirementText(a.requirement)}`;
      });
      embed.addFields({ name: label, value: lines.join("\n") || "*None*", inline: false });
    }

    await interaction.reply({ embeds: [embed] });
  },
};
