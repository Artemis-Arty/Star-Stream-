"use strict";

/** Role Collection queries for /collection. */

const { query } = require("../pool");

/** All currently open Role Collections with seat and entrant counts. */
async function getOpenCollections() {
  const result = await query(
    `SELECT rc.*, s.display_name, s.modifier_role_name, s.emoji,
            (SELECT COUNT(*)::int
               FROM role_collection_entries e
              WHERE e.collection_id = rc.collection_id) AS entrants,
            (SELECT ARRAY_AGG(e.user_id ORDER BY e.joined_at)
               FROM role_collection_entries e
              WHERE e.collection_id = rc.collection_id) AS entrant_ids
       FROM role_collections rc
       JOIN seats s ON s.seat_id = rc.seat_id
      WHERE rc.status = 'open'
      ORDER BY rc.opened_at`
  );
  return result.rows;
}

module.exports = { getOpenCollections };
