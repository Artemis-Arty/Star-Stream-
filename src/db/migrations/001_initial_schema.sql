-- ============================================================
-- Star Stream: The Constellations - initial schema
-- Durable game state. Everything here survives restarts,
-- redeploys and crashes (spec section 14).
-- ============================================================

-- ---------- Runtime settings (channel overrides, etc.) ----------
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT
);

-- ---------- Members & statistics ----------
CREATE TABLE members (
  user_id                BIGINT PRIMARY KEY,
  username               TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Times this member accepted a throne. 0 = "refused every throne"
  -- (gate for custom Constellation unlocks).
  throne_accepts         INTEGER NOT NULL DEFAULT 0,
  -- When they last lost a throne (Arena Day waiting gate, section 6).
  throne_lost_at         TIMESTAMPTZ,
  -- Custom Constellation unlock ladder: 25, 35, 45... (section 11).
  next_custom_requirement INTEGER NOT NULL DEFAULT 25,
  custom_unlocks_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stats (
  user_id              BIGINT PRIMARY KEY REFERENCES members(user_id) ON DELETE CASCADE,
  kills                INTEGER NOT NULL DEFAULT 0,
  -- Merged statistic: former Defense Wins + Subdued (approved decision).
  subdued              INTEGER NOT NULL DEFAULT 0,
  wins                 INTEGER NOT NULL DEFAULT 0,
  losses               INTEGER NOT NULL DEFAULT 0,
  total_matches        INTEGER NOT NULL DEFAULT 0,
  win_streak           INTEGER NOT NULL DEFAULT 0,
  best_win_streak      INTEGER NOT NULL DEFAULT 0,
  -- Lifetime Tatsu EXP totals (records only; EXP is granted by staff).
  bounty_earned        INTEGER NOT NULL DEFAULT 0,
  defense_exp_granted  INTEGER NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Constellation seats ----------
-- modifier_role_name is the OFFICIAL locked role name: the bot never
-- renames roles. Originals are seeded from src/config/constellations.js.
CREATE TABLE seats (
  seat_id             TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  modifier_role_name  TEXT NOT NULL UNIQUE,
  description         TEXT,
  emoji               TEXT,
  -- Discord role holding the modifier (assigned via /starstream-config).
  role_id             BIGINT,
  source              TEXT NOT NULL DEFAULT 'original' CHECK (source IN ('original','custom')),
  introduced_by       BIGINT,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Reigns (throne ownership history + timers) ----------
-- The current holder is the reign with ended_at IS NULL (single source of
-- truth). Reign timers/bounties are DERIVED from started_at timestamps so
-- they survive restarts with no in-memory timers.
CREATE TABLE reigns (
  reign_id       BIGSERIAL PRIMARY KEY,
  seat_id        TEXT NOT NULL REFERENCES seats(seat_id),
  holder_id      BIGINT NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  end_reason     TEXT,
  -- Refusal counter for this holder (3 = next challenge is last chance).
  refusal_count  INTEGER NOT NULL DEFAULT 0,
  -- EXP paid to the winner when the reign ended (null while active).
  bounty_paid_exp INTEGER,
  -- Match that ended this reign (for battle-history lookups).
  ended_by_match_id BIGINT
);

CREATE INDEX idx_reigns_open ON reigns(seat_id) WHERE ended_at IS NULL;
CREATE INDEX idx_reigns_holder ON reigns(holder_id);
CREATE INDEX idx_reigns_active_holder ON reigns(holder_id) WHERE ended_at IS NULL;
CREATE INDEX idx_reigns_ended_match ON reigns(ended_by_match_id) WHERE ended_by_match_id IS NOT NULL;

-- ---------- Challenges ----------
CREATE TYPE challenge_status AS ENUM
  ('pending','accepted','refused','expired','stripped','cancelled','completed');

CREATE TABLE challenges (
  challenge_id            BIGSERIAL PRIMARY KEY,
  seat_id                 TEXT NOT NULL REFERENCES seats(seat_id),
  challenger_id           BIGINT NOT NULL,
  -- Member who refused (holder at response time).
  refuser_id              BIGINT,
  status                  challenge_status NOT NULL DEFAULT 'pending',
  -- Arena Day (in configured timezone) the challenge was issued on.
  arena_day               DATE NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 4-hour response window end (persisted -> survives restart).
  response_deadline_at    TIMESTAMPTZ NOT NULL,
  responded_at            TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  channel_id              BIGINT,
  message_id              BIGINT,
  -- Set when the accepted challenge's match result is recorded.
  match_id                BIGINT,
  -- Refusal counter snapshot when this challenge was created.
  refusal_count_at_creation INTEGER,
  -- True once the 4th-refusal role strip has been executed.
  strip_applied           BOOLEAN NOT NULL DEFAULT FALSE,
  notes                   TEXT
);

-- Spec: only one active challenge per Constellation (pending OR accepted,
-- since an accepted challenge keeps the lock until the match result).
CREATE UNIQUE INDEX uq_challenge_active_seat
  ON challenges(seat_id) WHERE status IN ('pending','accepted');

-- Spec: one challenge per Challenger per Constellation per Arena Day.
-- Cancelled challenges do not consume the opportunity.
CREATE UNIQUE INDEX uq_challenge_daily_pair
  ON challenges(challenger_id, seat_id, arena_day) WHERE status <> 'cancelled';

CREATE INDEX idx_challenges_challenger ON challenges(challenger_id, created_at DESC);
CREATE INDEX idx_challenges_deadline ON challenges(response_deadline_at) WHERE status = 'pending';

-- ---------- Matches ----------
CREATE TYPE match_type AS ENUM ('challenge','role_collection','staff');
CREATE TYPE match_status AS ENUM
  ('scheduled','in_progress','evidence_pending','awaiting_verification',
   'verified','disputed','cancelled','abandoned');
CREATE TYPE match_outcome AS ENUM
  ('attacker_victory','defender_victory','abandon_attacker','abandon_defender',
   'role_collection','other');
CREATE TYPE winner_choice AS ENUM
  ('accept_throne','kill','swap','subdue','none');

CREATE TABLE matches (
  match_id               BIGSERIAL PRIMARY KEY,
  match_type             match_type NOT NULL,
  challenge_id           BIGINT REFERENCES challenges(challenge_id),
  seat_id                TEXT NOT NULL REFERENCES seats(seat_id),
  -- attacker = Challenger / entrant 1; defender = throne holder / entrant 2.
  attacker_id            BIGINT NOT NULL,
  defender_id            BIGINT NOT NULL,
  status                 match_status NOT NULL DEFAULT 'scheduled',
  -- 15-minute game agreement window (persisted).
  game_agreed            TEXT,
  game_agreed_deadline_at TIMESTAMPTZ,
  default_game           TEXT,
  created_by             BIGINT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at             TIMESTAMPTZ,
  result_submitted_at    TIMESTAMPTZ,
  result_submitted_by    BIGINT,
  winner_id              BIGINT,
  outcome                match_outcome,
  winner_choice          winner_choice,
  verified_at            TIMESTAMPTZ,
  verified_by            BIGINT,
  abandoned_by           BIGINT,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                  TEXT
);

CREATE INDEX idx_matches_attacker ON matches(attacker_id, created_at DESC);
CREATE INDEX idx_matches_defender ON matches(defender_id, created_at DESC);
CREATE INDEX idx_matches_challenge ON matches(challenge_id);
CREATE INDEX idx_matches_open ON matches(status)
  WHERE status IN ('scheduled','in_progress','evidence_pending','awaiting_verification');

CREATE TABLE match_evidence (
  evidence_id   BIGSERIAL PRIMARY KEY,
  match_id      BIGINT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
  submitted_by  BIGINT NOT NULL,
  url           TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_evidence_match ON match_evidence(match_id);

-- ---------- Disputes ----------
CREATE TYPE dispute_status AS ENUM ('open','resolved');

CREATE TABLE match_disputes (
  dispute_id    BIGSERIAL PRIMARY KEY,
  match_id      BIGINT NOT NULL REFERENCES matches(match_id),
  reported_by   BIGINT NOT NULL,
  reason        TEXT NOT NULL,
  status        dispute_status NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by   BIGINT,
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT
);

CREATE INDEX idx_disputes_open ON match_disputes(status) WHERE status = 'open';

-- ---------- Role Collections ----------
CREATE TYPE collection_status AS ENUM ('open','closed');
CREATE TYPE collection_resolution AS ENUM ('two_entrants','solo_entrant','no_entrants');

CREATE TABLE role_collections (
  collection_id  BIGSERIAL PRIMARY KEY,
  seat_id        TEXT NOT NULL REFERENCES seats(seat_id),
  status         collection_status NOT NULL DEFAULT 'open',
  arena_day      DATE NOT NULL,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 4-hour window end (persisted -> survives restart).
  deadline_at    TIMESTAMPTZ NOT NULL,
  channel_id     BIGINT,
  message_id     BIGINT,
  match_id       BIGINT REFERENCES matches(match_id),
  winner_id      BIGINT,
  resolution     collection_resolution,
  closed_at      TIMESTAMPTZ,
  notes          TEXT
);

-- Spec: only one open collection per seat.
CREATE UNIQUE INDEX uq_open_collection
  ON role_collections(seat_id) WHERE status = 'open';

CREATE INDEX idx_collections_open ON role_collections(deadline_at) WHERE status = 'open';

CREATE TABLE role_collection_entries (
  collection_id  BIGINT NOT NULL REFERENCES role_collections(collection_id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, user_id)
);

-- ---------- Defense rewards (section 8) ----------
-- Every defense is recorded; `counted_for_reward` applies the "one defense
-- against the same player every 3 days" gate for the EXP streak.
CREATE TABLE defense_events (
  event_id           BIGSERIAL PRIMARY KEY,
  match_id           BIGINT REFERENCES matches(match_id),
  defender_id        BIGINT NOT NULL,
  opponent_id        BIGINT NOT NULL,
  reign_id           BIGINT REFERENCES reigns(reign_id),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted_for_reward BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_defense_events_lookup
  ON defense_events(defender_id, opponent_id, occurred_at DESC);

-- Active EXP reward streak. Resets to 0 when the Constellation loses the
-- throne; permanent totals live in stats.defense_exp_granted.
CREATE TABLE defense_reward_state (
  user_id           BIGINT PRIMARY KEY REFERENCES members(user_id) ON DELETE CASCADE,
  reign_id          BIGINT REFERENCES reigns(reign_id),
  qualifying_count  INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Reward transactions (idempotent, permanent ledger) ----------
CREATE TYPE reward_kind AS ENUM ('bounty','defense_exp','other');

CREATE TABLE reward_transactions (
  transaction_id  BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  kind            reward_kind NOT NULL,
  amount          INTEGER NOT NULL,
  source_type     TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  granted_by      BIGINT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Duplicate-protection: each reward source pays out exactly once.
  UNIQUE (kind, source_type, source_key)
);

CREATE INDEX idx_reward_tx_user ON reward_transactions(user_id, created_at DESC);

-- ---------- Achievements & titles (permanent) ----------
CREATE TABLE achievements_unlocked (
  user_id         BIGINT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  achievement_key TEXT NOT NULL,
  unlocked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_key)
);

CREATE TABLE member_titles (
  user_id     BIGINT NOT NULL REFERENCES members(user_id) ON DELETE CASCADE,
  title_key   TEXT NOT NULL,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  equipped    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, title_key)
);

-- At most one equipped title per member.
CREATE UNIQUE INDEX uq_one_equipped_title ON member_titles(user_id) WHERE equipped;

-- ---------- King of Constellations (section 10) ----------
CREATE TYPE king_status AS ENUM ('active','lost','destroyed');

CREATE TABLE king_records (
  king_id           BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  status            king_status NOT NULL DEFAULT 'active',
  subdued_consumed  INTEGER NOT NULL DEFAULT 25,
  forged_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  lost_at           TIMESTAMPTZ,
  lost_to           BIGINT,
  loss_reason       TEXT
);

-- The King of Constellations is a singular title: only one active king.
CREATE UNIQUE INDEX uq_king_single_active
  ON king_records(status) WHERE status = 'active';
CREATE INDEX idx_king_user ON king_records(user_id);

-- ---------- Staff permissions & audit ----------
-- Which roles hold which permission keys is decided by administrators
-- (/starstream-config). No staff hierarchy is hardcoded.
CREATE TABLE staff_permissions (
  permission_key TEXT NOT NULL,
  role_id        BIGINT NOT NULL,
  added_by       BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (permission_key, role_id)
);

-- Every administrative action: who, when, what, previous value,
-- new value, reason (spec section 12).
CREATE TABLE staff_actions (
  action_id      BIGSERIAL PRIMARY KEY,
  actor_id       BIGINT NOT NULL,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      TEXT,
  previous_value JSONB,
  new_value      JSONB,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_actions_time ON staff_actions(created_at DESC);
CREATE INDEX idx_staff_actions_actor ON staff_actions(actor_id, created_at DESC);
