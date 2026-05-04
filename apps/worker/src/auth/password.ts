// PBKDF2-SHA256 password hashing using the Web Crypto API. Works identically
// in Cloudflare Workers and modern Node (Web Crypto is global in Node 20+).
//
// Hash format (single string, four `$`-separated parts):
//   pbkdf2-sha256$<iterations>$<salt-base64>$<hash-base64>
//
// This is the canonical implementation for both Worker auth (UNI-6) and the
// dev seed migration (UNI-4). See docs/database.md.

const ALGO = "SHA-256";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SCHEME = "pbkdf2-sha256";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: ALGO },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveBits(password, salt, ITERATIONS);
  return `${SCHEME}$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 4) return false;
  const [scheme, iterStr, saltB64, hashB64] = parts as [string, string, string, string];
  if (scheme !== SCHEME) return false;
  const iterations = Number.parseInt(iterStr, 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = base64ToBytes(saltB64);
  const expected = base64ToBytes(hashB64);
  const derived = await deriveBits(password, salt, iterations);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i++) diff |= (derived[i] ?? 0) ^ (expected[i] ?? 0);
  return diff === 0;
}
