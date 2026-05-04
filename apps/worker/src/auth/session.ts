// Session token lifecycle. Tokens are random bytes encoded base64url; only a
// SHA-256 hash of the token is stored in `sessions.token_hash`. The raw token
// only lives in the HttpOnly cookie sent to the browser. Lookup is by hash.
//
// Expiry: 30 days from creation. Expired sessions are rejected by the
// middleware and may be deleted lazily on miss.

import type { SessionUser, User, UserStatus } from "@university-hub/shared";

import { execute, queryFirst, type Row } from "../db/index.js";

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionRow = Row & {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
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
  expires_at: string;
  created_at: string;
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
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await execute(
    db,
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      tokenHash,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      expiresAt.toISOString(),
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
    `SELECT s.id, s.user_id, s.token_hash, s.expires_at, s.created_at,
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
      expires_at: row.expires_at,
      created_at: row.created_at,
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
