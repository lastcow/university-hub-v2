-- 0018_disclosure_log_basis.sql
--
-- Reconciliation engine (epic UNI-50 / sub-issue UNI-56). The LMS sync
-- engine creates `disclosure_log` rows for newly imported students to
-- satisfy FERPA §99.32 ("record of disclosure"). Those disclosures are
-- not consent-based — they ride the §99.31(a)(1) "school official"
-- exception that already governs the rest of the platform's
-- intra-institution data flow. The current schema (UNI-32 / 0008)
-- requires a non-null `consent_id` on every disclosure_log row, which
-- the engine cannot satisfy without inventing a per-student fake
-- consent.
--
-- Two changes:
--   1. `consent_id` becomes nullable so non-consent disclosures can be
--      recorded without a synthetic consent row.
--   2. New `basis` column captures the legal basis for each disclosure
--      ('consent', 'school_official_exception', 'directory_info',
--      'judicial_order', 'other'). Rows already in the table all
--      predate this column and were authorized via consent — they
--      backfill to 'consent'.
--
-- A row-level CHECK enforces the invariant that 'consent' rows carry a
-- non-null consent_id and non-consent rows leave it null. SQLite cannot
-- ALTER COLUMN to drop NOT NULL, so we use the table-recreate dance:
-- create the new shape, copy, drop, rename. FK is dropped during the
-- swap to keep the dance atomic — all references to disclosure_log are
-- audit-only and never followed at write time. PRAGMA foreign_keys is
-- restored at the end.

PRAGMA foreign_keys = OFF;

CREATE TABLE disclosure_log_new (
  id                    TEXT PRIMARY KEY,
  student_user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  university_id         TEXT REFERENCES universities(id) ON DELETE SET NULL,
  consent_id            TEXT REFERENCES disclosure_consents(id) ON DELETE RESTRICT,
  basis                 TEXT NOT NULL DEFAULT 'consent'
                        CHECK (basis IN (
                          'consent',
                          'school_official_exception',
                          'directory_info',
                          'judicial_order',
                          'other'
                        )),
  released_to           TEXT NOT NULL,
  data_categories       TEXT NOT NULL,
  notes                 TEXT,
  released_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  released_by_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  CHECK (
    (basis = 'consent' AND consent_id IS NOT NULL)
    OR (basis != 'consent' AND consent_id IS NULL)
  )
);

INSERT INTO disclosure_log_new
  (id, student_user_id, university_id, consent_id, basis,
   released_to, data_categories, notes, released_at, released_by_user_id)
SELECT
  id, student_user_id, university_id, consent_id, 'consent',
  released_to, data_categories, notes, released_at, released_by_user_id
FROM disclosure_log;

DROP TABLE disclosure_log;

ALTER TABLE disclosure_log_new RENAME TO disclosure_log;

CREATE INDEX idx_disclosure_log_student_user_id
  ON disclosure_log(student_user_id);
CREATE INDEX idx_disclosure_log_university_id
  ON disclosure_log(university_id);
CREATE INDEX idx_disclosure_log_consent_id
  ON disclosure_log(consent_id);
CREATE INDEX idx_disclosure_log_released_at
  ON disclosure_log(released_at);
CREATE INDEX idx_disclosure_log_basis
  ON disclosure_log(basis);

PRAGMA foreign_keys = ON;
