-- 0023_lms_sync_runs_drop_term_fk.sql
--
-- UNI-66 symptom 2 fix.
--
-- 0015's `lms_sync_runs` defined `term_id TEXT REFERENCES terms(id) ON
-- DELETE SET NULL`, modelling the column as a FK into the local
-- `terms` catalog. In practice the route layer (UNI-55) has always
-- written the *provider-native* term id (e.g. Canvas's enrollment
-- term id "245") into the column straight from the SPA's term picker,
-- and no code path populates `terms` rows during sync — so every
-- INSERT into `lms_sync_runs` blew up with
--
--   D1_ERROR: FOREIGN KEY constraint failed (SQLITE_CONSTRAINT_FOREIGNKEY)
--   at handleCreateLmsSyncRun (index.js:14206:3)
--
-- once a real Canvas connection landed (see UNI-66 issue body).
--
-- Fix: align the schema with what the column actually carries. The
-- `term_id` column on `lms_sync_runs` stores the provider-native term
-- id used to drive the sync; it is NOT a reference into the local
-- `terms` table. The reconciliation engine (UNI-56) reads it as an
-- external id and passes it back to the provider's
-- `listMyCourses(connection, termId)` call. Dropping the FK turns the
-- column into a free-text external id and unblocks every subsequent
-- sync.
--
-- SQLite does not support `ALTER TABLE ... DROP CONSTRAINT`, so the
-- standard rename-recreate-copy dance is required (per SQLite docs §7,
-- "Making Other Kinds Of Table Schema Changes"). Rows are preserved —
-- the column type and content are unchanged, only the FK is dropped —
-- so any historical sync_run rows that *did* land (with NULL term_id,
-- the only way the FK would have allowed an insert) survive.
--
-- The other two FKs on the table (`user_id` → `users(id)` and
-- `connection_id` → `lms_connections(id)`, both ON DELETE CASCADE) are
-- preserved verbatim — they're working as designed.

PRAGMA foreign_keys = OFF;

-- 1. Move the existing table aside.
ALTER TABLE lms_sync_runs RENAME TO lms_sync_runs_old;

-- 2. Recreate with the term_id FK removed; everything else verbatim.
CREATE TABLE lms_sync_runs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL REFERENCES lms_connections(id) ON DELETE CASCADE,
  -- Provider-native term id (e.g. Canvas's enrollment_term_id). Not a
  -- foreign key — the local `terms` catalog is populated through a
  -- separate manual / admin flow and is not the source of truth for
  -- the term cursor a sync runs against.
  term_id         TEXT,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at    TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','success','partial','failed')),
  summary_json    TEXT,
  error_log_json  TEXT
);

-- 3. Copy every row across; column order matches the new shape.
INSERT INTO lms_sync_runs
  (id, user_id, connection_id, term_id, started_at, completed_at,
   status, summary_json, error_log_json)
SELECT
  id, user_id, connection_id, term_id, started_at, completed_at,
  status, summary_json, error_log_json
FROM lms_sync_runs_old;

-- 4. Drop the old table.
DROP TABLE lms_sync_runs_old;

-- 5. Recreate the indexes from 0015 verbatim.
CREATE INDEX idx_lms_sync_runs_user_id       ON lms_sync_runs(user_id);
CREATE INDEX idx_lms_sync_runs_connection_id ON lms_sync_runs(connection_id);
CREATE INDEX idx_lms_sync_runs_term_id       ON lms_sync_runs(term_id);
CREATE INDEX idx_lms_sync_runs_status        ON lms_sync_runs(status);
CREATE INDEX idx_lms_sync_runs_started_at    ON lms_sync_runs(started_at);

PRAGMA foreign_keys = ON;
