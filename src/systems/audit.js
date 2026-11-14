"use strict";

/**
 * Staff audit log (spec section 12): every administrative action records
 * who, what, when, the previous value, the new value and the reason.
 */

const { query } = require("../db/pool");

/**
 * Append an audit entry.
 * @returns {Promise<object>} the inserted staff_actions row
 */
async function recordStaffAction({
  actorId,
  action,
  targetType = null,
  targetId = null,
  previousValue = null,
  newValue = null,
  reason = null,
}) {
  if (!actorId) throw new Error("recordStaffAction requires actorId");
  if (!action) throw new Error("recordStaffAction requires action");

  const result = await query(
    `INSERT INTO staff_actions
       (actor_id, action, target_type, target_id, previous_value, new_value, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
     RETURNING *`,
    [
      actorId,
      action,
      targetType,
      targetId == null ? null : String(targetId),
      previousValue == null ? null : JSON.stringify(previousValue),
      newValue == null ? null : JSON.stringify(newValue),
      reason,
    ]
  );
  return result.rows[0];
}

module.exports = { recordStaffAction };
