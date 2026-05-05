-- 0015_lms.sql
--
-- LMS sync foundation (epic UNI-50 / sub-issue UNI-51). The issue body
-- specifies "0006_lms.sql" but slots 0006 onward have already been
-- consumed (session lifecycle, grades, FERPA, retention, legal,
-- escalation contacts, trusted devices, MFA-for-all-roles). We pick up
-- the next free slot and document the remap here, mirroring the
-- precedent set by 0007's header comment.
--
-- Slot history during this branch's lifecycle: this file was originally
-- written as 0014 while UNI-49 (MFA-for-all-roles) was in flight; that
-- branch landed on `main` first and consumed slot 0014, so this one
-- bumped to 0015 on rebase. No content changes — just the filename and
-- this header.
--
-- Substrate only — no Canvas-specific code yet (sub-issue UNI-52). What
-- ships here:
--
--   * `lms_provider_configs` — per-(university, provider) OAuth client
--     credentials supplied by a customer admin in the Settings →
--     Integrations admin tab. The shared secret is stored under
--     field-level encryption (apps/worker/src/crypto/field-encryption.ts);
--     D1 only ever sees the ciphertext.
--   * `lms_connections` — per-(user, provider) bearer credentials for the
--     LMS OAuth dance. Both access + refresh tokens are field-encrypted.
--     Status is a small enum so an expired or revoked connection can be
--     surfaced in the UI without deleting history.
--   * `terms` — manual-or-imported per-university term catalog. The same
--     row can carry an external_id from the LMS so re-syncs reconcile
--     against the same term across runs. The UNIQUE on
--     (university_id, provider_id, external_id) is partial — only
--     enforced when external_id is non-NULL — because manually-entered
--     terms have no external_id and SQLite would otherwise treat every
--     NULL as distinct (which is what we want for manual rows) BUT we
--     still need a deterministic dedupe key when external_id IS set.
--   * `lms_sync_runs` — append-only execution log for each sync attempt.
--     summary_json + error_log_json hold the structured per-run payload
--     so the UI's progress polling (sub-issue UNI-55) and the audit
--     surface can replay the run without rebuilding it from scratch.
--
-- Five existing tables get `external_provider` / `external_id` /
-- `last_synced_at` columns so reconciliation (sub-issue UNI-56) can
-- match LMS rows back to Hub rows on subsequent syncs. `source` columns
-- on `courses` + `course_assignments` track whether the row was created
-- manually or from a sync — manual rows survive re-syncs unchanged;
-- LMS rows are upsert targets and the user is warned before manual
-- edits to LMS-sourced rows are overwritten on the next pull.
--
-- D1 / SQLite types: booleans live as INTEGER 0/1 (consistent with
-- 0008_ferpa_controls.sql); timestamps are TEXT ISO-8601 strings.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- lms_provider_configs — per-(university, provider) OAuth client config.
-- ---------------------------------------------------------------------------
CREATE TABLE lms_provider_configs (
  id                       TEXT PRIMARY KEY,
  university_id            TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL
                           CHECK (provider_id IN (
                             'canvas','blackboard','moodle','google_classroom'
                           )),
  -- The LMS instance hostname (e.g. https://canvas.instructure.com or a
  -- self-hosted school deploy). Stored alongside the OAuth client so
  -- per-university Canvas tenants can each have their own URL.
  base_url                 TEXT NOT NULL,
  client_id                TEXT NOT NULL,
  -- Field-level encrypted under the per-university key (HKDF from
  -- LMS_TOKEN_ENCRYPTION_KEY + university_id). Format: base64 of
  -- `iv || ciphertext || tag`. See docs/encryption.md.
  client_secret_encrypted  TEXT NOT NULL,
  enabled                  INTEGER NOT NULL DEFAULT 1
                           CHECK (enabled IN (0, 1)),
  configured_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  configured_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (university_id, provider_id)
);

CREATE INDEX idx_lms_provider_configs_university_id
  ON lms_provider_configs(university_id);
CREATE INDEX idx_lms_provider_configs_enabled
  ON lms_provider_configs(enabled);

-- ---------------------------------------------------------------------------
-- lms_connections — per-(user, provider) OAuth bearer tokens.
-- ---------------------------------------------------------------------------
CREATE TABLE lms_connections (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id              TEXT NOT NULL
                           CHECK (provider_id IN (
                             'canvas','blackboard','moodle','google_classroom'
                           )),
  -- Mirrors the user's university for fast tenant-scoped queries (a
  -- user's `university_id` in the parent `users` row could in theory
  -- become NULL on archive). Set at insert; update if the user is
  -- re-homed.
  university_id            TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  base_url                 TEXT NOT NULL,
  -- Both tokens are field-level encrypted (see header). refresh_token
  -- is nullable because not every provider issues one (PAT fallback in
  -- Phase 2 also leaves this NULL).
  access_token_encrypted   TEXT NOT NULL,
  refresh_token_encrypted  TEXT,
  token_expires_at         TEXT,
  scope                    TEXT,
  status                   TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','expired','revoked')),
  last_synced_at           TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, provider_id)
);

