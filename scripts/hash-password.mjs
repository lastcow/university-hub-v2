#!/usr/bin/env node
// Generates a PBKDF2-SHA256 hash in the same format the Worker auth module
// (apps/worker/src/auth/password.ts) produces.
//
// Usage:
//   node scripts/hash-password.mjs '<password>'
//
// Used to bake a known dev hash into migrations/0003_seed_dev_data.sql, and for
// the production bootstrap flow to mint the first super_admin password offline.

const ALGO = "SHA-256";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SCHEME = "pbkdf2-sha256";

const password = process.argv[2];
if (!password) {
  console.error("usage: node scripts/hash-password.mjs '<password>'");
  process.exit(1);
}

const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
const keyMaterial = await crypto.subtle.importKey(
  "raw",
  new TextEncoder().encode(password),
  "PBKDF2",
  false,
  ["deriveBits"],
);
const bits = new Uint8Array(
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: ALGO },
    keyMaterial,
    HASH_BYTES * 8,
  ),
);

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
process.stdout.write(`${SCHEME}$${ITERATIONS}$${b64(salt)}$${b64(bits)}\n`);
