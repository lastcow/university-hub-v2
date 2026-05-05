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

export type TrustedDeviceRow = Row & {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
};

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
  await execute(
    env.DB,
    `INSERT INTO trusted_devices
       (id, user_id, token_hash, ip_address, user_agent, expires_at, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      input.userId,
      tokenHash,
      input.ipAddress,
      input.userAgent ?? null,
      expiresAt.toISOString(),
      now.toISOString(),
    ],
  );
  return { id, token, expiresAt };
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
  const row = await queryFirst<TrustedDeviceRow>(
    env.DB,
    `SELECT id, user_id, token_hash, ip_address, user_agent,
            expires_at, created_at, last_used_at
       FROM trusted_devices
      WHERE token_hash = ?
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
    `SELECT id, user_id, token_hash, ip_address, user_agent,
            expires_at, created_at, last_used_at
       FROM trusted_devices
      WHERE user_id = ?
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY created_at DESC`,
    [userId],
  );
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
