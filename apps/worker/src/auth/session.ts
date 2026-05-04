// Session token lifecycle. Tokens are random bytes encoded base64url; only a
// SHA-256 hash of the token is stored in `sessions.token_hash`. The raw token
// only lives in the HttpOnly cookie sent to the browser. Lookup is by hash.
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
  password_hash: string;
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
  u_password_hash: string;
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

export async function hashSessionToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
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
  db: D1Database,
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const tokenHash = await hashSessionToken(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await execute(
    db,
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

/** Look up an active, non-expired session by raw token. Returns null otherwise. */
export async function resolveSessionByToken(
  db: D1Database,
  token: string,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const tokenHash = await hashSessionToken(token);
  const row = await queryFirst<SessionWithUserRow>(
    db,
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
    await deleteSessionByHash(db, tokenHash);
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

export async function deleteSessionByToken(db: D1Database, token: string): Promise<void> {
  if (!token) return;
  await deleteSessionByHash(db, await hashSessionToken(token));
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
