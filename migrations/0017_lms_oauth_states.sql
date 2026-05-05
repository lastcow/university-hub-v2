-- 0017_lms_oauth_states.sql
--
-- Connect-flow scaffolding (epic UNI-50 / sub-issue UNI-54). The user-
-- facing OAuth dance for Canvas needs a place to park the CSRF `state`
-- value between the `/start` call (which mints it) and the
-- `/callback` hop (which verifies it). The row is short-lived: it is
-- deleted on successful exchange, on cross-state replay, or by the
-- nightly retention sweep when `expires_at` has passed.
--
-- We picked a D1 row over Workers KV because:
--   * The deploy already provisions D1 — no new binding required.
--   * Verification is a single keyed SELECT; the row is gone after a
--     successful round-trip, so storage stays bounded.
--   * The row carries the calling user_id, so the callback handler can
--     enforce that the session that finishes the dance is the same one
--     that started it (defense in depth on top of the random `state`).
--
-- TTL: the application sets `expires_at` to ~10 minutes after creation.
-- Canvas's authorize hop is interactive but rarely takes that long; we
-- err short rather than long because an expired state is the right
-- failure mode (user hits Connect again).
--
-- The row stores `redirect_uri` (the exact URI the start handler sent
-- to Canvas) so the callback handler can pass it back to Canvas's
-- token endpoint verbatim — Canvas treats `redirect_uri` as a binding
-- parameter and rejects mismatches.

PRAGMA foreign_keys = ON;

CREATE TABLE lms_oauth_states (
  state          TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  university_id  TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  provider_id    TEXT NOT NULL
                 CHECK (provider_id IN (
                   'canvas','blackboard','moodle','google_classroom'
                 )),
  redirect_uri   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at     TEXT NOT NULL
);

CREATE INDEX idx_lms_oauth_states_user_id    ON lms_oauth_states(user_id);
CREATE INDEX idx_lms_oauth_states_expires_at ON lms_oauth_states(expires_at);
