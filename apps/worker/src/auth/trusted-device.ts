// "Remember this device" trusted-device store + cookie helpers (UNI-47).
//
// On a successful TOTP challenge a `university_admin` who ticked the
// "Remember this device" checkbox gets a `trusted_devices` row + a signed
// HttpOnly cookie. On subsequent sign-ins, after correct password, if BOTH
// the cookie hashes to a non-expired row AND the request IP matches the
// row's `ip_address`, we skip the TOTP challenge.
//
// Token shape: random 32 bytes, base64url on the wire, HMAC-SHA-256 of the
// raw token (keyed by `SESSION_SECRET`) on disk in `trusted_devices.token_hash`.
// Same construction as `auth/session.ts`; rotating `SESSION_SECRET` (the
// breach-containment lever from UNI-37) also invalidates every trusted-
// device row by failing re-derivation under the new key.
//
// Why HMAC instead of plain SHA-256: matches the session model so a single
// rotation lever — `SESSION_SECRET` — sweeps both surfaces. Otherwise an
// operator rotating the secret post-breach would still leave trusted-device
// rows resolvable and could re-skip MFA on a compromised endpoint.
//
// The bypass is `university_admin`-only. `super_admin` is always-MFA: the
// callers gate this and the issue/grant paths refuse to mint a row for any
// other role defensively.

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import type { Env } from "../env.js";

const TOKEN_BYTES = 32;

/**
 * Prefix marking a `trusted_devices.token_hash` value as a UNI-49
 * fingerprint-only row (one with no cookie minted). The remainder of the
 * value is a random uuid so each row carries a globally-unique value —
 * required because `token_hash` is `NOT NULL UNIQUE`. Earlier code used
 * the empty string as a single shared sentinel, which violated UNIQUE the
 * moment a second non-admin user (or the same user from a second device)
 * tried to write a fingerprint row and surfaced as a 500 from
 * `/api/auth/mfa/{verify-enroll,challenge}` (UNI-69).
 *
 * The prefix is intentionally non-hex so it cannot collide with a real
 * cookie hash (`hashTrustedDeviceToken` returns 64 hex chars). Combined
 * with the cookie resolver's `token_hash NOT LIKE 'fp_only:%'` filter it
 * is impossible for a request to resolve a fingerprint-only row through
 * the cookie path.
 */
export const FINGERPRINT_ONLY_TOKEN_PREFIX = "fp_only:";

/** Mint a unique sentinel for a fingerprint-only `trusted_devices` row. */
function generateFingerprintOnlyTokenHash(): string {
  return `${FINGERPRINT_ONLY_TOKEN_PREFIX}${crypto.randomUUID()}`;
}

/**
 * `true` for token_hash values that mark a fingerprint-only row (no
 * cookie was ever minted, so the row cannot be resolved by the UNI-47
 * cookie path). Recognises both the legacy empty-string sentinel and the
 * new uuid-suffixed sentinel introduced by UNI-69.
 */
export function isFingerprintOnlyTokenHash(tokenHash: string): boolean {
  return tokenHash === "" || tokenHash.startsWith(FINGERPRINT_ONLY_TOKEN_PREFIX);
}

export type TrustedDeviceRow = Row & {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
  // Risk-based MFA columns added by UNI-49 (migration 0014). All optional
  // because a row created before that migration ran (or a row that only
  // serves as a UNI-47 cookie-trust row) leaves them NULL.
  device_fingerprint_hash: string | null;
  label: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_mfa_at: string | null;
};

const SELECT_TRUSTED_DEVICE_COLUMNS = `id, user_id, token_hash, ip_address, user_agent,
            expires_at, created_at, last_used_at,
            device_fingerprint_hash, label, first_seen_at, last_seen_at, last_mfa_at`;

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

export function generateTrustedDeviceToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

function getSessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not configured; refusing to mint or resolve trusted-device tokens.",
    );
  }
  return secret;
}

/**
 * HMAC-SHA-256(secret, token), hex-encoded. The same construction
 * `auth/session.ts` uses for `sessions.token_hash`. Rotating
 * `SESSION_SECRET` invalidates every existing trusted-device row by
 * failing re-derivation under the new key.
 */
export async function hashTrustedDeviceToken(
  token: string,
  secret: string,
): Promise<string> {
  const keyMaterial = new TextEncoder().encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = new TextEncoder().encode(token);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return bytesToHex(new Uint8Array(sig));
}

