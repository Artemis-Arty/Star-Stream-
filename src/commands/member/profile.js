"use strict";

/**
 * /profile [member] - Star Stream identity card.
 *
 * Constellation holders see throne information (bounty, refusals, reign).
 * Unranked members never see throne-specific details (spec section 4).
 */

const { SlashCommandBuilder } = require("discord.js");
const {
  baseEmbed,
  COLORS,
  formatExp,
} = require("../../utils/embeds");
const { resolveTarget } = require("../../utils/members");
const { formatDuration } = require("../../utils/time");
const membersQ = require("../../db/queries/members");
const matchesQ = require("../../db/queries/matches");
const titlesQ = require("../../db/queries/titles");
const { evaluateAchievements } = require("../../systems/achievements");
const { computeBounty } = require("../../systems/bounty");
const { getAchievement } = require("../../config/achievements");
const { logger } = require("../../logging/logger");

function achievementList(keys) {
  if (keys.length === 0) return "None yet";
  const names = keys.map((key) => getAchievement(key)?.name || key);
  const shown = names.slice(0, 15).join(", ");
  return names.length > 15 ? `${shown} … +${names.length - 15} more` : shown;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("profile")
    .setDescription("Display a Star Stream identity card")
    .addUserOption((option) =>
      option.setName("member").setDescription("Member to inspect (defaults to you)")
    ),

  async execute(interaction, ctx) {
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

    const [stats, reign, unlockedRows, equipped] = await Promise.all([
      membersQ.getStats(userId),
      membersQ.getActiveReign(userId),
      membersQ.getUnlockedAchievements(userId),
      titlesQ.getEquippedTitle(userId),
    ]);

    const memberRow = await membersQ.getMember(userId);
    const unlockedKeys = unlockedRows.map((row) => row.achievement_key);

    const avatar = user.displayAvatarURL({ size: 256 });
    const embed = baseEmbed({
      color: reign ? COLORS.gold : COLORS.primary,
    })
      .setAuthor({ name: `${user.username} — Star Stream Identity`, iconURL: avatar })
      .setThumbnail(avatar);

    if (reign) {
      // ---- Constellation card ----
      const reignMs = Date.now() - new Date(reign.started_at).getTime();
      const bounty = computeBounty(reign.started_at);

      embed
        .addFields(
          {
            name: "⭐ Constellation",
            value: `**${reign.display_name}** — modifier \`${reign.modifier_role_name}\``,
            inline: false,
          },
          { name: "📊 Status", value: "👑 Reigning Constellation", inline: true },
          { name: "⚔️ Kills", value: String(stats.kills), inline: true },
          {
            name: "🌙 Subdued",
            value: `${stats.subdued}  *(incl. throne defenses)*`,
            inline: true,
          },
          {
            name: "🛡️ Refusals",
            value: `${reign.refusal_count}/3`,
            inline: true,
          },
          { name: "💰 Current bounty", value: formatExp(bounty), inline: true },
          { name: "⏳ Reign", value: formatDuration(reignMs), inline: true },
          { name: "🏆 Achievements", value: achievementList(unlockedKeys), inline: false },
          { name: "🎖️ Equipped title", value: equipped ? equipped.name : "None equipped", inline: true }
        );
    } else {
      // ---- Unranked Challenger card ----
      const throneVictories = await matchesQ.countThroneVictories(userId);
      const customNote =
        memberRow && memberRow.throne_accepts === 0
          ? `${memberRow.custom_unlocks_count} *(next unlock at ${memberRow.next_custom_requirement} Kills)*`
          : String(memberRow?.custom_unlocks_count ?? 0);

      embed
        .addFields(
          { name: "📊 Status", value: "🗡️ Unranked Challenger", inline: true },
          { name: "⚔️ Kills", value: String(stats.kills), inline: true },
          { name: "🌙 Subdued", value: String(stats.subdued), inline: true },
          {
            name: "🎮 Matches",
            value: `${stats.total_matches} (${stats.wins}W – ${stats.losses}L)`,
            inline: true,
          },
          { name: "🔥 Current streak", value: String(stats.win_streak), inline: true },
          {
            name: "🌟 Constellations defeated",
            value: String(throneVictories),
            inline: true,
          },
          { name: "🧬 Custom Constellations", value: customNote, inline: true },
          { name: "🏆 Achievements", value: achievementList(unlockedKeys), inline: false },
          { name: "🎖️ Equipped title", value: equipped ? equipped.name : "None equipped", inline: true }
        );
    }

    await interaction.reply({ embeds: [embed] });
  },
};
