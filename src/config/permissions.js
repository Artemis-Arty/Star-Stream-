"use strict";

/**
 * Staff permission keys.
 *
 * The server administrators decide which Discord roles get which keys via
 * /starstream-config (stored in the staff_permissions table). Nothing about
 * the staff hierarchy is hardcoded here - this file only defines WHICH
 * permission keys exist.
 *
 * Commands check permission keys, never role names.
 */

const PERMISSIONS = Object.freeze({
  // Matches
  MATCH_REGISTER: "match.register", // /match-start (register + start a match)
  MATCH_VERIFY: "match.verify", // verify evidence, confirm results
  MATCH_REVIEW: "match.review", // /match-review, /match-status, view evidence
  MATCH_DISPUTE_RESOLVE: "match.dispute.resolve", // /resolve-dispute

  // Challenges & collections
  CHALLENGE_CANCEL: "challenge.cancel", // /challenge-cancel
  COLLECTION_MANAGE: "collection.manage", // /collection-manage

  // Data correction
  STATS_CORRECT: "stats.correct", // /set-stats
  THRONE_ASSIGN: "throne.assign", // /set-throne (assign or release)
  BOUNTY_CORRECT: "bounty.correct", // /set-bounty

  // Throne management (Stage 5)
  THRONE_GRANT: "throne.grant", // /throne-grant (manually seat a holder)
  THRONE_STRIP: "throne.strip", // /throne-strip (remove holder + role)
  THRONE_VACATE: "throne.vacate", // /throne-vacate (empty the seat)

  // Backups & config
  BACKUP_CREATE: "backup.create", // /backup
  BACKUP_RESTORE: "backup.restore", // /restore
  CONFIG_MANAGE: "config.manage", // /starstream-config
  AUDIT_VIEW: "audit.view", // /audit-log
});

/** All permission keys, for validation when configuring. */
const ALL_PERMISSION_KEYS = Object.freeze(Object.values(PERMISSIONS));

module.exports = { PERMISSIONS, ALL_PERMISSION_KEYS };