export interface CreateTrustedDeviceInput {
  userId: string;
  ipAddress: string;
  userAgent?: string | null;
  trustWindowDays: number;
  /** UNI-49: server-side fingerprint hash. Captured at grant time so the
   *  next sign-in's risk gate can find this row without the cookie. */
  deviceFingerprintHash?: string | null;
  /** UNI-49: human label like "Chrome on macOS" — surfaced in the UI. */
  label?: string | null;
}

export interface CreatedTrustedDevice {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createTrustedDevice(
  env: Env,
  input: CreateTrustedDeviceInput,
): Promise<CreatedTrustedDevice> {
  const token = generateTrustedDeviceToken();
  const tokenHash = await hashTrustedDeviceToken(token, getSessionSecret(env));
  const id = crypto.randomUUID();
  const now = new Date();
  const ttlMs = input.trustWindowDays * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const nowIso = now.toISOString();
  await execute(
    env.DB,
    `INSERT INTO trusted_devices
       (id, user_id, token_hash, ip_address, user_agent, expires_at,
        created_at, last_used_at,
        device_fingerprint_hash, label, first_seen_at, last_seen_at, last_mfa_at)
     VALUES (?, ?, ?, ?, ?, ?,
             ?, NULL,
             ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      tokenHash,
      input.ipAddress,
      input.userAgent ?? null,
      expiresAt.toISOString(),
      nowIso,
      input.deviceFingerprintHash ?? null,
      input.label ?? null,
      nowIso,
      nowIso,
      nowIso,
    ],
  );
  return { id, token, expiresAt };
}

/**
 * UNI-49 risk-based MFA gate. Non-admin roles look up an existing
 * fingerprint row before deciding whether to challenge:
 *
 *   - row missing                      → unseen device, challenge
 *   - row.last_mfa_at < cutoff         → stale, challenge
 *   - otherwise                        → bypass + bump last_seen_at
 *
 * Returns the *latest* row for that fingerprint (newest `last_mfa_at`
 * first), so a user who toggles "trust this device" multiple times keeps
 * one logical row in front of the gate.
 */
export async function findTrustedDeviceByFingerprint(
  db: D1Database,
  userId: string,
  deviceFingerprintHash: string,
): Promise<TrustedDeviceRow | null> {
  return queryFirst<TrustedDeviceRow>(
    db,
    `SELECT ${SELECT_TRUSTED_DEVICE_COLUMNS}
       FROM trusted_devices
      WHERE user_id = ?
        AND device_fingerprint_hash = ?
      ORDER BY COALESCE(last_mfa_at, created_at) DESC
      LIMIT 1`,
    [userId, deviceFingerprintHash],
  );
}

/**
 * Insert a fingerprint-only "seen device" row OR refresh an existing row
 * for the same (user, fingerprint). Called by the MFA challenge / verify-
 * enroll handler on success so the next sign-in can skip MFA inside the
 * revalidation window. Does NOT mint a cookie or a token — this row is
 * pure server-side state.
 *
 * `expires_at` is set far in the future for fingerprint-only rows; the
 * decisive value is `last_mfa_at`. The row is still revocable from the
 * trusted-devices Settings page.
 */
export async function recordFingerprintMfaSuccess(
  db: D1Database,
  input: {
    userId: string;
    deviceFingerprintHash: string;
    label: string | null;
    ipAddress: string;
    userAgent: string | null;
  },
): Promise<{ id: string; isNew: boolean }> {
  const existing = await findTrustedDeviceByFingerprint(
    db,
    input.userId,
    input.deviceFingerprintHash,
  );
  const nowIso = new Date().toISOString();
  if (existing) {
    await execute(
      db,
      `UPDATE trusted_devices
          SET last_mfa_at = ?,
              last_seen_at = ?,
              ip_address = ?,
              user_agent = COALESCE(?, user_agent),
              label = COALESCE(?, label)
        WHERE id = ?`,
      [
        nowIso,
        nowIso,
        input.ipAddress,
        input.userAgent,
        input.label,
        existing.id,
      ],
    );
    return { id: existing.id, isNew: false };
  }
  // Fingerprint-only row: no cookie was minted. Token_hash carries a
  // unique `fp_only:<uuid>` sentinel — `token_hash` is `NOT NULL UNIQUE`,
  // so a shared empty-string sentinel collided the moment two different
  // (user, fingerprint) pairs needed rows (UNI-69). The prefix is non-hex
  // and the cookie resolver excludes it explicitly, so this row remains
  // unresolvable via the UNI-47 cookie surface.
  const id = crypto.randomUUID();
  // Far-future expiry so the existing UNI-47 expiry filter doesn't drop
  // the row before its natural revoke (Date.UTC year 9999 is the largest
  // value SQLite's strftime path will accept for ISO comparison).
  const farFuture = "9999-12-31T23:59:59.000Z";
  await execute(
    db,
    `INSERT INTO trusted_devices
       (id, user_id, token_hash, ip_address, user_agent, expires_at,
        created_at, last_used_at,
        device_fingerprint_hash, label, first_seen_at, last_seen_at, last_mfa_at)
     VALUES (?, ?, ?, ?, ?, ?,
             ?, NULL,
             ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      generateFingerprintOnlyTokenHash(),
      input.ipAddress,
      input.userAgent,
      farFuture,
      nowIso,
      input.deviceFingerprintHash,
      input.label,
      nowIso,
      nowIso,
      nowIso,
    ],
  );
  return { id, isNew: true };
}

export async function touchTrustedDeviceSeen(
  db: D1Database,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await execute(
    db,
    `UPDATE trusted_devices SET last_seen_at = ? WHERE id = ?`,
    [now.toISOString(), id],
  );
}

/**
 * Look up a non-expired trusted-device row by raw cookie value. Returns
 * `null` if the cookie is missing, malformed, expired, or there is no
 * matching row. Does NOT check IP — the caller does that against the
 * current request's IP after fetching the row, so we can audit the
 * difference between "no cookie at all" and "cookie matched but IP
 * rotated".
 */
export async function resolveTrustedDeviceByToken(
  env: Env,
  token: string,
): Promise<TrustedDeviceRow | null> {
  if (!token) return null;
  const tokenHash = await hashTrustedDeviceToken(token, getSessionSecret(env));
  // Defensively skip fingerprint-only sentinels. `hashTrustedDeviceToken`
  // returns a 64-char hex digest, so it can never `=` an `fp_only:<uuid>`
  // sentinel — but the explicit filter keeps the cookie path strictly
  // restricted to UNI-47 rows even if the hash function is ever changed.
  // The legacy `token_hash != ''` clause stays for any pre-UNI-69 rows.
  if (!tokenHash) return null;
  const row = await queryFirst<TrustedDeviceRow>(
    env.DB,
    `SELECT ${SELECT_TRUSTED_DEVICE_COLUMNS}
       FROM trusted_devices
      WHERE token_hash = ?
        AND token_hash != ''
        AND token_hash NOT LIKE 'fp_only:%'
      LIMIT 1`,
    [tokenHash],
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteTrustedDeviceByHash(env.DB, tokenHash);
    return null;
  }
  return row;
}

export async function touchTrustedDeviceLastUsed(
  db: D1Database,
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await execute(
    db,
    `UPDATE trusted_devices SET last_used_at = ? WHERE id = ?`,
    [now.toISOString(), id],
  );
}

async function deleteTrustedDeviceByHash(
  db: D1Database,
  tokenHash: string,
): Promise<void> {
  await execute(
    db,
    `DELETE FROM trusted_devices WHERE token_hash = ?`,
    [tokenHash],
  );
}

export async function deleteTrustedDeviceById(
  db: D1Database,
  id: string,
): Promise<void> {
  await execute(db, `DELETE FROM trusted_devices WHERE id = ?`, [id]);
}

/** All non-expired trusted-device rows for a user, newest first. */
export async function listTrustedDevicesForUser(
  db: D1Database,
  userId: string,
): Promise<TrustedDeviceRow[]> {
  return queryAll<TrustedDeviceRow>(
    db,
    `SELECT ${SELECT_TRUSTED_DEVICE_COLUMNS}
       FROM trusted_devices
      WHERE user_id = ?
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY created_at DESC`,
    [userId],
  );
}

/**
 * Count of non-expired trusted-device rows for a user. Surfaced by
 * `GET /api/auth/mfa/status` so the SPA can show "3 trusted devices"
 * without a second round-trip.
 */
export async function countTrustedDevicesForUser(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await queryFirst<Row & { c: number }>(
    db,
    `SELECT COUNT(*) AS c
       FROM trusted_devices
      WHERE user_id = ?
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [userId],
  );
  return row?.c ?? 0;
}

/**
 * Revoke every trusted-device row for a user. Returns the deleted ids so
 * the caller can write per-row audit entries (`mfa_trusted_device_revoked`).
 */
export async function revokeAllTrustedDevicesForUser(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const rows = await queryAll<TrustedDeviceRow>(
    db,
    `SELECT id FROM trusted_devices WHERE user_id = ?`,
    [userId],
  );
  if (rows.length === 0) return [];
  await execute(db, `DELETE FROM trusted_devices WHERE user_id = ?`, [userId]);
  return rows.map((r) => r.id);
}
