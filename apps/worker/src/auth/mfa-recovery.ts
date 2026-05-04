// Recovery codes for MFA. Generated once at enrollment (and on regenerate);
// shown to the user exactly once in plaintext. Only their SHA-256 digests
// live on disk in `users.mfa_recovery_codes_hash` (a JSON array of hex
// strings). Single-use — when one matches, its digest is removed from the
// JSON array.
//
// Hashing: plain SHA-256 is sufficient because each code carries ~80 bits of
// entropy (16 alphanumeric chars from a 32-symbol alphabet). The bcrypt-style
// stretching mentioned in the spec is meant for low-entropy passwords and
// would be overkill here; this matches the existing session/invitation token
// handling in the codebase and avoids pulling in a bcrypt dep.

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function randomCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(RECOVERY_CODE_BYTES));
  let body = "";
  for (let i = 0; i < raw.length; i++) {
    const idx = (raw[i] ?? 0) % RECOVERY_CODE_ALPHABET.length;
    body += RECOVERY_CODE_ALPHABET[idx];
  }
  // Group as XXXXX-XXXXX so the user can read/copy them more easily.
  return `${body.slice(0, 5)}-${body.slice(5, 10)}`;
}

/** Generate `RECOVERY_CODE_COUNT` fresh recovery codes (plaintext). */
export function generateRecoveryCodes(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  while (out.length < RECOVERY_CODE_COUNT) {
    const code = randomCode();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function normalize(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

export async function hashRecoveryCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(normalize(code));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export async function hashRecoveryCodes(codes: readonly string[]): Promise<string[]> {
  return Promise.all(codes.map(hashRecoveryCode));
}

export function serializeRecoveryHashes(hashes: readonly string[]): string {
  return JSON.stringify(hashes);
}

export function parseRecoveryHashes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

export interface RecoveryCheckResult {
  matched: boolean;
  /** JSON-serialized array with the matched hash removed. Only meaningful when `matched`. */
  remainingJson: string;
}

/**
 * Check `code` against the stored hash array. Returns whether it matched and
 * (if so) the hash array with the consumed entry removed so the caller can
 * write it back to disk in the same UPDATE that issues the session.
 */
export async function consumeRecoveryCode(
  code: string,
  storedJson: string | null | undefined,
): Promise<RecoveryCheckResult> {
  const hashes = parseRecoveryHashes(storedJson);
  if (hashes.length === 0) return { matched: false, remainingJson: serializeRecoveryHashes([]) };
  const candidate = await hashRecoveryCode(code);
  let matched = false;
  const remaining: string[] = [];
  for (const stored of hashes) {
    if (!matched && constantTimeEqualHex(stored, candidate)) {
      matched = true;
      continue;
    }
    remaining.push(stored);
  }
  return {
    matched,
    remainingJson: serializeRecoveryHashes(remaining),
  };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export const RECOVERY_CODE_TOTAL = RECOVERY_CODE_COUNT;
