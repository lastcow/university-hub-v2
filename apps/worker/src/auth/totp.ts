// Time-based one-time password (RFC 6238) using HMAC-SHA1 (RFC 4226).
//
// Standard parameters: 30-second time step, 6 digits, SHA-1. Verification
// allows ±1 step of clock drift so a code accepted on the boundary still
// verifies if the user submitted it a second after it ticked.
//
// Dep-free: HMAC-SHA1 runs on Web Crypto (`crypto.subtle.sign`), which is
// available in Cloudflare Workers and in Node ≥ 20 (where the test suite
// runs). Secrets are kept as base32 strings on the wire and as 20 random
// bytes on disk (after decoding) — see auth/mfa-secret.ts for storage.

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_DEFAULT_WINDOW = 1;
const SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32EncodeBytes(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | (bytes[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0b11111];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0b11111];
  }
  return out;
}

function base32DecodeToBytes(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new Error(`Invalid base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Random 160-bit secret encoded as base32 (the canonical TOTP format). */
export function generateTotpSecret(): string {
  return base32EncodeBytes(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

interface OtpAuthUrlInput {
  secret: string;
  /** The user-visible label, typically `email` or `account@issuer`. */
  accountName: string;
  /** Issuer string, shown in the authenticator app (e.g. "University Hub"). */
  issuer: string;
}

/**
 * Build an `otpauth://totp/...` URL for the QR code. The format follows the
 * Google Authenticator key-uri spec; both Authy and 1Password parse it.
 */
export function buildOtpAuthUrl({ secret, accountName, issuer }: OtpAuthUrlInput): string {
  const label = `${issuer}:${accountName}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

function counterToBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  // JS bitwise ops are 32-bit; split the counter into hi/lo halves.
  let hi = Math.floor(counter / 0x1_0000_0000);
  let lo = counter >>> 0;
  for (let i = 7; i >= 4; i--) {
    bytes[i] = lo & 0xff;
    lo = lo >>> 8;
  }
  for (let i = 3; i >= 0; i--) {
    bytes[i] = hi & 0xff;
    hi = hi >>> 8;
  }
  return bytes;
}

async function hmacSha1(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message);
  return new Uint8Array(sig);
}

async function totpAtCounter(secretBase32: string, counter: number): Promise<string> {
  const key = base32DecodeToBytes(secretBase32);
  const mac = await hmacSha1(key, counterToBytes(counter));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  const otp = binary % 10 ** TOTP_DIGITS;
  return otp.toString().padStart(TOTP_DIGITS, "0");
}

/**
 * Generate the TOTP code for `secret` at the current 30-second step. The
 * `nowMs` argument is for tests; production passes nothing.
 */
export async function generateTotpCode(
  secretBase32: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  return totpAtCounter(secretBase32, counter);
}

/**
 * Constant-time string equality. JS `===` short-circuits on first mismatch,
 * which is fine for non-secrets but ugly for token comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a user-supplied TOTP code against `secret`. Accepts ±`window` time
 * steps either side of the current one (1 step = 30 seconds) so a code
 * submitted a second after it ticked still verifies.
 *
 * Returns `false` for any malformed input — never throws.
 */
export async function verifyTotpCode(
  secretBase32: string,
  code: string,
  nowMs: number = Date.now(),
  window: number = TOTP_DEFAULT_WINDOW,
): Promise<boolean> {
  const trimmed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  const center = Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    let candidate: string;
    try {
      candidate = await totpAtCounter(secretBase32, center + drift);
    } catch {
      return false;
    }
    if (constantTimeEqual(candidate, trimmed)) return true;
  }
  return false;
}

// Exported for tests; not part of the public surface.
export const _internal = {
  base32EncodeBytes,
  base32DecodeToBytes,
  counterToBytes,
};
