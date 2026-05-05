-- 0024_lms_connections_external_user_id.sql
--
-- UNI-67 iteration 3.
--
-- Capture the connection owner's provider-native user id on the
-- connection row so reconciliation can match enrollments where the
-- enrolled user IS the operator who pasted the PAT — without that link,
-- the operator's own faculty/TA enrollments fail because their Hub
-- email (whatever they signed up with) almost never matches their
-- Canvas institutional email.
--
-- Concrete repro: the FSU operator (Hub email `ebiz@chen.me`, Canvas
-- login `zchen@frostburg.edu`, Canvas user.id `22620`) is the Teacher
-- on every term-245 course. Sync produced
-- `no_hub_user_for_teacher: ... email=zchen@frostburg.edu` for each of
-- those rows because Hub has no user with that email. Linking by
-- Canvas user.id sidesteps the email mismatch entirely.
--
-- Column is nullable for two reasons:
--   1) older connections predate this column and we don't have a
--      synchronous path to backfill them via Canvas without rerunning
--      `validatePersonalAccessToken` (which the connect flow already
--      does for new and re-saved connections, so future connections
--      always populate it).
--   2) non-Canvas providers may not expose a self-id at connect time.
-- Reconcile's match rule simply skips itself when the column is NULL.

ALTER TABLE lms_connections ADD COLUMN external_user_id TEXT;

CREATE INDEX idx_lms_connections_external_user_id
  ON lms_connections(provider_id, external_user_id);

-- Backfill the FSU operator's existing canvas connection. The
-- `users/self` lookup confirmed the Canvas user.id is 22620 for the
-- PAT currently stored on this row. A WHERE that finds no rows is a
-- no-op, so this is safe to apply on workspaces that don't have a
-- frostburg connection yet.
UPDATE lms_connections
   SET external_user_id = '22620',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE provider_id = 'canvas'
   AND base_url LIKE '%frostburg.instructure.com%'
   AND external_user_id IS NULL;
