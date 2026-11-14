"use strict";

/**
 * Component loader: buttons and select menus registered by prefix.
 *
 * Each component file exports:
 *   { prefix: string, execute(interaction, ctx) }
 * A button/select with customId "prefix:action" routes here.
 * (Pagination uses its own collectors and is not routed through this.)
 */

const fs = require("fs");
const path = require("path");
const { logger } = require("../logging/logger");

let cache = null;

function loadComponents() {
  if (cache) return cache;
  const map = new Map();
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js") && file !== "index.js")
    .sort();

  for (const file of files) {
    const component = require(path.join(dir, file));
    if (!component || typeof component.prefix !== "string" || typeof component.execute !== "function") {
      logger.warn(`Component file ${file} is missing { prefix, execute } - skipped`);
      continue;
    }
    if (map.has(component.prefix)) {
      throw new Error(`Duplicate component prefix "${component.prefix}" (${file})`);
    }
    map.set(component.prefix, component);
  }
  cache = map;
  return map;
}

function getComponent(customId) {
  const prefix = customId.split(":")[0];
  return loadComponents().get(prefix) || null;
}

module.exports = { loadComponents, getComponent };
