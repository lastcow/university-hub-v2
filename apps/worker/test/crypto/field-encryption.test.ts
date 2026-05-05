// Field-level encryption helper unit tests (sub-issue UNI-51).
//
// Covers:
//   - Happy-path round trip.
//   - Same plaintext encrypts to different ciphertexts (random IV).
//   - Cross-university decryption fails (tenant binding).
//   - Master-key rotation invalidates pre-rotation ciphertexts.
//   - Malformed input fails closed.
//   - Missing master key fails closed on both encrypt and decrypt.
//   - Empty-string plaintext round-trips.

import { describe, expect, it } from "vitest";

import {
  decryptForUniversity,
  encryptForUniversity,
} from "../../src/crypto/field-encryption.js";

const MASTER = "master-key-A-".repeat(4); // arbitrary >=32 chars
const ROTATED_MASTER = "master-key-B-".repeat(4);

const ENV = { LMS_TOKEN_ENCRYPTION_KEY: MASTER };
const ROTATED_ENV = { LMS_TOKEN_ENCRYPTION_KEY: ROTATED_MASTER };
const NO_ENV = {} as { LMS_TOKEN_ENCRYPTION_KEY?: string };

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

describe("field-encryption: happy path", () => {
  it("round-trips a non-trivial token", async () => {
    const plaintext = "canvas-pat-9k3m2x.qrZ-7-secret_value";
    const encrypted = await encryptForUniversity(ENV, plaintext, UNI_A);
    const decrypted = await decryptForUniversity(ENV, encrypted, UNI_A);
    expect(decrypted).toBe(plaintext);
  });

  it("round-trips an empty string", async () => {
    const encrypted = await encryptForUniversity(ENV, "", UNI_A);
    const decrypted = await decryptForUniversity(ENV, encrypted, UNI_A);
    expect(decrypted).toBe("");
  });

  it("round-trips multibyte unicode", async () => {
    const plaintext = "🎓 Université de Montréal — secret 秘密";
    const encrypted = await encryptForUniversity(ENV, plaintext, UNI_A);
    const decrypted = await decryptForUniversity(ENV, encrypted, UNI_A);
    expect(decrypted).toBe(plaintext);
  });

  it("emits a different ciphertext on each call (random IV)", async () => {
    const plaintext = "same-token";
    const a = await encryptForUniversity(ENV, plaintext, UNI_A);
    const b = await encryptForUniversity(ENV, plaintext, UNI_A);
    expect(a).not.toBe(b);
    expect(await decryptForUniversity(ENV, a, UNI_A)).toBe(plaintext);
    expect(await decryptForUniversity(ENV, b, UNI_A)).toBe(plaintext);
  });
});

describe("field-encryption: tenant binding", () => {
  it("decrypts only with the same university id", async () => {
    const encrypted = await encryptForUniversity(ENV, "secret", UNI_A);
    await expect(
      decryptForUniversity(ENV, encrypted, UNI_B),
    ).rejects.toThrow();
  });

  it("two universities with the same plaintext produce different ciphertexts", async () => {
    const a = await encryptForUniversity(ENV, "shared", UNI_A);
    const b = await encryptForUniversity(ENV, "shared", UNI_B);
    expect(a).not.toBe(b);
  });
});

describe("field-encryption: master-key rotation", () => {
  it("rotated master cannot decrypt pre-rotation ciphertexts", async () => {
    const encrypted = await encryptForUniversity(ENV, "secret", UNI_A);
    await expect(
      decryptForUniversity(ROTATED_ENV, encrypted, UNI_A),
    ).rejects.toThrow();
  });

  it("the original master continues to decrypt the original ciphertext after a sibling rotation", async () => {
    const encrypted = await encryptForUniversity(ENV, "secret", UNI_A);
    // Encrypt fresh under the rotated master to demonstrate the two
    // worlds are independent…
    await encryptForUniversity(ROTATED_ENV, "secret", UNI_A);
    // …and the original ciphertext still decrypts under the original
    // master untouched.
    expect(await decryptForUniversity(ENV, encrypted, UNI_A)).toBe("secret");
  });
});

describe("field-encryption: malformed input", () => {
  it("rejects a payload shorter than the IV", async () => {
    // Two raw bytes, base64-encoded, is well below the 12-byte IV.
    await expect(
      decryptForUniversity(ENV, btoa("ab"), UNI_A),
    ).rejects.toThrow(/shorter than IV/);
  });

  it("rejects garbage base64 inside an otherwise reasonable shell", async () => {
    // 12-byte IV + 16-byte fake-tag — enough length to clear the IV
    // length guard; SubtleCrypto's tag check then trips.
    const fake = btoa("\x00".repeat(12) + "\x00".repeat(16));
    await expect(
      decryptForUniversity(ENV, fake, UNI_A),
    ).rejects.toThrow();
  });

  it("rejects non-base64 input", async () => {
    await expect(
      decryptForUniversity(ENV, "this is not base64 !!!", UNI_A),
    ).rejects.toThrow();
  });
});

describe("field-encryption: missing master key", () => {
  it("encrypt fails closed when LMS_TOKEN_ENCRYPTION_KEY is unset", async () => {
    await expect(
      encryptForUniversity(NO_ENV, "secret", UNI_A),
    ).rejects.toThrow(/LMS_TOKEN_ENCRYPTION_KEY/);
  });

  it("decrypt fails closed when LMS_TOKEN_ENCRYPTION_KEY is unset", async () => {
    const encrypted = await encryptForUniversity(ENV, "secret", UNI_A);
    await expect(
      decryptForUniversity(NO_ENV, encrypted, UNI_A),
    ).rejects.toThrow(/LMS_TOKEN_ENCRYPTION_KEY/);
  });

  it("encrypt fails closed when LMS_TOKEN_ENCRYPTION_KEY is empty", async () => {
    await expect(
      encryptForUniversity(
        { LMS_TOKEN_ENCRYPTION_KEY: "" },
        "secret",
        UNI_A,
      ),
    ).rejects.toThrow(/LMS_TOKEN_ENCRYPTION_KEY/);
  });
});
