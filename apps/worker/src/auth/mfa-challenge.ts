// "Password verified, MFA pending" challenge tokens. The shape mirrors
// auth/session.ts almost exactly — random 32 bytes, base64url on the wire,
// SHA-256 hash on disk — but the lifetime is 5 minutes instead of 30 days
// and the row lives in `mfa_challenges` instead of `sessions`. A successful
// MFA verification consumes the row and replaces it with a real session.

import { execute, queryFirst, type Row } from "../db/index.js";

const TOKEN_BYTES = 32;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type MfaChallengeRow = Row & {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
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

export function generateMfaChallengeToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export async function hashMfaChallengeToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export interface CreateMfaChallengeInput {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreatedMfaChallenge {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createMfaChallenge(
  db: D1Database,
  input: CreateMfaChallengeInput,
): Promise<CreatedMfaChallenge> {
  const token = generateMfaChallengeToken();
  const tokenHash = await hashMfaChallengeToken(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await execute(
    db,
    `INSERT INTO mfa_challenges (id, user_id, token_hash, ip_address, user_agent, expires_at)
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

export async function resolveMfaChallenge(
  db: D1Database,
  token: string,
): Promise<MfaChallengeRow | null> {
  if (!token) return null;
  const tokenHash = await hashMfaChallengeToken(token);
  const row = await queryFirst<MfaChallengeRow>(
    db,
    `SELECT id, user_id, token_hash, expires_at, created_at
       FROM mfa_challenges
      WHERE token_hash = ?
      LIMIT 1`,
    [tokenHash],
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteMfaChallengeByHash(db, tokenHash);
    return null;
  }
  return row;
}

export async function deleteMfaChallenge(db: D1Database, token: string): Promise<void> {
  if (!token) return;
  await deleteMfaChallengeByHash(db, await hashMfaChallengeToken(token));
}

async function deleteMfaChallengeByHash(db: D1Database, hash: string): Promise<void> {
  await execute(db, `DELETE FROM mfa_challenges WHERE token_hash = ?`, [hash]);
}

export async function deleteAllMfaChallengesForUser(
  db: D1Database,
  userId: string,
): Promise<void> {
  await execute(db, `DELETE FROM mfa_challenges WHERE user_id = ?`, [userId]);
}
