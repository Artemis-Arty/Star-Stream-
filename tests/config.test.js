"use strict";

/**
 * Stage 1 tests: environment configuration validation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { loadConfig } = require("../src/config/env");

const ENV_KEYS = [
  "NODE_ENV",
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "DATABASE_URL",
  "AUTO_MIGRATE",
  "TIMEZONE",
  "CHANNEL_RULES_ID",
  "CHANNEL_ALERTS_ID",
  "CHANNEL_CHALLENGE_ID",
  "CHANNEL_LOG_ID",
  "BACKUP_DIR",
  "BACKUP_INTERVAL_HOURS",
  "BACKUP_RETENTION",
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const MINIMAL_ENV = {
  DISCORD_TOKEN: "test-token",
  CLIENT_ID: "123456789012345678",
  GUILD_ID: "123456789012345678",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/testdb",
};

test("loads a minimal valid environment", () => {
  withEnv(MINIMAL_ENV, () => {
    const cfg = loadConfig();
    assert.equal(cfg.discord.token, "test-token");
    assert.equal(cfg.timezone, "UTC"); // default
    assert.equal(cfg.database.autoMigrate, true); // default
    assert.equal(cfg.channels.alerts, null); // optional
    assert.ok(Object.isFrozen(cfg));
  });
});

test("rejects a missing DISCORD_TOKEN", () => {
  const env = { ...MINIMAL_ENV };
  delete env.DISCORD_TOKEN;
  withEnv(env, () => {
    assert.throws(() => loadConfig(), /DISCORD_TOKEN/);
  });
});

test("rejects a missing DATABASE_URL", () => {
  const env = { ...MINIMAL_ENV };
  delete env.DATABASE_URL;
  withEnv(env, () => {
    assert.throws(() => loadConfig(), /DATABASE_URL/);
  });
});

test("rejects an invalid TIMEZONE", () => {
  withEnv({ ...MINIMAL_ENV, TIMEZONE: "Not/AZone" }, () => {
    assert.throws(() => loadConfig(), /TIMEZONE/);
  });
});

test("accepts a real IANA timezone", () => {
  withEnv({ ...MINIMAL_ENV, TIMEZONE: "Asia/Kolkata" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.timezone, "Asia/Kolkata");
  });
});

test("rejects malformed channel snowflakes", () => {
  withEnv({ ...MINIMAL_ENV, CHANNEL_ALERTS_ID: "not-an-id" }, () => {
    assert.throws(() => loadConfig(), /CHANNEL_ALERTS_ID/);
  });
});

test("parses valid channel snowflakes", () => {
  withEnv({ ...MINIMAL_ENV, CHANNEL_ALERTS_ID: "1552712760641593376" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.channels.alerts, "1552712760641593376");
  });
});

test("rejects non-integer BACKUP_INTERVAL_HOURS", () => {
  withEnv({ ...MINIMAL_ENV, BACKUP_INTERVAL_HOURS: "daily" }, () => {
    assert.throws(() => loadConfig(), /BACKUP_INTERVAL_HOURS/);
  });
});

test(".env.example documents every supported variable", () => {
  const fs = require("fs");
  const example = fs.readFileSync(
    path.join(__dirname, "..", ".env.example"),
    "utf8"
  );
  for (const key of ENV_KEYS) {
    assert.ok(example.includes(`${key}=`), `.env.example missing ${key}`);
  }
});
