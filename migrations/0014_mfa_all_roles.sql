-- 0014_mfa_all_roles.sql
--
-- Extend MFA to all authenticated roles with risk-based triggers
-- (epic UNI-21 / sub-issue UNI-49).
--
-- Up to UNI-47 the `trusted_devices` table only carried "Remember this
-- device" rows for `university_admin`: a signed cookie + exact-IP gate.
-- UNI-49 generalizes this surface so every non-admin role gets a
-- low-friction MFA experience driven by a *server-side device
-- fingerprint* (canonicalized User-Agent + Accept-Language + IP /16,
-- HMAC'd with SESSION_SECRET) instead of a long-lived cookie. A faculty
-- user signing in from the same browser within
-- `mfa_revalidation_days` (default 30) skips the TOTP challenge; a
-- previously-unseen fingerprint or a stale `last_mfa_at` triggers it.
--
-- Existing behavior preserved:
--
--   - The cookie-based bypass from UNI-47 still ships its row, just on
--     the same table; admins under UNI-49 are switched to "every-time
--     challenge" so the bypass for `university_admin` is intentionally
--     a no-op going forward (the row still exists for revoke / audit
--     consistency, but routes/auth.ts gates admin sign-ins to always
--     challenge).
--   - `token_hash` and `ip_address` stay NOT NULL on the existing
--     trusted_devices rows so the cookie path remains signature-checked
--     against an exact IP. New fingerprint-only rows store a token_hash
--     of "" (empty) until the user opts to "Trust this device" on the
--     non-admin challenge page; that grant fills `token_hash` in.
--
-- Risk-based fingerprint shape:
--
--   * device_fingerprint_hash — HMAC-SHA-256(SESSION_SECRET,
--     canonical_ua | accept_language | ip /16). Hex-encoded. Per-row,
--     so SESSION_SECRET rotation invalidates the trust on the next
--     sign-in just like sessions and cookie tokens.
--   * label — human-readable "Chrome on macOS" derived server-side
--     from the User-Agent. Surfaced in the Settings → Trusted devices
--     list so users can identify which row to revoke without parsing
--     a raw UA string.
--   * first_seen_at — when this fingerprint was first observed for
--     this user.
--   * last_seen_at — bumped on every sign-in that matches the row
--     (whether or not MFA was required).
--   * last_mfa_at — when the user last completed a successful MFA
--     challenge from this fingerprint. The risk decision tree compares
--     it against `now - mfa_revalidation_days` to decide whether a
--     sign-in is "fresh enough" to skip MFA.
--
-- Auditability: every grant / bypass / sweep continues to flow through
-- `audit_logs`. New `mfa.bypassed_via_revalidation_window` audit action
-- is added in shared/constants/audit-actions.ts (paired with the
-- existing `mfa.bypassed_via_trusted_device` so the audit-logs UI can
-- distinguish which gate let the sign-in through).

PRAGMA foreign_keys = ON;

-- New optional columns. SQLite (D1) does not support ALTER TABLE …
-- ALTER COLUMN; we intentionally keep the existing NOT NULL columns as-is
-- and add new optional columns alongside.
ALTER TABLE trusted_devices ADD COLUMN device_fingerprint_hash TEXT;
ALTER TABLE trusted_devices ADD COLUMN label                   TEXT;
ALTER TABLE trusted_devices ADD COLUMN first_seen_at           TEXT;
ALTER TABLE trusted_devices ADD COLUMN last_seen_at            TEXT;
ALTER TABLE trusted_devices ADD COLUMN last_mfa_at             TEXT;

-- Per-user fingerprint lookup. The bypass decision in routes/auth.ts
-- selects by (user_id, device_fingerprint_hash), so a covering index is
-- worth the write cost.
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_fp
  ON trusted_devices(user_id, device_fingerprint_hash);

-- Default revalidation window (30 days) lives in system_settings — same
-- pattern as `mfa_trusted_device_days` from UNI-47. Min 1 / max 365 are
-- enforced server-side in the settings handler. Reducing the value does
-- not retroactively shrink existing rows; the next sign-in past the
-- new window simply re-MFAs.
INSERT OR IGNORE INTO system_settings (key, value)
VALUES ('mfa_revalidation_days', '30');
