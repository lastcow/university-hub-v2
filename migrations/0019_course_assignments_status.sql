-- 0019_course_assignments_status.sql
--
-- Reconciliation engine (epic UNI-50 / sub-issue UNI-56). When the LMS
-- engine re-syncs a course, any prior `course_assignments` row for that
-- course whose external id no longer appears in the LMS roster is a
-- dropped enrollment. The issue body specifies a soft-delete (flip the
-- row to `dropped` with `last_synced_at = now()`) rather than a
-- physical DELETE so the audit trail and FERPA record-of-disclosure
-- chain stay intact.
--
-- This migration adds the status column. New rows default to 'active'
-- so existing manual + LMS rows light up correctly post-migration.
-- Dropped rows are written by the engine; nothing else flips this
-- column today.
--
-- Held to a small enum so the engine and the directories surfaces can
-- key off a closed type. If a future LMS workflow needs another
-- terminal state (e.g. 'graduated' / 'withdrawn') we extend the CHECK
-- in a follow-up migration.

PRAGMA foreign_keys = ON;

ALTER TABLE course_assignments
  ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dropped'));

CREATE INDEX idx_course_assignments_status ON course_assignments(status);
