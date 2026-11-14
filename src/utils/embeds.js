"use strict";

/**
 * Star Stream embed builders - one visual identity across the whole bot.
 */

const { EmbedBuilder } = require("discord.js");

const COLORS = Object.freeze({
  primary: 0x7b3fe4, // nebula purple
  gold: 0xf5c542, // constellation gold
  danger: 0xe04848,
  success: 0x3fbf6f,
  neutral: 0x5865f2,
  dim: 0x949cf7,
});

const FOOTER = "Star Stream • The Constellations";

function baseEmbed({ color = COLORS.primary } = {}) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

function successEmbed(description, title) {
  return baseEmbed({ color: COLORS.success }).setDescription(
    title ? `✅ **${title}**\n\n${description}` : `✅ ${description}`
  );
}

function errorEmbed(description) {
  return baseEmbed({ color: COLORS.danger }).setDescription(`❌ ${description}`);
}

function infoEmbed(description, title) {
  return baseEmbed().setDescription(title ? `**${title}**\n\n${description}` : description);
}

/** Format an EXP amount with thousands separators. */
function formatExp(amount) {
  return `${Number(amount).toLocaleString("en-US")} EXP`;
}

/** "3d 4h" style reign length. */
function formatAgo(ms) {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && minutes) parts.push(`${minutes}m`);
  return parts.length ? parts.join(" ") : "0m";
}

module.exports = {
  COLORS,
  FOOTER,
  baseEmbed,
  successEmbed,
  errorEmbed,
  infoEmbed,
  formatExp,
  formatAgo,
};
