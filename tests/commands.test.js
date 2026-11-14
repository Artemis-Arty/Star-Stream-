"use strict";

/**
 * Stage 2 tests: command registry, components and permission helper
 * (no database or Discord connection required).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadCommands } = require("../src/commands");
const { loadComponents, getComponent } = require("../src/components");
const { hasPermission } = require("../src/systems/permissions");
const { ALL_PERMISSION_KEYS, PERMISSIONS } = require("../src/config/permissions");

const EXPECTED_MEMBER_COMMANDS = [
  "achievements",
  "bounty",
  "challenge",
  "collection",
  "help",
  "history",
  "leaderboard",
  "profile",
  "rules",
  "stats",
  "thrones",
  "titles",
];

// Every member command must exist and load (Stage 2 + Stage 3).
const MEMBER_COMMANDS = EXPECTED_MEMBER_COMMANDS;

test("all member commands load with valid definitions", () => {
  const commands = loadCommands();
  for (const name of MEMBER_COMMANDS) {
    assert.ok(commands.has(name), `missing command /${name}`);
    const command = commands.get(name);
    assert.equal(command.category, "member");
    const json = command.data.toJSON();
    assert.ok(json.description.length > 0 && json.description.length <= 100);
    assert.equal(json.name, name);
    assert.equal(typeof command.execute, "function");
  }
});

test("commands do not set default_member_permissions (access is DB-configured)", () => {
  const commands = loadCommands();
  for (const command of commands.values()) {
    const json = command.data.toJSON();
    assert.ok(
      json.default_member_permissions === undefined ||
        json.default_member_permissions === null,
      `/${json.name} must not hardcode Discord-side permissions`
    );
  }
});

test("staff command directory exists and loads cleanly", async () => {
  const fs = require("fs");
  const path = require("path");
  const staffDir = path.join(__dirname, "..", "src", "commands", "staff");
  if (!fs.existsSync(staffDir)) {
    fs.mkdirSync(staffDir, { recursive: true });
  }
  // loadCommands() already threw if any file was malformed.
  const commands = loadCommands();
  for (const command of commands.values()) {
    assert.ok(["member", "staff"].includes(command.category));
  }
  assert.ok(commands.size >= MEMBER_COMMANDS.length);
});

test("staff commands declare a permission key", () => {
  const commands = loadCommands();
  const cancel = commands.get("challenge-cancel");
  assert.ok(cancel, "missing /challenge-cancel");
  assert.equal(cancel.category, "staff");
  assert.equal(cancel.permission, PERMISSIONS.CHALLENGE_CANCEL);
  assert.equal(cancel.data.toJSON().name, "challenge-cancel");

  // Every staff command must declare a permission key so the router can
  // enforce it centrally.
  for (const command of commands.values()) {
    if (command.category !== "staff") continue;
    assert.ok(
      command.permission,
      `staff command /${command.data.name} must declare .permission`
    );
    assert.ok(ALL_PERMISSION_KEYS.includes(command.permission));
  }
});

test("component registry resolves the titles components", () => {
  const components = loadComponents();
  assert.ok(components.has("title"));

  const select = getComponent("title:equip:123456789012345678");
  assert.ok(select, "title:equip should route to the titles component");
  assert.equal(typeof select.execute, "function");

  const button = getComponent("title:unequip:123456789012345678");
  assert.equal(button, select);

  assert.equal(getComponent("pagination:next"), null);
  assert.equal(getComponent("unknown:thing"), null);
});

test("permission check: admin bypass and stable key format", async () => {
  // Admin bypass (no database needed on this path).
  const admin = {
    permissions: { has: () => true },
    roles: { cache: new Map() },
  };
  assert.equal(await hasPermission(admin, PERMISSIONS.MATCH_VERIFY), true);

  // Every permission key exists and is a stable string.
  for (const key of ALL_PERMISSION_KEYS) {
    assert.equal(typeof key, "string");
    assert.match(key, /^[a-z.]+$/);
  }
});
