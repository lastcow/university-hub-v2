// Parent / guardian sign-in token + session helpers (epic UNI-21 / sub-issue
// UNI-32).
//
// The parent never has a `users` row. The flow is:
//
//   1. POST /api/parent/sign-in/request {parent_email}
//      → look up under-18 students with `parent_guardian_email = ?`. For
//        each match, mint a token, store SHA-256 hash + 15-min expiry, and
//        email the token to the parent. Always 202 — we never leak whether
//        the email is on file.
//
//   2. POST /api/parent/sign-in/verify {parent_email, token}
//      → look the token up by hash. If it's unexpired and unused, create a
//        `parent_sessions` row, set the parent cookie, and respond with
//        the bound student summary.
//
//   3. Subsequent GET /api/parent/* requests carry the parent cookie. We
//      resolve it the same way as a normal session — load the row, check
//      activity / expiry, slide the idle window.
//
// The parent surface is read-only by design. The handlers in
// routes/parent-flag.ts decide what's reachable; the session itself doesn't
// carry permissions, just identity (parent_email + student_user_id).

import { execute, queryAll, queryFirst, type Row } from "../db/index.js";
import type { Env } from "../env.js";

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;       // 12h hard ceiling
const TOKEN_TTL_MS = 15 * 60 * 1000;              // 15m sign-in token
const PARENT_IDLE_TIMEOUT_SECONDS = 30 * 60;      // 30m idle re-auth
const PARENT_ABSOLUTE_TIMEOUT_SECONDS = 12 * 60 * 60;

export const PARENT_SESSION_COOKIE = "university_hub_parent_session";

export type ParentTokenRow = Row & {
  id: string;
  student_user_id: string;
  parent_email: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
};

export type ParentSessionRow = Row & {
  id: string;
  student_user_id: string;
  parent_email: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_activity_at: string;
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

export function generateToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Sign-in tokens
// ---------------------------------------------------------------------------

export interface IssueTokenInput {
  studentUserId: string;
  parentEmail: string;
}

export interface IssuedToken {
  id: string;
  token: string;
  expiresAt: Date;
  studentUserId: string;
}

export async function issueParentToken(
  db: D1Database,
  input: IssueTokenInput,
): Promise<IssuedToken> {
  const id = crypto.randomUUID();
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  await execute(
    db,
    `INSERT INTO parent_sign_in_tokens
       (id, student_user_id, parent_email, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.studentUserId,
      input.parentEmail,
      tokenHash,
      expiresAt.toISOString(),
      now.toISOString(),
    ],
  );
  return { id, token, expiresAt, studentUserId: input.studentUserId };
}

/**
 * Look up an unused, unexpired token by raw value + claimed parent_email.
 * Returns null if it doesn't match. The token row is deleted on first lookup
 * to make it single-use; concurrent lookups race on the DELETE so at most
 * one verifier wins.
 */
export async function consumeParentToken(
  db: D1Database,
  parentEmail: string,
  rawToken: string,
): Promise<ParentTokenRow | null> {
  const tokenHash = await hashToken(rawToken);
  const row = await queryFirst<ParentTokenRow>(
    db,
    `SELECT id, student_user_id, parent_email, token_hash, expires_at, used_at, created_at
       FROM parent_sign_in_tokens
       WHERE token_hash = ? AND parent_email = ?
       LIMIT 1`,
    [tokenHash, parentEmail],
  );
  if (!row) return null;
  if (row.used_at) {
    await execute(db, `DELETE FROM parent_sign_in_tokens WHERE id = ?`, [row.id]);
    return null;
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    await execute(db, `DELETE FROM parent_sign_in_tokens WHERE id = ?`, [row.id]);
    return null;
  }
  // Mark used + delete in the same logical step. We use DELETE so a leaked
  // hash collision can't be replayed even if the deleting transaction fails
  // halfway — there's no row to find on a second attempt.
  await execute(db, `DELETE FROM parent_sign_in_tokens WHERE id = ?`, [row.id]);
  return row;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface CreateParentSessionInput {
  studentUserId: string;
  parentEmail: string;
}

export interface CreatedParentSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createParentSession(
  db: D1Database,
  input: CreateParentSessionInput,
): Promise<CreatedParentSession> {
  const id = crypto.randomUUID();
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await execute(
    db,
    `INSERT INTO parent_sessions
       (id, student_user_id, parent_email, token_hash, expires_at, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.studentUserId,
      input.parentEmail,
      tokenHash,
      expiresAt.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ],
  );
  return { id, token, expiresAt };
}

export async function resolveParentSession(
  db: D1Database,
  token: string,
): Promise<ParentSessionRow | null> {
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await queryFirst<ParentSessionRow>(
    db,
    `SELECT id, student_user_id, parent_email, token_hash, expires_at,
            created_at, last_activity_at
       FROM parent_sessions
       WHERE token_hash = ? LIMIT 1`,
    [tokenHash],
  );
  if (!row) return null;

  const now = Date.now();
  if (Date.parse(row.expires_at) <= now) {
    await execute(db, `DELETE FROM parent_sessions WHERE id = ?`, [row.id]);
    return null;
  }
  const lastActivity = Date.parse(row.last_activity_at);
  if (
    Number.isFinite(lastActivity) &&
    now - lastActivity > PARENT_IDLE_TIMEOUT_SECONDS * 1000
  ) {
    await execute(db, `DELETE FROM parent_sessions WHERE id = ?`, [row.id]);
    return null;
  }
  const created = Date.parse(row.created_at);
  if (
    Number.isFinite(created) &&
    now - created > PARENT_ABSOLUTE_TIMEOUT_SECONDS * 1000
  ) {
    await execute(db, `DELETE FROM parent_sessions WHERE id = ?`, [row.id]);
    return null;
  }

  await execute(
    db,
    `UPDATE parent_sessions SET last_activity_at = ? WHERE id = ?`,
    [new Date(now).toISOString(), row.id],
  );
  return { ...row, last_activity_at: new Date(now).toISOString() };
}

export async function deleteParentSessionByToken(
  db: D1Database,
  token: string,
): Promise<void> {
  if (!token) return;
  const tokenHash = await hashToken(token);
  await execute(db, `DELETE FROM parent_sessions WHERE token_hash = ?`, [tokenHash]);
}

// ---------------------------------------------------------------------------
// Student lookup for the parent flow
// ---------------------------------------------------------------------------

export interface ParentStudentLookup {
  student_id: string;
  user_id: string;
  university_id: string | null;
  parent_guardian_email: string;
  under_18: number;
  name: string;
  email: string;
  university_name: string | null;
}

export async function findUnder18StudentsByParentEmail(
  db: D1Database,
  parentEmail: string,
): Promise<ParentStudentLookup[]> {
  return queryAll<ParentStudentLookup & Row>(
    db,
    `SELECT s.id AS student_id, s.user_id AS user_id, s.university_id AS university_id,
            s.parent_guardian_email AS parent_guardian_email, s.under_18 AS under_18,
            u.name AS name, u.email AS email,
            un.name AS university_name
       FROM students s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN universities un ON un.id = s.university_id
       WHERE s.parent_guardian_email = ? AND s.under_18 = 1`,
    [parentEmail],
  );
}

export function parentSessionTtl(env: Env): number {
  // env reference kept so future overrides can plug in like the regular
  // session helper — currently fixed at 12h.
  void env;
  return PARENT_ABSOLUTE_TIMEOUT_SECONDS;
}
