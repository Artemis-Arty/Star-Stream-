"use strict";

/**
 * Runtime settings stored in the `settings` table (JSONB values).
 *
 * Used for values that staff may change without a redeploy (channel IDs,
 * etc.). Environment variables remain the bootstrap defaults.
 */

const { query } = require("../pool");

/** Read a setting (JSONB) or null when unset. */
async function getSetting(key) {
  const result = await query(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (result.rows.length === 0) return null;
  return result.rows[0].value;
}

/** Write a setting (upsert). Returns the stored value. */
async function setSetting(key, value, updatedBy = null) {
  const result = await query(
    `INSERT INTO settings (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by
     RETURNING value`,
    [key, JSON.stringify(value ?? null), updatedBy]
  );
  return result.rows[0].value;
}

module.exports = { getSetting, setSetting };
