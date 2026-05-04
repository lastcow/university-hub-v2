-- 0004_mfa.sql
--
-- TOTP-based multi-factor authentication for super_admin and
-- university_admin roles (epic UNI-21 / sub-issue UNI-24).
--
--   * `mfa_secret` — base32-encoded 160-bit shared secret. Stored in
--     plaintext; D1 storage is encrypted at rest. The secret never leaves
--     the worker after enrollment except in the otpauth URL returned ONCE
--     during enrollment.
--   * `mfa_enabled_at` — set when the user confirms their first TOTP code
--     during enroll. NULL means MFA is not yet active for the user.
--   * `mfa_recovery_codes_hash` — JSON array of SHA-256 hex digests, one
--     per recovery code. Codes are random 80-bit alphanumeric strings, so a
--     plain SHA-256 (the same scheme already used for session/invitation
--     tokens) is sufficient — there's no low-entropy password to protect.
--     Spec mentions "bcrypt-style hashes"; we keep the codebase dep-free
--     and use the existing crypto.subtle path, matching invitation-token.ts.
--
-- Recovery codes are single-use: when one matches, its digest is removed
-- from the JSON array on disk. When the array is empty, only TOTP works.

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN mfa_secret              TEXT;
ALTER TABLE users ADD COLUMN mfa_enabled_at          TEXT;
ALTER TABLE users ADD COLUMN mfa_recovery_codes_hash TEXT;

-- ---------------------------------------------------------------------------
-- mfa_challenges — short-lived "password verified, MFA pending" tokens.
--
-- Issued by /api/auth/sign-in for users whose role requires MFA. The raw
-- token is delivered as an HttpOnly cookie (`SameSite=None; Secure` in
-- prod, mirroring the session cookie); only its SHA-256 hash sits on disk.
-- Consumed by /api/auth/mfa/{enroll,verify-enroll,challenge}; on success
-- the challenge row is deleted and a real session cookie is issued.
-- ---------------------------------------------------------------------------
CREATE TABLE mfa_challenges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  ip_address  TEXT,
  user_agent  TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_mfa_challenges_user_id    ON mfa_challenges(user_id);
CREATE INDEX idx_mfa_challenges_expires_at ON mfa_challenges(expires_at);
