-- 0009_retention_archive.sql
--
-- Retention schedule + automated archival (epic UNI-21 / sub-issue UNI-33).
--
-- Defines `archived_<table>` shadow copies for tables whose rows graduate
-- out of the live database after a retention window expires. The retention
-- service (apps/worker/src/services/retention.ts, invoked by the nightly
-- cron in wrangler.toml) copies expiring rows into the matching archive
-- table — preserving the original primary key + every column, and
-- timestamping the move with `retention_archived_at` — and then deletes
-- them from the live table.
--
-- Why archive instead of hard-delete:
--   - FERPA does not mandate destruction; it leaves retention to the
--     institution. The pre-launch security review (epic UNI-21) chose to
--     archive rather than purge so that a later audit / legal request can
--     still surface a row without rebuilding the database from a backup.
--   - Each archive table is itself subject to an "ultimate retention"
--     window — see docs/data-retention.md for per-table specifics. The
--     same retention service purges archived rows once that window expires
--     (e.g. archived email logs purge after a year).
--
-- Schema convention:
--   - Mirror every column from the source table verbatim (same names,
--     same types) so an `INSERT OR IGNORE INTO archived_X SELECT ... FROM X`
--     statement copies cleanly.
--   - `retention_archived_at` is the only added column; defaults to now()
--     so back-fills (manual or migration-time) get a usable timestamp.
--   - Drop the source table's CHECK constraints and FOREIGN KEY clauses on
--     the archive copy. The archive is a tombstone; constraints would
--     prevent it from holding rows whose referenced parents were already
--     deleted (e.g. an audit_log row whose actor_user_id no longer exists
--     in `users`).
--   - Indexes mirror the source's most useful lookup paths plus
--     `retention_archived_at` for the post-archive purge sweep.
--
-- Idempotence:
--   - The retention service uses `INSERT OR IGNORE` so re-running the same
--     sweep on overlapping rows is a no-op. Combined with `DELETE FROM
--     <source> WHERE <cutoff>` running second, a partial failure leaves
--     the data eventually consistent without duplicates.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- archived_audit_logs — operational audit trail (FERPA implicit minimum 7y)
-- ---------------------------------------------------------------------------
CREATE TABLE archived_audit_logs (
  id                    TEXT PRIMARY KEY,
  university_id         TEXT,
  actor_user_id         TEXT,
  action                TEXT NOT NULL,
  entity_type           TEXT,
  entity_id             TEXT,
  metadata_json         TEXT,
  created_at            TEXT NOT NULL,
  retention_archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_archived_audit_logs_created_at
  ON archived_audit_logs(created_at);
CREATE INDEX idx_archived_audit_logs_retention
  ON archived_audit_logs(retention_archived_at);
CREATE INDEX idx_archived_audit_logs_university_id
  ON archived_audit_logs(university_id);

-- ---------------------------------------------------------------------------
-- archived_email_logs — operational email delivery records (90d → archive)
-- ---------------------------------------------------------------------------
CREATE TABLE archived_email_logs (
  id                    TEXT PRIMARY KEY,
  university_id         TEXT,
  recipient_email       TEXT NOT NULL,
  type                  TEXT NOT NULL,
  template_name         TEXT,
  status                TEXT NOT NULL,
  mailgun_message_id    TEXT,
  error                 TEXT,
  related_entity_type   TEXT,
  related_entity_id     TEXT,
  created_at            TEXT NOT NULL,
  retention_archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_archived_email_logs_created_at
  ON archived_email_logs(created_at);
CREATE INDEX idx_archived_email_logs_retention
  ON archived_email_logs(retention_archived_at);
CREATE INDEX idx_archived_email_logs_university_id
  ON archived_email_logs(university_id);

-- ---------------------------------------------------------------------------
-- archived_grades — educational records (FERPA: ~7y default post-graduation)
-- ---------------------------------------------------------------------------
CREATE TABLE archived_grades (
  id                    TEXT PRIMARY KEY,
  assessment_id         TEXT NOT NULL,
  student_user_id       TEXT NOT NULL,
  score                 REAL,
  letter_grade          TEXT,
  feedback              TEXT,
  status                TEXT NOT NULL,
  graded_by_user_id     TEXT,
  graded_at             TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  retention_archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_archived_grades_student_user_id
  ON archived_grades(student_user_id);
CREATE INDEX idx_archived_grades_assessment_id
  ON archived_grades(assessment_id);
CREATE INDEX idx_archived_grades_retention
  ON archived_grades(retention_archived_at);

-- ---------------------------------------------------------------------------
-- archived_assessments — educational records
-- ---------------------------------------------------------------------------
CREATE TABLE archived_assessments (
  id                    TEXT PRIMARY KEY,
  course_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  weight                REAL NOT NULL DEFAULT 0,
  max_score             REAL NOT NULL DEFAULT 100,
  due_at                TEXT,
  created_by            TEXT,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  retention_archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_archived_assessments_course_id
  ON archived_assessments(course_id);
CREATE INDEX idx_archived_assessments_retention
  ON archived_assessments(retention_archived_at);

-- ---------------------------------------------------------------------------
-- archived_course_assignments — educational records
-- ---------------------------------------------------------------------------
CREATE TABLE archived_course_assignments (
  id                    TEXT PRIMARY KEY,
  course_id             TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  role                  TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  retention_archived_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_archived_course_assignments_course_id
  ON archived_course_assignments(course_id);
CREATE INDEX idx_archived_course_assignments_user_id
  ON archived_course_assignments(user_id);
CREATE INDEX idx_archived_course_assignments_retention
  ON archived_course_assignments(retention_archived_at);

-- ---------------------------------------------------------------------------
-- archived_grade_access_log — FERPA §99.32 record-of-disclosure
-- ---------------------------------------------------------------------------
--
-- Mirrors `grade_access_log` from migration 0007. Same FERPA-implicit 7y
-- minimum applies: a record-of-access must outlast the record it covers.
CREATE TABLE archived_grade_access_log (
  id                     TEXT PRIMARY KEY,
  viewer_user_id         TEXT,
  viewer_role            TEXT NOT NULL,
  viewer_course_role     TEXT,
  course_id              TEXT,
  assessment_id          TEXT,
  viewed_grade_id        TEXT,
  viewed_student_user_id TEXT,
  context                TEXT NOT NULL,
  accessed_at            TEXT NOT NULL,
  retention_archived_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_archived_grade_access_log_accessed_at
  ON archived_grade_access_log(accessed_at);
CREATE INDEX idx_archived_grade_access_log_retention
  ON archived_grade_access_log(retention_archived_at);
CREATE INDEX idx_archived_grade_access_log_student
  ON archived_grade_access_log(viewed_student_user_id);
