"use strict";

/**
 * Command loader: collects slash command definitions from
 * src/commands/member/ and src/commands/staff/.
 *
 * Each command module exports:
 *   { data: SlashCommandBuilder, execute(interaction, ctx) }
 * `ctx` carries { client, db, config, logger } - dependency injection so
 * systems never reach for globals.
 *
 * scripts/deploy-commands.js uses getCommandList() to register them.
 */

const fs = require("fs");
const path = require("path");
const { logger } = require("../logging/logger");

const CATEGORIES = ["member", "staff"];

function loadCommandDir(category) {
  const dir = path.join(__dirname, category);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => ({ file, fullPath: path.join(dir, file), category }));
}

function loadCommands() {
  const byName = new Map();
  const errors = [];

  for (const entry of loadCommandDir("member").concat(loadCommandDir("staff"))) {
    let command;
    try {
      command = require(entry.fullPath);
    } catch (err) {
      errors.push(`${entry.category}/${entry.file}: ${err.message}`);
      continue;
    }
    if (!command || !command.data || typeof command.execute !== "function") {
      errors.push(`${entry.category}/${entry.file}: missing { data, execute }`);
      continue;
    }
    const name = command.data.name;
    if (byName.has(name)) {
      errors.push(`duplicate command name "${name}" (${entry.file})`);
      continue;
    }
    byName.set(name, { ...command, category: entry.category, file: entry.file });
  }

  if (errors.length > 0) {
    logger.error("Command loading problems:", errors.join(" | "));
    throw new Error(`Failed to load commands: ${errors.join("; ")}`);
  }

  return byName;
}

module.exports = { loadCommands, CATEGORIES };
