// TOTP unit tests. Verifies the HMAC-SHA1 implementation against the test
// vectors in RFC 6238 Appendix B (the SHA-1 column) plus a few sanity tests
// for the base32 encoder and the otpauth URL builder.

import { describe, expect, it } from "vitest";

import {
  _internal,
  buildOtpAuthUrl,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode,
} from "../../src/auth/totp.js";

// Reference secret from RFC 6238 §B "12345678901234567890" (ASCII).
function asciiToBytes(s: string): Uint8Array {
  return Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
}

const RFC_SECRET_BYTES = asciiToBytes("12345678901234567890");
const RFC_SECRET_BASE32 = _internal.base32EncodeBytes(RFC_SECRET_BYTES);

// (time-seconds, expected 6-digit TOTP-SHA1) from RFC 6238 §B.
// The full 8-digit values from the RFC are truncated to the trailing 6
// digits here, since this implementation uses 6-digit codes.
const RFC_VECTORS: Array<[number, string]> = [
  [59, "287082"],
  [1111111109, "081804"],
  [1111111111, "050471"],
  [1234567890, "005924"],
  [2000000000, "279037"],
];

describe("TOTP RFC 6238 vectors (SHA-1, 6 digits, 30s)", () => {
  for (const [secs, expected] of RFC_VECTORS) {
    it(`generates ${expected} at t=${secs}`, async () => {
      const code = await generateTotpCode(RFC_SECRET_BASE32, secs * 1000);
      expect(code).toBe(expected);
    });
  }
});

describe("TOTP verify", () => {
  it("accepts the current code", async () => {
    const secret = generateTotpSecret();
    const now = 1700000000_000;
    const code = await generateTotpCode(secret, now);
    expect(await verifyTotpCode(secret, code, now)).toBe(true);
  });

  it("accepts a code from the previous step (clock drift)", async () => {
    const secret = generateTotpSecret();
    const now = 1700000000_000;
    const previous = await generateTotpCode(secret, now - 30_000);
    expect(await verifyTotpCode(secret, previous, now)).toBe(true);
  });

  it("rejects a code from two steps ago", async () => {
    const secret = generateTotpSecret();
    const now = 1700000000_000;
    const old = await generateTotpCode(secret, now - 90_000);
    expect(await verifyTotpCode(secret, old, now)).toBe(false);
  });

  it("rejects a wrong-length / non-numeric code without throwing", async () => {
    const secret = generateTotpSecret();
    expect(await verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(await verifyTotpCode(secret, "12345")).toBe(false);
    expect(await verifyTotpCode(secret, "")).toBe(false);
    expect(await verifyTotpCode(secret, "1234567")).toBe(false);
  });

  it("trims internal whitespace", async () => {
    const secret = generateTotpSecret();
    const now = 1700000000_000;
    const code = await generateTotpCode(secret, now);
    const padded = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(await verifyTotpCode(secret, padded, now)).toBe(true);
  });
});

describe("TOTP secret generation", () => {
  it("produces 32-character base32 strings (160 bits)", () => {
    for (let i = 0; i < 5; i++) {
      const s = generateTotpSecret();
      expect(s).toMatch(/^[A-Z2-7]+$/);
      expect(s.length).toBe(32);
    }
  });

  it("returns unique secrets across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateTotpSecret());
    expect(seen.size).toBe(50);
  });
});

describe("buildOtpAuthUrl", () => {
  it("renders the otpauth URI with the canonical query parameters", () => {
    const url = buildOtpAuthUrl({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "alice@example.com",
      issuer: "University Hub",
    });
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(url).toContain("issuer=University+Hub");
    expect(url).toContain("algorithm=SHA1");
    expect(url).toContain("digits=6");
    expect(url).toContain("period=30");
    expect(decodeURIComponent(url.split("?")[0]!)).toContain(
      "University Hub:alice@example.com",
    );
  });
});

describe("base32 round-trip", () => {
  it("encodes and decodes arbitrary byte sequences", () => {
    const cases = [
      Uint8Array.of(0),
      Uint8Array.of(0xff, 0xff, 0xff),
      asciiToBytes("Hello"),
      asciiToBytes("12345678901234567890"),
    ];
    for (const bytes of cases) {
      const encoded = _internal.base32EncodeBytes(bytes);
      const decoded = _internal.base32DecodeToBytes(encoded);
      expect(decoded.length).toBe(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        expect(decoded[i]).toBe(bytes[i]);
      }
    }
  });
});
