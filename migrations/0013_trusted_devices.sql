-- 0013_trusted_devices.sql
--
-- "Remember this device" trusted-device MFA bypass for `university_admin`
-- (epic UNI-21 / sub-issue UNI-47).
--
-- After a successful TOTP challenge a `university_admin` can opt to skip
-- MFA on subsequent sign-ins from the same device for a configurable
-- window. The bypass requires BOTH a signed device-trust cookie AND an
-- exact IP match (pure IP is too weak for mobile / hotel WiFi / NAT /
-- VPN). `super_admin` is always-MFA — the option is never offered for
-- those sessions and the bypass code path refuses them defensively.
--
-- Storage shape mirrors `sessions` / `mfa_challenges`: only the
-- HMAC-SHA-256 of the raw cookie value (keyed by `SESSION_SECRET`, the
-- same key UNI-37 wired into session integrity) sits on disk. The raw
-- token only lives in the HttpOnly cookie sent to the browser. Rotating
-- `SESSION_SECRET` therefore invalidates every existing trusted-device
-- row at the same time it invalidates outstanding sessions, which keeps
-- the breach-runbook rotation lever consistent.
--
-- One row per device per user. `expires_at` is computed at grant time
-- from the current `mfa_trusted_device_days` setting; reducing the
-- setting later does NOT retroactively shrink existing rows (that would
-- be a confusing UX where an admin "resetting" the window kicks every
-- existing trust off; instead the docs explain the new value only
-- applies to newly-granted trusts).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- trusted_devices
-- ---------------------------------------------------------------------------
CREATE TABLE trusted_devices (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- HMAC-SHA-256(SESSION_SECRET, raw_token), hex-encoded. Same construction
  -- as sessions.token_hash; rotation of SESSION_SECRET invalidates every
  -- row by failing re-derivation under the new key.
  token_hash      TEXT NOT NULL UNIQUE,
  -- Exact IP captured at grant time. The bypass requires the request IP
  -- to match this value byte-for-byte; any rotation (new home IP, mobile
  -- handoff, VPN exit) falls through to the normal TOTP challenge.
  ip_address      TEXT NOT NULL,
  -- Free-text user-agent string captured at grant. Surfaced in the
  -- "Trusted devices" management UI so users can identify which row to
  -- revoke; never used in the bypass decision.
  user_agent      TEXT,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Updated whenever a bypass actually consumes this row. Surfaces in
  -- the UI ("last used 3 days ago") so users can spot rows that haven't
  -- been touched in a while and revoke them.
  last_used_at    TEXT
);

CREATE INDEX idx_trusted_devices_user_id    ON trusted_devices(user_id);
CREATE INDEX idx_trusted_devices_expires_at ON trusted_devices(expires_at);

-- ---------------------------------------------------------------------------
-- system_settings — runtime-editable single-tenant scalar settings.
--
-- Single-tenant per deploy means we don't carry a `university_id`; one
-- row per setting key per deploy. Edits are super_admin-only and audited
-- via `audit_logs` (action `settings.updated`, scope `system`).
-- ---------------------------------------------------------------------------
CREATE TABLE system_settings (
  key                TEXT PRIMARY KEY,
  value              TEXT NOT NULL,
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO system_settings (key, value)
VALUES ('mfa_trusted_device_days', '30');
