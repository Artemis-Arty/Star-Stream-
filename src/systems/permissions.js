"use strict";

/**
 * Staff permission checks.
 *
 * - Discord Administrators always pass (bootstrap access so admins can
 *   always configure the system).
 * - Otherwise the member needs a Discord role listed in staff_permissions
 *   for the requested permission key (configured via /starstream-config).
 * - Default deny: an unconfigured key grants nobody (except admins).
 */

const { PermissionsBitField } = require("discord.js");
const { query } = require("../db/pool");
const { ALL_PERMISSION_KEYS } = require("../config/permissions");

/** Does this guild member hold `permissionKey`? */
async function hasPermission(member, permissionKey) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;

  const result = await query(
    `SELECT role_id FROM staff_permissions WHERE permission_key = $1`,
    [permissionKey]
  );
  if (result.rows.length === 0) return false;

  const memberRoleIds = member.roles.cache;
  return result.rows.some((row) => memberRoleIds.has(String(row.role_id)));
}

/** All permission keys this member holds (for /help filtering). */
async function getAuthorizedKeys(member) {
  if (!member) return new Set();
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return new Set(ALL_PERMISSION_KEYS);
  }
  const result = await query(`SELECT permission_key, role_id FROM staff_permissions`);
  const memberRoleIds = member.roles.cache;
  const keys = new Set();
  for (const row of result.rows) {
    if (memberRoleIds.has(String(row.role_id))) keys.add(row.permission_key);
  }
  return keys;
}

module.exports = { hasPermission, getAuthorizedKeys };
