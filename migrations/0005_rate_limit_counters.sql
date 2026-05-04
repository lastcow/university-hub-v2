-- 0005_rate_limit_counters.sql
--
-- Fixed-window counter table backing src/middleware/rate-limit.ts (epic
-- UNI-21 / sub-issue UNI-25). One row per (limiter, identifier) pair.
--
--   * `key`               — opaque SHA-256 hex digest of "<namespace>:<identifier>".
--                           Hashing avoids storing raw emails/IPs at rest.
--   * `count`             — attempts inside the active window.
--   * `window_started_at` — ms since epoch (INTEGER for fast comparisons).
--   * `expires_at`        — ms since epoch. Once <= now, the next consume
--                           call resets the row to count=1 with a fresh
--                           window. The retention sweep (sub-issue 12)
--                           will eventually purge stale rows; until then
--                           they're just overwritten on next use.
--
-- Approach: fixed window. Cheaper than a leaky bucket and accurate enough
-- to enforce the documented limits. For the "generic API" leaky-bucket
-- envelope (~120 req/min/session) we approximate with a 60s fixed window
-- — under sustained load the steady-state rate is identical; bursty
-- callers see a brief reset boundary every minute, which is fine.

PRAGMA foreign_keys = ON;

CREATE TABLE rate_limit_counters (
  key               TEXT PRIMARY KEY,
  count             INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX idx_rate_limit_counters_expires_at
  ON rate_limit_counters(expires_at);
