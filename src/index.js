"use strict";

/**
 * Star Stream: The Constellations - entry point.
 *
 * Boot order:
 *   1. Validate environment (.env)
 *   2. Connect PostgreSQL + apply pending migrations
 *   3. Load events and commands
 *   4. Login to Discord
 *   5. Start the automatic backup schedule
 *
 * Timer recovery (challenges, Role Collections, game-agreement windows) is
 * driven from the database timestamps by the systems in later stages; it is
 * re-run on every startup so restarts never lose deadlines.
 */

const { getConfig } = require("./config/env");
const { logger } = require("./logging/logger");
const { closePool } = require("./db/pool");
const { runMigrations } = require("./db/migrate");
const { scheduleAutoBackups } = require("./db/backup");
const { loadEvents } = require("./events");
const { loadCommands } = require("./commands");
const { startTimers, stopTimers } = require("./systems/timers");
const { Client, GatewayIntentBits, Events } = require("discord.js");

async function main() {
  const cfg = getConfig();
  logger.info(
    `Star Stream booting | env=${cfg.nodeEnv} | tz=${cfg.timezone} | guild=${cfg.discord.guildId}`
  );

  // --- Database ---
  if (cfg.database.autoMigrate) {
    await runMigrations();
  } else {
    logger.info("AUTO_MIGRATE=false - skipping migration check.");
  }

  // --- Discord ---
  // Guilds-only intent: member lookups use the REST endpoint, which keeps
  // memory low on free hosting tiers (no privileged intents needed).
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.Error, (err) => logger.error("Discord client error:", err));
  client.on(Events.Warn, (msg) => logger.warn("Discord client warn:", msg));

  const commands = loadCommands();
  client.commands = commands;
  client.config = cfg;
  logger.info(`Registered ${commands.size} slash command definition(s).`);

  loadEvents(client);

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      `Logged in as ${readyClient.user.tag} | guilds=${readyClient.guilds.cache.size}`
    );
    // Recover deadlines that passed while the bot was down, then keep
    // sweeping every minute. Timers are DB-driven, so nothing is lost.
    startTimers(readyClient);
  });

  // --- Automatic backups ---
  scheduleAutoBackups(cfg.backup);

  // --- Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received - shutting down gracefully...`);
    stopTimers();
    try {
      client.destroy();
    } catch (err) {
      logger.error("Error destroying Discord client:", err.message);
    }
    try {
      await closePool();
    } catch (err) {
      logger.error("Error closing database pool:", err.message);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    // Log, then exit so the host supervisor restarts us with clean state.
    logger.error("Uncaught exception:", err);
    shutdown("uncaughtException").then(() => process.exit(1));
  });

  await client.login(cfg.discord.token);
}

main().catch((err) => {
  logger.error("Fatal startup error:", err);
  closePool()
    .catch(() => {})
    .finally(() => process.exit(1));
});
