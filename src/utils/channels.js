"use strict";

/**
 * Channel resolution and posting helpers.
 *
 * Resolution order: `settings` table (runtime override via /starstream-config)
 * -> environment variable default. Returns null when neither is configured.
 */

const { getSetting } = require("../db/queries/settings");
const { logger } = require("../logging/logger");

const KINDS = Object.freeze(["rules", "alerts", "challenge", "log"]);

/** Resolve a channel id by kind ('rules' | 'alerts' | 'challenge' | 'log'). */
async function resolveChannelId(kind, config) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown channel kind: ${kind}`);
  const override = await getSetting(`channels.${kind}`);
  if (typeof override === "string" && override.trim()) return override.trim();
  return config?.channels?.[kind] || null;
}

/**
 * Post a message to a channel. Returns the sent message, or null when the
 * channel/guild is unavailable or posting fails (logged, never thrown -
 * a missing channel must not roll back game state).
 */
async function sendToChannel(guild, channelId, payload) {
  if (!guild || !channelId) return null;
  try {
    const channel = await guild.channels.fetch(channelId);
    if (!channel || typeof channel.send !== "function") {
      logger.warn(`Channel ${channelId} is not a sendable text channel.`);
      return null;
    }
    return await channel.send(payload);
  } catch (err) {
    logger.warn(`Could not post to channel ${channelId}: ${err.message}`);
    return null;
  }
}

/** Resolve a channel id and post in one step. */
async function postTo(kind, config, guild, payload) {
  const channelId = await resolveChannelId(kind, config);
  if (!channelId) {
    logger.warn(`No channel configured for "${kind}" - message not sent.`);
    return null;
  }
  return sendToChannel(guild, channelId, payload);
}

module.exports = { KINDS, resolveChannelId, sendToChannel, postTo };
