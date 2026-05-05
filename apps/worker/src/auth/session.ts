// Session token lifecycle. Tokens are random bytes encoded base64url; only an
// HMAC-SHA-256 of the token (keyed by `SESSION_SECRET`) is stored in
// `sessions.token_hash`. The raw token only lives in the HttpOnly cookie sent
// to the browser. Lookup is by HMAC.
//
// Why HMAC-keyed and not plain SHA-256 (UNI-37): keying the hash with
// `SESSION_SECRET` means rotating the secret invalidates every existing
// `sessions.token_hash` because none of them re-derive to the same hash
// under the new key. That gives operators a second sign-everyone-out lever
// during S0/S1 containment in addition to `DELETE FROM sessions`. The two
// levers are independent and the runbook now uses both.
//
// Expiry layers (UNI-26):
//   - Absolute ceiling — `expires_at` (30 days from creation, set at insert).
//   - Absolute re-auth — even with continuous activity, sessions are forced
//     to re-authenticate after `SESSION_ABSOLUTE_TIMEOUT_SECONDS` measured
//     from `created_at` (default 12 hours).
//   - Idle — if `now - last_activity_at` exceeds
//     `SESSION_IDLE_TIMEOUT_SECONDS` (default 30 minutes) the session is
//     invalidated on the next request.
//
// Expired / timed-out sessions are deleted lazily by the middleware and an
// audit row (`session.revoked`, with the timeout reason) is written.

import type { SessionUser, User, UserStatus } from "@university-hub/shared";

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import type { Env } from "../env.js";

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEFAULT_IDLE_TIMEOUT_SECONDS = 30 * 60;
const DEFAULT_ABSOLUTE_TIMEOUT_SECONDS = 12 * 60 * 60;

function intEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function idleTimeoutSeconds(env: Env): number {
  return intEnv(env.SESSION_IDLE_TIMEOUT_SECONDS, DEFAULT_IDLE_TIMEOUT_SECONDS);
}

export function absoluteTimeoutSeconds(env: Env): number {
  return intEnv(
    env.SESSION_ABSOLUTE_TIMEOUT_SECONDS,
    DEFAULT_ABSOLUTE_TIMEOUT_SECONDS,
  );
}

export type SessionRow = Row & {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_activity_at: string;
};

export type UserRow = Row & {
  id: string;
  email: string;
  name: string;
  role: User["role"];
  status: UserStatus;
  university_id: string | null;
  // Nullable since UNI-61: anonymized (status='deleted') rows have their
  // credential material wiped to NULL. Every consumer that feeds this into
  // verifyPassword must null-check first and deny credential-shaped
  // operations the same way they deny a missing user.
  password_hash: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
};

type SessionWithUserRow = Row & {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_activity_at: string;
  u_id: string;
  u_email: string;
  u_name: string;
  u_role: User["role"];
  u_status: UserStatus;
  u_university_id: string | null;
  u_password_hash: string | null;
  u_last_sign_in_at: string | null;
  u_created_at: string;
  u_updated_at: string;
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

export function generateSessionToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/**
 * Resolve the session-signing key from the Worker env. We fail closed: if
 * `SESSION_SECRET` is not configured the auth surface refuses to mint or
 * resolve sessions rather than silently falling back to an unkeyed hash.
 * The deploy / provisioning pipeline (`scripts/provision-university.mjs`,
 * `docs/per-customer-provisioning.md`) sets this on first run.
 */
function getSessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not configured; refusing to mint or resolve sessions.",
    );
  }
  return secret;
}

/**
 * HMAC-SHA-256 of `token` keyed by `secret`, hex-encoded. This is what gets
 * stored in `sessions.token_hash`; the raw token never touches D1. Rotating
 * the secret changes the output for the same input, which is exactly how
 * rotation invalidates outstanding sessions during incident containment.
 */
