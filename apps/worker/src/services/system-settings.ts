// Tiny key/value lookup over the `system_settings` table — runtime-editable
// scalar configuration that doesn't fit the per-university `universities`
// row or the per-user `users` row.
//
// Today this is exclusively used by the UNI-47 trusted-device feature:
//
//   - `mfa_trusted_device_days` (integer, 1..90, default 30) — the rolling
//     window for "Remember this device" trust grants. super_admin-only edits.
//
// Single-tenant per deploy means there's no university_id scoping; one row
// per key. Edits flow through a super_admin-gated route handler that audits
// to `audit_logs` (action `settings.updated`, scope `system`).

import { execute, queryFirst, type Row } from "../db/index.js";

export const MFA_TRUSTED_DEVICE_DAYS_KEY = "mfa_trusted_device_days";
export const MFA_TRUSTED_DEVICE_DAYS_DEFAULT = 30;
export const MFA_TRUSTED_DEVICE_DAYS_MIN = 1;
export const MFA_TRUSTED_DEVICE_DAYS_MAX = 90;

// UNI-49: revalidation window for the risk-based MFA gate. Non-admin
// roles skip the TOTP challenge when the device fingerprint matched a
// row whose `last_mfa_at` is within this many days. Default 30; the cap
// is wider than `mfa_trusted_device_days` because the failure mode
// (stale-window re-prompt) is less severe than a stale cookie.
export const MFA_REVALIDATION_DAYS_KEY = "mfa_revalidation_days";
export const MFA_REVALIDATION_DAYS_DEFAULT = 30;
export const MFA_REVALIDATION_DAYS_MIN = 1;
export const MFA_REVALIDATION_DAYS_MAX = 365;

type SettingRow = Row & {
  key: string;
  value: string;
};

export async function getSystemSettingString(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await queryFirst<SettingRow>(
    db,
    `SELECT key, value FROM system_settings WHERE key = ? LIMIT 1`,
    [key],
  );
  return row?.value ?? null;
}

export async function setSystemSettingString(
  db: D1Database,
  key: string,
  value: string,
  updatedByUserId: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  await execute(
    db,
    `INSERT INTO system_settings (key, value, updated_by_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`,
    [key, value, updatedByUserId, now, now],
  );
}

/**
 * Read the configured trusted-device trust window in days. Falls back to
 * `MFA_TRUSTED_DEVICE_DAYS_DEFAULT` if the row is missing (deploys that
 * skipped the seed) or unparseable; out-of-range values are clamped into
 * `[MFA_TRUSTED_DEVICE_DAYS_MIN, MFA_TRUSTED_DEVICE_DAYS_MAX]`.
 */
export async function getMfaTrustedDeviceDays(db: D1Database): Promise<number> {
  const raw = await getSystemSettingString(db, MFA_TRUSTED_DEVICE_DAYS_KEY);
  return parseTrustedDeviceDays(raw);
}

export function parseTrustedDeviceDays(raw: string | null): number {
  if (raw == null) return MFA_TRUSTED_DEVICE_DAYS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return MFA_TRUSTED_DEVICE_DAYS_DEFAULT;
  if (n < MFA_TRUSTED_DEVICE_DAYS_MIN) return MFA_TRUSTED_DEVICE_DAYS_MIN;
  if (n > MFA_TRUSTED_DEVICE_DAYS_MAX) return MFA_TRUSTED_DEVICE_DAYS_MAX;
  return n;
}

/**
 * Read the configured risk-based MFA revalidation window in days
 * (UNI-49). Same fallback behavior as `getMfaTrustedDeviceDays`.
 */
export async function getMfaRevalidationDays(db: D1Database): Promise<number> {
  const raw = await getSystemSettingString(db, MFA_REVALIDATION_DAYS_KEY);
  return parseRevalidationDays(raw);
}

export function parseRevalidationDays(raw: string | null): number {
  if (raw == null) return MFA_REVALIDATION_DAYS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return MFA_REVALIDATION_DAYS_DEFAULT;
  if (n < MFA_REVALIDATION_DAYS_MIN) return MFA_REVALIDATION_DAYS_MIN;
  if (n > MFA_REVALIDATION_DAYS_MAX) return MFA_REVALIDATION_DAYS_MAX;
  return n;
}
