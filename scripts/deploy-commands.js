"use strict";

/**
 * Registers all slash commands to the guild in GUILD_ID.
 *
 * Guild-scoped registration: updates are instant (no 1-hour propagation),
 * which is ideal for a single-server bot and for test iterations.
 *
 * Usage: npm run deploy
 */

const { REST, Routes } = require("discord.js");
const { getConfig } = require("../src/config/env");
const { loadCommands } = require("../src/commands");
const { logger } = require("../src/logging/logger");

async function main() {
  const cfg = getConfig();
  const commands = loadCommands();
  const body = [...commands.values()].map((command) => command.data.toJSON());

  if (body.length === 0) {
    console.log("No commands to register.");
    return;
  }

  const rest = new REST().setToken(cfg.discord.token);
  const result = await rest.put(
    Routes.applicationGuildCommands(cfg.discord.clientId, cfg.discord.guildId),
    { body }
  );

  console.log(`Registered ${result.length} command(s) to guild ${cfg.discord.guildId}:`);
  for (const command of [...result].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  - /${command.name}`);
  }
}

main().catch((err) => {
  logger.error("Command deployment failed:", err);
  process.exit(1);
});