export async function hashSessionToken(
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

export interface CreateSessionInput {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createSession(
  env: Env,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token, getSessionSecret(env));
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await execute(
    env.DB,
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      tokenHash,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ],
  );
  return { id, token, expiresAt };
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/** Look up an active, non-expired session by raw token. Returns null otherwise.
 *  After SESSION_SECRET rotation existing rows fail this lookup because the
 *  raw token no longer re-derives to the same `token_hash` — that's the
 *  rotation-invalidates-sessions property the runbook leans on. */
export async function resolveSessionByToken(
  env: Env,
  token: string,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const tokenHash = await hashSessionToken(token, getSessionSecret(env));
  const row = await queryFirst<SessionWithUserRow>(
    env.DB,
    `SELECT s.id, s.user_id, s.token_hash, s.ip_address, s.user_agent,
            s.expires_at, s.created_at, s.last_activity_at,
            u.id            AS u_id,
            u.email         AS u_email,
            u.name          AS u_name,
            u.role          AS u_role,
            u.status        AS u_status,
            u.university_id AS u_university_id,
            u.password_hash AS u_password_hash,
            u.last_sign_in_at AS u_last_sign_in_at,
            u.created_at    AS u_created_at,
            u.updated_at    AS u_updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
      LIMIT 1`,
    [tokenHash],
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteSessionByHash(env.DB, tokenHash);
    return null;
  }
  return {
    session: {
      id: row.id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      ip_address: row.ip_address,
      user_agent: row.user_agent,
      expires_at: row.expires_at,
      created_at: row.created_at,
      last_activity_at: row.last_activity_at ?? row.created_at,
    },
    user: {
      id: row.u_id,
      email: row.u_email,
      name: row.u_name,
      role: row.u_role,
      status: row.u_status,
      university_id: row.u_university_id,
      password_hash: row.u_password_hash,
      last_sign_in_at: row.u_last_sign_in_at,
      created_at: row.u_created_at,
      updated_at: row.u_updated_at,
    },
  };
}

export async function deleteSessionByToken(env: Env, token: string): Promise<void> {
  if (!token) return;
  await deleteSessionByHash(env.DB, await hashSessionToken(token, getSessionSecret(env)));
}

async function deleteSessionByHash(db: D1Database, tokenHash: string): Promise<void> {
  await execute(db, `DELETE FROM sessions WHERE token_hash = ?`, [tokenHash]);
}

/** Bump `last_activity_at` to `now` on the given session row. */
export async function touchSessionActivity(
  db: D1Database,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  await execute(
    db,
    `UPDATE sessions SET last_activity_at = ? WHERE id = ?`,
    [now.toISOString(), sessionId],
  );
}

export async function deleteSessionById(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  await execute(db, `DELETE FROM sessions WHERE id = ?`, [sessionId]);
}

export interface RevokableSession {
  id: string;
  created_at: string;
  last_activity_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

/** All sessions for a user, newest activity first. Used by the settings UI
 *  and by the role/status-change invalidation paths. */
export async function listSessionsForUser(
  db: D1Database,
  userId: string,
): Promise<RevokableSession[]> {
  const rows = await queryAll<Row & RevokableSession>(
    db,
    `SELECT id, created_at, last_activity_at, ip_address, user_agent
       FROM sessions
      WHERE user_id = ?
      ORDER BY last_activity_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    last_activity_at: r.last_activity_at ?? r.created_at,
    ip_address: r.ip_address,
    user_agent: r.user_agent,
  }));
}

/**
 * Revoke every session for a user, optionally keeping one (`exceptSessionId`).
 * Returns the ids that were deleted so the caller can write per-session
 * audit rows.
 */
export async function revokeAllSessionsForUser(
  db: D1Database,
  userId: string,
  exceptSessionId?: string | null,
): Promise<string[]> {
  const sessions = await listSessionsForUser(db, userId);
  const targets = exceptSessionId
    ? sessions.filter((s) => s.id !== exceptSessionId)
    : sessions;
  if (targets.length === 0) return [];
  for (const session of targets) {
    await deleteSessionById(db, session.id);
  }
  return targets.map((s) => s.id);
}

export function toSessionUser(user: UserRow): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    university_id: user.university_id,
  };
}