CREATE INDEX idx_lms_connections_user_id       ON lms_connections(user_id);
CREATE INDEX idx_lms_connections_university_id ON lms_connections(university_id);
CREATE INDEX idx_lms_connections_status        ON lms_connections(status);

-- ---------------------------------------------------------------------------
-- terms — per-university academic-term catalog.
-- ---------------------------------------------------------------------------
CREATE TABLE terms (
  id            TEXT PRIMARY KEY,
  university_id TEXT NOT NULL REFERENCES universities(id) ON DELETE CASCADE,
  -- Provider that supplied this term, if any. NULL for manually-entered
  -- terms (the manual-term path stays open even after LMS launches so
  -- admins can backfill historical terms).
  provider_id   TEXT
                CHECK (provider_id IS NULL OR provider_id IN (
                  'canvas','blackboard','moodle','google_classroom'
                )),
  external_id   TEXT,
  name          TEXT NOT NULL,
  start_date    TEXT,
  end_date      TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1
                CHECK (is_active IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_terms_university_id ON terms(university_id);
CREATE INDEX idx_terms_is_active     ON terms(is_active);

-- Partial UNIQUE: only enforced for rows where the LMS supplied an
-- external_id. Manual rows (external_id IS NULL) can repeat a name
-- inside the same university without the index complaining.
CREATE UNIQUE INDEX idx_terms_external_unique
  ON terms(university_id, provider_id, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- lms_sync_runs — append-only execution log for each sync attempt.
-- ---------------------------------------------------------------------------
CREATE TABLE lms_sync_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL REFERENCES lms_connections(id) ON DELETE CASCADE,
  term_id         TEXT REFERENCES terms(id) ON DELETE SET NULL,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','success','partial','failed')),
  -- Structured per-run summary + error log (TEXT JSON). The UI's
  -- progress polling (sub-issue UNI-55) reads `summary_json` to render
  -- counts of courses / students touched; `error_log_json` carries any
  -- per-row errors that downgraded the run to `partial`.
  summary_json    TEXT,
  error_log_json  TEXT
);

CREATE INDEX idx_lms_sync_runs_user_id       ON lms_sync_runs(user_id);
CREATE INDEX idx_lms_sync_runs_connection_id ON lms_sync_runs(connection_id);
CREATE INDEX idx_lms_sync_runs_term_id       ON lms_sync_runs(term_id);
CREATE INDEX idx_lms_sync_runs_status        ON lms_sync_runs(status);
CREATE INDEX idx_lms_sync_runs_started_at    ON lms_sync_runs(started_at);

-- ---------------------------------------------------------------------------
-- courses — external linkage + source tracking.
--
-- `source` defaults to 'manual' so existing rows light up correctly
-- after the migration (everything in the table today predates LMS).
-- New columns are nullable except `source`, which has a default and a
-- check constraint.
-- ---------------------------------------------------------------------------
ALTER TABLE courses ADD COLUMN external_provider  TEXT
  CHECK (external_provider IS NULL OR external_provider IN (
    'canvas','blackboard','moodle','google_classroom'
  ));
ALTER TABLE courses ADD COLUMN external_id        TEXT;
ALTER TABLE courses ADD COLUMN external_term_id   TEXT;
ALTER TABLE courses ADD COLUMN last_synced_at     TEXT;
ALTER TABLE courses ADD COLUMN source             TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','lms'));

CREATE INDEX idx_courses_external_lookup
  ON courses(external_provider, external_id);

-- ---------------------------------------------------------------------------
-- students — external linkage so re-sync reconciles back to the same row.
-- ---------------------------------------------------------------------------
ALTER TABLE students ADD COLUMN external_provider TEXT
  CHECK (external_provider IS NULL OR external_provider IN (
    'canvas','blackboard','moodle','google_classroom'
  ));
ALTER TABLE students ADD COLUMN external_id       TEXT;
ALTER TABLE students ADD COLUMN last_synced_at    TEXT;

CREATE INDEX idx_students_external_lookup
  ON students(external_provider, external_id);

-- ---------------------------------------------------------------------------
-- users — external linkage. Only set for users created by the
-- reconciliation engine for a previously-unknown LMS student/teacher;
-- pre-existing Hub users matched by email keep these columns NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN external_provider TEXT
  CHECK (external_provider IS NULL OR external_provider IN (
    'canvas','blackboard','moodle','google_classroom'
  ));
ALTER TABLE users ADD COLUMN external_id       TEXT;

CREATE INDEX idx_users_external_lookup
  ON users(external_provider, external_id);

-- ---------------------------------------------------------------------------
-- course_assignments — external linkage + source tracking.
-- ---------------------------------------------------------------------------
ALTER TABLE course_assignments ADD COLUMN external_provider TEXT
  CHECK (external_provider IS NULL OR external_provider IN (
    'canvas','blackboard','moodle','google_classroom'
  ));
ALTER TABLE course_assignments ADD COLUMN external_id       TEXT;
ALTER TABLE course_assignments ADD COLUMN source            TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','lms'));
ALTER TABLE course_assignments ADD COLUMN last_synced_at    TEXT;

CREATE INDEX idx_course_assignments_external_lookup
  ON course_assignments(external_provider, external_id);
