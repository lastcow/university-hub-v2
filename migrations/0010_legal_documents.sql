-- 0010_legal_documents.sql
--
-- Privacy policy + ToS surfaces (epic UNI-21 / sub-issue UNI-34).
--
--   * `legal_documents` — current-version per (university_id, kind) for
--     `terms` and `privacy`. A NULL `university_id` row is the global
--     default that every customer falls back to until an admin overrides
--     the boilerplate via the Legal tab in `/app/settings`. We don't keep
--     a versions history table — each edit bumps `version` in place and
--     the change is audit-logged via `legal.document_updated`, so the
--     audit_logs table is the durable record of who changed what when.
--
--   * `users.terms_accepted_at` / `users.terms_accepted_version` — the
--     latest ToS version a user has acknowledged. Set during invitation
--     acceptance (the checkbox); re-set when a forced re-acceptance
--     happens after an admin bumps the version. NULL means "never
--     accepted" (legacy seeded users from before this feature shipped, or
--     bootstrap super_admins).
--
-- Per-customer override semantics:
--   - When serving a public page or the in-app gate, look up the
--     active document via `university_id = ? AND kind = ?`. Fall back
--     to `university_id IS NULL AND kind = ?` (the global default) when
--     no per-customer row exists.
--   - The two unique partial indexes below enforce "one current row per
--     (university_id, kind)" while still allowing one global default per
--     kind. SQLite treats NULLs as distinct in plain UNIQUE constraints,
--     so we split into two partial indexes — one for the per-customer
--     space (NOT NULL) and one for the global slot (IS NULL).
--
-- Re-acceptance flow:
--   - When a customer admin saves an edit with `version_bump=true`, the
--     server increments `version`. On the next /api/legal/acknowledgment-
--     status read, users whose `terms_accepted_version` is below the
--     current version are flagged `required: true` and the SPA blocks the
--     app shell on a re-acceptance modal until they POST /api/legal/accept.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- legal_documents — current ToS / Privacy text per customer (or global default)
-- ---------------------------------------------------------------------------

CREATE TABLE legal_documents (
  id                  TEXT PRIMARY KEY,
  university_id       TEXT REFERENCES universities(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('terms','privacy')),
  version             INTEGER NOT NULL DEFAULT 1,
  body_md             TEXT NOT NULL,
  published_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per (university_id, kind) for actual customer rows.
CREATE UNIQUE INDEX idx_legal_documents_uni_kind
  ON legal_documents(university_id, kind)
  WHERE university_id IS NOT NULL;

-- One row per kind for the global default (university_id IS NULL).
CREATE UNIQUE INDEX idx_legal_documents_global_kind
  ON legal_documents(kind)
  WHERE university_id IS NULL;

CREATE INDEX idx_legal_documents_kind ON legal_documents(kind);

-- ---------------------------------------------------------------------------
-- users — record-of-acknowledgment columns
-- ---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE users ADD COLUMN terms_accepted_version INTEGER;
