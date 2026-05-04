-- 0008_ferpa_controls.sql
--
-- FERPA user-facing controls (epic UNI-21 / sub-issue UNI-32):
--
--   * directory-information opt-out + under-18 + parent/guardian email on
--     `students` (the latter two drive the parent-access flow below).
--   * `disclosure_consents` — written consent for a specific disclosure of
--     education records to a third party. FERPA §99.30 requires a record of
--     consent that is signed and dated, names the records to be disclosed,
--     names the party to whom the disclosure is made, and states the
--     purpose. We store the granter, requester, purpose, and the categories
--     of data covered, plus optional expiry. Revocation is recorded in
--     place via `revoked_at` (consents are append-only with a tombstone — we
--     never DELETE).
--   * `disclosure_log` — append-only record of an actual disclosure of
--     education records to a third party. FERPA §99.32 requires institutions
--     to keep a record of who has requested or obtained access to a
--     student's education records. Each row references the consent that
--     authorized the release.
--   * `parent_sign_in_tokens` — passwordless email-token for the parent /
--     guardian sign-in flow (under-18 students only). Tokens are short-
--     lived (15 min) and single-use; we store only a hash.
--   * `parent_sessions` — once a token is verified, a parent gets a session
--     scoped to one student. Read-only — the routes/parent-* handlers refuse
--     anything outside grades + records for that one student.
--
-- The choice to keep parent identities OUT of `users` is deliberate. The
-- spec calls it the "lightest sufficient implementation": the parent has no
-- account, no role, and no cross-student visibility. The token-and-session
-- flow gives the parent exactly one student's read-only view, gated by the
-- email the institution already trusts (`parent_guardian_email`).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- students — directory-info opt-out + under-18 + parent/guardian
-- ---------------------------------------------------------------------------

ALTER TABLE students
  ADD COLUMN directory_info_opt_out INTEGER NOT NULL DEFAULT 0
    CHECK (directory_info_opt_out IN (0, 1));

ALTER TABLE students
  ADD COLUMN under_18 INTEGER NOT NULL DEFAULT 0
    CHECK (under_18 IN (0, 1));

ALTER TABLE students
  ADD COLUMN parent_guardian_email TEXT;

CREATE INDEX idx_students_directory_info_opt_out
  ON students(directory_info_opt_out);
CREATE INDEX idx_students_parent_guardian_email
  ON students(parent_guardian_email);

-- ---------------------------------------------------------------------------
-- disclosure_consents — FERPA §99.30 written consent
-- ---------------------------------------------------------------------------
--
-- `data_categories` is a JSON array of strings drawn from a
-- frontend-validated set ("grades", "transcript", "attendance",
-- "disciplinary", "directory", "financial_aid", "other"). Stored as TEXT
-- so the schema doesn't have to change to add categories.
--
-- `granted_by_user_id` is the user who acted to grant the consent — the
-- student themselves when over 18, or the staff/admin recording a
-- paper-signed consent on a parent's behalf for under-18 cases. The
-- frontend collects an explicit acknowledgement; this column is purely the
-- audit thread.

CREATE TABLE disclosure_consents (
  id                    TEXT PRIMARY KEY,
  student_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  university_id         TEXT REFERENCES universities(id) ON DELETE SET NULL,
  requester             TEXT NOT NULL,
  purpose               TEXT NOT NULL,
  data_categories       TEXT NOT NULL,
  granted_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  granted_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at            TEXT,
  revoked_at            TEXT,
  revoked_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_disclosure_consents_student_user_id
  ON disclosure_consents(student_user_id);
CREATE INDEX idx_disclosure_consents_university_id
  ON disclosure_consents(university_id);
CREATE INDEX idx_disclosure_consents_revoked_at
  ON disclosure_consents(revoked_at);

-- ---------------------------------------------------------------------------
-- disclosure_log — FERPA §99.32 record of disclosure
-- ---------------------------------------------------------------------------
--
-- Append-only. Recording a disclosure REQUIRES a referenced consent that
-- is non-revoked at the time of release; the route layer enforces this
-- because SQLite can't express "FK to a non-revoked row" declaratively.
--
-- `released_to` is denormalized from `disclosure_consents.requester` for
-- convenience — the consent might be amended (rare) or expire (more
-- common); this column records who actually received the data on this
-- specific release.

CREATE TABLE disclosure_log (
  id                    TEXT PRIMARY KEY,
  student_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  university_id         TEXT REFERENCES universities(id) ON DELETE SET NULL,
  consent_id            TEXT NOT NULL REFERENCES disclosure_consents(id) ON DELETE RESTRICT,
  released_to           TEXT NOT NULL,
  data_categories       TEXT NOT NULL,
  notes                 TEXT,
  released_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_disclosure_log_student_user_id
  ON disclosure_log(student_user_id);
CREATE INDEX idx_disclosure_log_university_id
  ON disclosure_log(university_id);
CREATE INDEX idx_disclosure_log_consent_id
  ON disclosure_log(consent_id);
CREATE INDEX idx_disclosure_log_released_at
  ON disclosure_log(released_at);

-- ---------------------------------------------------------------------------
-- parent_sign_in_tokens — short-lived single-use email-token
-- ---------------------------------------------------------------------------
--
-- We store only a SHA-256 hash. Tokens are 15-minute single-use; a verify
-- attempt deletes the token row regardless of outcome (rate-limited at the
-- middleware layer to prevent brute force). The student_user_id binding is
-- baked in at request time — the parent never picks which student to
-- impersonate; we look it up by `students.parent_guardian_email` and the
-- `under_18` flag and refuse if either condition is unmet.

CREATE TABLE parent_sign_in_tokens (
  id                    TEXT PRIMARY KEY,
  student_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_email          TEXT NOT NULL,
  token_hash            TEXT NOT NULL UNIQUE,
  expires_at            TEXT NOT NULL,
  used_at               TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_parent_sign_in_tokens_student_user_id
  ON parent_sign_in_tokens(student_user_id);
CREATE INDEX idx_parent_sign_in_tokens_expires_at
  ON parent_sign_in_tokens(expires_at);

-- ---------------------------------------------------------------------------
-- parent_sessions — verified parent → one student, read-only
-- ---------------------------------------------------------------------------

CREATE TABLE parent_sessions (
  id                    TEXT PRIMARY KEY,
  student_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_email          TEXT NOT NULL,
  token_hash            TEXT NOT NULL UNIQUE,
  expires_at            TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_activity_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_parent_sessions_student_user_id
  ON parent_sessions(student_user_id);
CREATE INDEX idx_parent_sessions_expires_at
  ON parent_sessions(expires_at);
