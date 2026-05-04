-- 0006_session_lifecycle.sql
--
-- Session lifecycle hardening (epic UNI-21 / sub-issue UNI-26).
--
-- Adds `last_activity_at` to `sessions` so the auth middleware can enforce
-- idle + absolute timeouts. The middleware updates this column on every
-- authenticated request; `created_at` continues to anchor the absolute
-- 12-hour ceiling.
--
-- Backfill: existing rows are seeded with their `created_at` value so the
-- idle-timeout calculation has a sane starting point. Sessions older than
-- the 12-hour absolute window will still be invalidated on the first
-- post-deploy request — that is desired behavior (pre-launch posture, no
-- real students yet). The backfill only spares sessions that were created
-- inside the absolute window from being immediately idle-expired on top.
--
-- The `idx_sessions_user_id` index added in 0001 already covers the
-- "all sessions for a user" path used by the manual-revoke,
-- sign-out-all-devices, and role/status-change invalidation flows.

PRAGMA foreign_keys = ON;

ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;

UPDATE sessions SET last_activity_at = created_at WHERE last_activity_at IS NULL;

CREATE INDEX idx_sessions_last_activity_at ON sessions(last_activity_at);
