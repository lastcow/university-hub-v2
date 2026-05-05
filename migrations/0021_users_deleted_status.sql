-- 0021_users_deleted_status.sql
--
-- Admin user delete (epic UNI-1 / sub-issue UNI-61). Per the FERPA posture
-- the `users` row survives a "remove" — credentials are wiped, PII is
-- anonymized, status flips to 'deleted'. Two structural changes are needed
-- on the `users` table that SQLite (D1) cannot achieve via ALTER:
--
--   1. The `status` CHECK constraint hard-codes
--      ('active','inactive','suspended','pending') — UNI-61 needs a fifth
--      'deleted' state.
--   2. `password_hash` is NOT NULL today; an anonymized row must carry NULL
--      so future sign-in attempts can never match.
--
-- SQLite cannot ALTER a CHECK constraint or drop NOT NULL in place. We use
-- the same table-recreate dance as 0018_disclosure_log_basis.sql:
--
--   - PRAGMA foreign_keys = OFF (so child rows on `sessions`,
--     `course_assignments`, etc. don't dangle while we swap the table).
--   - Build `users_new` with the relaxed schema.
--   - Copy every column verbatim (no defaults need to fire on existing
--     rows; the migration only loosens constraints).
--   - Drop the original, rename the new.
--   - Recreate the indexes from 0001_initial_schema.sql.
--   - PRAGMA foreign_keys = ON.
--
-- Columns reproduced here are the union of 0001 + every later
-- ALTER TABLE users on this table (mfa_secret/mfa_enabled_at/
-- mfa_recovery_codes_hash from 0004, terms_accepted_at/_version from
-- 0008, external_provider/external_id from 0015, lms_onboarding_dismissed_at
-- from 0020). Their CHECK / DEFAULT / type clauses are preserved verbatim
-- so a fresh deploy and a migrated deploy land on the same shape.

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL
                  CHECK (role IN (
                    'super_admin','university_admin','staff','faculty',
                    'teacher','teacher_assistant','student','guest','viewer'
                  )),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'active','inactive','suspended','pending','deleted'
                  )),
  university_id   TEXT REFERENCES universities(id) ON DELETE SET NULL,
  last_sign_in_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  mfa_secret              TEXT,
  mfa_enabled_at          TEXT,
  mfa_recovery_codes_hash TEXT,
  terms_accepted_at       TEXT,
  terms_accepted_version  INTEGER,
  external_provider TEXT
    CHECK (external_provider IS NULL OR external_provider IN (
      'canvas','blackboard','moodle','google_classroom'
    )),
  external_id              TEXT,
  lms_onboarding_dismissed_at TEXT
);

INSERT INTO users_new
  (id, email, password_hash, name, role, status, university_id,
   last_sign_in_at, created_at, updated_at,
   mfa_secret, mfa_enabled_at, mfa_recovery_codes_hash,
   terms_accepted_at, terms_accepted_version,
   external_provider, external_id, lms_onboarding_dismissed_at)
SELECT
  id, email, password_hash, name, role, status, university_id,
  last_sign_in_at, created_at, updated_at,
  mfa_secret, mfa_enabled_at, mfa_recovery_codes_hash,
  terms_accepted_at, terms_accepted_version,
  external_provider, external_id, lms_onboarding_dismissed_at
FROM users;

DROP TABLE users;

ALTER TABLE users_new RENAME TO users;

-- Recreate indexes from 0001_initial_schema.sql.
CREATE INDEX idx_users_role           ON users(role);
CREATE INDEX idx_users_status         ON users(status);
CREATE INDEX idx_users_university_id  ON users(university_id);

PRAGMA foreign_keys = ON;
