-- 0022_lms_canvas_pat.sql
--
-- UNI-63: replace the Canvas OAuth integration with a Personal Access
-- Token (PAT) flow. Admins configure only the institution's Canvas base
-- URL per university; users generate their own PAT in Canvas and paste
-- it into Settings → Integrations.
--
-- This is a destructive migration for the LMS connection layer. The
-- reference deploy has zero live `lms_connections` rows, so dropping
-- and recreating the table is safe and avoids dragging the OAuth-shaped
-- columns forward as nullable dead weight. Provider-config rows
-- (`lms_provider_configs`) are preserved since they hold the per-
-- university `base_url`; only the OAuth client columns are stripped.
--
-- Three table changes:
--
--   1. `lms_provider_configs` — drop `client_id` and
--      `client_secret_encrypted`. The remaining columns describe the
--      institution's Canvas tenant (`base_url`) and the row's lifecycle
--      (`enabled`, `configured_by_user_id`, timestamps). For
--      `provider_id = 'canvas'`, base URL is the Canvas root
--      (e.g. https://frostburg.instructure.com).
--
--   2. `lms_connections` — drop `auth_method`, `refresh_token_encrypted`,
--      `token_expires_at`, `scope`. PATs don't refresh, don't expire
--      under client control, and Canvas does not return a scope on PAT
--      requests. Keep `access_token_encrypted` (now NOT NULL — every
--      live connection carries an encrypted PAT) and the rest of the
--      lifecycle metadata (`status`, `last_synced_at`, timestamps).
--
--   3. `lms_oauth_states` — drop entirely. PAT auth has no callback
--      redirect, no `state` parameter, no CSRF window.
--
-- The disconnect handler now deletes the row outright (per UNI-63 spec
-- "Disconnect button clears the row"); we no longer rely on a `revoked`
-- status to keep an empty placeholder around. The CHECK constraint on
-- `status` keeps `expired` so a 401 from Canvas can mark the connection
-- without deleting it (the user re-pastes a fresh PAT to recover).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. lms_provider_configs — strip the OAuth client columns.
--
-- D1 / SQLite ≥ 3.35 supports `ALTER TABLE … DROP COLUMN`, so we use
-- it directly rather than the rebuild-via-temp-table dance. No data
-- migration is required: every customer admin will re-save the row
-- once with the simpler form, and the columns we're dropping carried
-- secrets we explicitly do NOT want to round-trip.
-- ---------------------------------------------------------------------------
ALTER TABLE lms_provider_configs DROP COLUMN client_id;
ALTER TABLE lms_provider_configs DROP COLUMN client_secret_encrypted;

-- ---------------------------------------------------------------------------
-- 2. lms_connections — destructive recreate.
--
-- The old shape had nullable token columns and an `auth_method` enum
-- that we're collapsing to PAT-only. Recreating is cleaner than four
-- separate ALTERs (DROP COLUMN x4 + tighten NOT NULL on the access
-- token), and it lets us restate the whole table contract in one
-- place.
--
-- Indexes are recreated alongside the table. The original 0015_lms.sql
-- defined three: by user_id, by university_id, and by status.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS lms_connections;

CREATE TABLE lms_connections (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL
                           CHECK (provider_id IN (
                             'canvas','blackboard','moodle','google_classroom'
                           )),
  -- Mirrors the user's home university for fast tenant-scoped queries
  -- (a user's `university_id` could in principle become NULL on
  -- archive). Set at insert; update on rare re-home.
  university_id            TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  base_url                 TEXT NOT NULL,
  -- The per-user Personal Access Token, field-encrypted under the
  -- per-university key (HKDF from LMS_TOKEN_ENCRYPTION_KEY +
  -- university_id). Format: base64 of `iv || ciphertext || tag`. See
  -- docs/encryption.md. Required — every live row carries one.
  access_token_encrypted   TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','expired')),
  last_synced_at           TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, provider_id)
);

CREATE INDEX idx_lms_connections_user_id       ON lms_connections(user_id);
CREATE INDEX idx_lms_connections_university_id ON lms_connections(university_id);
CREATE INDEX idx_lms_connections_status        ON lms_connections(status);

-- ---------------------------------------------------------------------------
-- 3. lms_oauth_states — drop entirely. PAT flow has no callback.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS lms_oauth_states;
