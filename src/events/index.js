"use strict";

/**
 * Event loader: registers every file in src/events/ with the client.
 *
 * Each event module exports:
 *   { name: Discord event name, once?: boolean, execute(...args, client) }
 */

const fs = require("fs");
const path = require("path");
const { logger } = require("../logging/logger");

function loadEvents(client) {
  const dir = path.join(__dirname);
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js") && file !== "index.js")
    .sort();

  let loaded = 0;
  for (const file of files) {
    const event = require(path.join(dir, file));
    if (!event || typeof event.name !== "string" || typeof event.execute !== "function") {
      logger.warn(`Event file ${file} is missing { name, execute } - skipped`);
      continue;
    }
    if (event.once) client.once(event.name, (...args) => event.execute(...args, client));
    else client.on(event.name, (...args) => event.execute(...args, client));
    loaded += 1;
  }

  logger.info(`Loaded ${loaded} event handler(s).`);
  return loaded;
}

module.exports = { loadEvents };
