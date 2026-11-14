"use strict";

/**
 * Environment configuration loader.
 *
 * All secrets, IDs and host-specific values come from environment variables
 * (.env file via dotenv). Nothing game-related is hardcoded here; game rules
 * live in src/config/*.js and in the database.
 */

const path = require("path");

require("dotenv").config({
  path: process.env.DOTENV_PATH || path.join(__dirname, "..", "..", ".env"),
  quiet: true,
});

function fail(message) {
  throw new Error(`[config] ${message}`);
}

function requireVar(name, { allowEmpty = false } = {}) {
  const value = (process.env[name] || "").trim();
  if (!value && !allowEmpty) {
    fail(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function optionalVar(name, fallback = "") {
  const value = (process.env[name] || "").trim();
  return value === "" ? fallback : value;
}

function boolVar(name, fallback) {
  const value = optionalVar(name, null);
  if (value === null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function intVar(name, fallback) {
  const value = optionalVar(name, null);
  if (value === null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    fail(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  return parsed;
}

function snowflakeVar(name) {
  const value = optionalVar(name);
  if (!value) return null;
  if (!/^\d{17,20}$/.test(value)) {
    fail(`Environment variable ${name} must be a Discord snowflake ID, got "${value}"`);
  }
  return value;
}

/** Validate the timezone early so a typo fails fast at boot. */
function validateTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    fail(`TIMEZONE "${tz}" is not a valid IANA timezone (e.g. UTC, Europe/London)`);
  }
  return tz;
}

function loadConfig() {
  const nodeEnv = optionalVar("NODE_ENV", "development");
  const isProduction = nodeEnv === "production";
  const isTest = nodeEnv === "test";

  const config = {
    nodeEnv,
    isProduction,
    isTest,

    discord: {
      token: requireVar("DISCORD_TOKEN"),
      clientId: requireVar("CLIENT_ID"),
      guildId: requireVar("GUILD_ID"),
    },

    database: {
      url: requireVar("DATABASE_URL"),
      autoMigrate: boolVar("AUTO_MIGRATE", true),
      // Small pool: free hosting tiers have limited connections/memory.
      poolSize: intVar("DB_POOL_SIZE", 4),
    },

    timezone: validateTimezone(optionalVar("TIMEZONE", "UTC")),

    // Role Collection: hour-of-day (0-23, in TIMEZONE) when an unfilled
    // vacant seat re-opens its collection on an Arena Day (approved: env).
    collection: (() => {
      const openHour = intVar("COLLECTION_OPEN_HOUR", 0);
      if (openHour < 0 || openHour > 23) {
        fail(`COLLECTION_OPEN_HOUR must be between 0 and 23, got ${openHour}`);
      }
      return { openHour };
    })(),

    channels: {
      // Overridable at runtime through /starstream-config (settings table).
      rules: snowflakeVar("CHANNEL_RULES_ID"),
      alerts: snowflakeVar("CHANNEL_ALERTS_ID"),
      challenge: snowflakeVar("CHANNEL_CHALLENGE_ID"),
      log: snowflakeVar("CHANNEL_LOG_ID"),
    },

    backup: {
      dir: optionalVar("BACKUP_DIR", "./backups"),
      intervalHours: intVar("BACKUP_INTERVAL_HOURS", 24),
      retention: intVar("BACKUP_RETENTION", 14),
    },
  };

  return Object.freeze(config);
}

let cached = null;

/** Returns the frozen config object (loaded once). */
function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

module.exports = { getConfig, loadConfig };
