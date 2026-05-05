-- 0016_lms_auth_method.sql
--
-- Follow-up to 0015_lms.sql (epic UNI-50 / sub-issue UNI-51). Lands as
-- its own migration because 0015 already shipped on `main` (PR #71); we
-- never edit a merged migration in place.
--
-- Reason: the user surfaced a real Canvas test target that exposes a
-- Personal Access Token instead of OAuth. PAT auth was originally
-- Phase 2 in the epic — this small schema change pulls it into Phase 1
-- so the Canvas provider in UNI-52 can authenticate either way.
--
-- One column added to `lms_connections`:
--
--   * `auth_method` TEXT, CHECK IN ('oauth', 'pat'). Defaults to 'oauth'
--     so existing rows stay valid. PAT connections will set this to
--     'pat' AND leave `refresh_token_encrypted` NULL — the column is
--     already nullable on 0015's table definition, so no further schema
--     change is required for that side of the contract.
--
-- The `LmsProvider` interface is unchanged: it accepts both OAuth and
-- PAT inputs through the same `authenticate(creds, providerConfig)`
-- entrypoint (creds.personal_access_token is set when the user supplies
-- a PAT instead of an OAuth code). Phase 1 stays read-only — write
-- methods (push grades / assignments to the LMS) come in Phase 4 as a
-- separate provider extension, not as additions to this interface.

PRAGMA foreign_keys = ON;

ALTER TABLE lms_connections
  ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'oauth'
    CHECK (auth_method IN ('oauth', 'pat'));

CREATE INDEX idx_lms_connections_auth_method
  ON lms_connections(auth_method);
