"use strict";

/** Helpers for resolving command targets and display names. */

/**
 * Resolve the target member of a command (defaults to the invoker).
 * Fetches via REST so no GuildMembers intent is required.
 */
async function resolveTarget(interaction, userOption) {
  const user = userOption || interaction.user;
  const userId = user.id;
  let member = null;
  try {
    member = await interaction.guild.members.fetch(userId);
  } catch {
    member = null;
  }
  return { userId, user, member };
}

/** Display name for any user id (cache-first, REST fallback). */
async function displayNameOf(client, userId) {
  try {
    const cached = client.users.cache.get(userId);
    if (cached) return cached.username;
    const user = await client.users.fetch(userId);
    return user.username;
  } catch {
    return `Unknown (${userId})`;
  }
}

module.exports = { resolveTarget, displayNameOf };
