// Field-level encryption helper (epic UNI-50 / sub-issue UNI-51).
//
// Every secret that lands in `lms_provider_configs` (OAuth client
// secret) and `lms_connections` (access + refresh tokens) sits on top
// of D1's at-rest encryption AND is wrapped here in an AES-GCM layer
// with a per-university key. That gives us:
//
//   1. A blast-radius bound. Compromise of one university's plaintext
//      tokens does not yield other universities' tokens — the keys are
//      derived per tenant via HKDF.
//   2. A meaningful rotation lever. Operators rotate the master
//      `LMS_TOKEN_ENCRYPTION_KEY` to invalidate every encrypted column
//      in one move (existing ciphertexts no longer decrypt under the
//      new master). The runbook in docs/encryption.md walks through the
//      re-encrypt-on-next-sync convergence path.
//
// On-the-wire format of the returned string is base64-encoded
// `iv (12 bytes) || ciphertext || tag (16 bytes)`. AES-GCM puts the
// authentication tag at the end of the SubtleCrypto output so the
// concatenation is just `iv || subtleOutput`. The IV is freshly
// random-generated per call (12 bytes / 96 bits, the AES-GCM
// standard-recommended length). With a per-tenant key the (key, iv)
// reuse probability is bounded by birthday-on-2^96, which is far below
// the operational risk threshold for the volume of LMS tokens stored.
//
// Crypto stack: Web Crypto only — no external deps. Both the Worker
// runtime and Node ≥ 20 (where the test suite runs) expose the same
// `crypto.subtle` API.

const ALGORITHM = "AES-GCM";
const IV_BYTES = 12;
const KEY_BITS = 256;
const HKDF_INFO_PREFIX = "university-hub.lms.field-encryption.v1:";

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

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Derive a per-university 256-bit AES-GCM key from the master and the
 * university id. HKDF-SHA-256 with university_id as both salt and
 * (suffix-mixed into) info. Salt-via-tenant-id binds the derived key to
 * the tenant — the same master against a different tenant id derives a
 * different key, so cross-university decrypt fails closed.
 *
 * The master is treated as raw bytes via UTF-8 encoding. Operators that
 * want to supply a pre-derived 32-byte master can hex-encode it; we
 * still HKDF over those bytes to keep the API surface uniform.
 */
async function deriveTenantKey(
  master: string,
  universityId: string,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const masterKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(master),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode(universityId),
      info: enc.encode(`${HKDF_INFO_PREFIX}${universityId}`),
    },
    masterKey,
    { name: ALGORITHM, length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

function readMasterKey(env: { LMS_TOKEN_ENCRYPTION_KEY?: string }): string {
  const value = env.LMS_TOKEN_ENCRYPTION_KEY;
  if (!value || value.length === 0) {
    throw new Error(
      "LMS_TOKEN_ENCRYPTION_KEY is not configured; refusing to encrypt or decrypt LMS tokens.",
    );
  }
  return value;
}

/**
 * Encrypt a plaintext field for storage. Returns base64 of
 * `iv || ciphertext || tag`. Caller stores the string verbatim in a
 * `*_encrypted` column.
 *
 * Empty plaintexts are valid — AES-GCM accepts a zero-length message
 * and returns just the tag. Callers that want "no value" should pass
 * `null` at their column instead and skip the call.
 */
export async function encryptForUniversity(
  env: { LMS_TOKEN_ENCRYPTION_KEY?: string },
  plaintext: string,
  universityId: string,
): Promise<string> {
  const key = await deriveTenantKey(readMasterKey(env), universityId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: ALGORITHM, iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  return bytesToBase64(concat(iv, ciphertextWithTag));
}

/**
 * Decrypt a stored value for the given university. Throws if the
 * ciphertext was produced under a different (master, universityId) —
 * the GCM tag check fails closed and SubtleCrypto raises an
 * `OperationError`. Callers should treat any throw here as a hard
 * failure: do NOT fall back to a previous master, and do NOT return
 * the ciphertext to the user.
 */
export async function decryptForUniversity(
  env: { LMS_TOKEN_ENCRYPTION_KEY?: string },
  encrypted: string,
  universityId: string,
): Promise<string> {
  const blob = base64ToBytes(encrypted);
  if (blob.length <= IV_BYTES) {
    throw new Error("Malformed encrypted field: payload shorter than IV.");
  }
  const iv = blob.subarray(0, IV_BYTES);
  const ciphertextWithTag = blob.subarray(IV_BYTES);
  const key = await deriveTenantKey(readMasterKey(env), universityId);
  const plaintextBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: ALGORITHM, iv },
      key,
      ciphertextWithTag,
    ),
  );
  return new TextDecoder().decode(plaintextBytes);
}

/** Test seam — exposes the key derivation so unit tests can verify
 *  rotation semantics without going through the full encrypt round
 *  trip. Not exported from the public package surface. */
export const _internal = { deriveTenantKey };
