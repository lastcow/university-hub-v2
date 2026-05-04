// Recovery code tests. Format, hashing, single-use semantics, and the
// JSON round-trip helpers.

import { describe, expect, it } from "vitest";

import {
  RECOVERY_CODE_TOTAL,
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  hashRecoveryCodes,
  parseRecoveryHashes,
  serializeRecoveryHashes,
} from "../../src/auth/mfa-recovery.js";

describe("generateRecoveryCodes", () => {
  it("produces RECOVERY_CODE_TOTAL unique XXXXX-XXXXX codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_TOTAL);
    const seen = new Set<string>();
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      seen.add(c);
    }
    expect(seen.size).toBe(RECOVERY_CODE_TOTAL);
  });

  it("avoids visually-confusing characters (0/O, 1/I/L)", () => {
    for (const c of generateRecoveryCodes()) {
      expect(c).not.toMatch(/[01OIL]/);
    }
  });
});

describe("hashRecoveryCode", () => {
  it("is deterministic and case/dash-insensitive", async () => {
    const a = await hashRecoveryCode("ABCDE-FGHIJ");
    const b = await hashRecoveryCode("abcde-fghij");
    const c = await hashRecoveryCode("ABCDEFGHIJ");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it("produces distinct hashes for distinct codes", async () => {
    const a = await hashRecoveryCode("AAAAA-BBBBB");
    const b = await hashRecoveryCode("AAAAA-BBBBC");
    expect(a).not.toBe(b);
  });
});

describe("consumeRecoveryCode", () => {
  it("matches a stored code, removes it, and won't match again", async () => {
    const codes = generateRecoveryCodes();
    const stored = serializeRecoveryHashes(await hashRecoveryCodes(codes));

    const first = await consumeRecoveryCode(codes[0]!, stored);
    expect(first.matched).toBe(true);
    expect(parseRecoveryHashes(first.remainingJson)).toHaveLength(
      codes.length - 1,
    );

    const second = await consumeRecoveryCode(codes[0]!, first.remainingJson);
    expect(second.matched).toBe(false);
  });

  it("returns matched=false (and an empty array) for null/empty input", async () => {
    const res = await consumeRecoveryCode("ABCDE-FGHIJ", null);
    expect(res.matched).toBe(false);
    expect(parseRecoveryHashes(res.remainingJson)).toEqual([]);
  });

  it("ignores formatting differences when matching", async () => {
    const codes = generateRecoveryCodes();
    const stored = serializeRecoveryHashes(await hashRecoveryCodes(codes));
    const target = codes[3]!.toLowerCase().replace("-", " ");
    const res = await consumeRecoveryCode(target, stored);
    expect(res.matched).toBe(true);
  });

  it("rejects codes that don't match any stored hash", async () => {
    const codes = generateRecoveryCodes();
    const stored = serializeRecoveryHashes(await hashRecoveryCodes(codes));
    const res = await consumeRecoveryCode("ZZZZZ-ZZZZZ", stored);
    expect(res.matched).toBe(false);
    expect(parseRecoveryHashes(res.remainingJson)).toHaveLength(codes.length);
  });
});

describe("parseRecoveryHashes", () => {
  it("returns [] for null / undefined / malformed JSON / non-arrays", () => {
    expect(parseRecoveryHashes(null)).toEqual([]);
    expect(parseRecoveryHashes(undefined)).toEqual([]);
    expect(parseRecoveryHashes("")).toEqual([]);
    expect(parseRecoveryHashes("nope")).toEqual([]);
    expect(parseRecoveryHashes('{"foo": 1}')).toEqual([]);
  });

  it("filters non-string entries", () => {
    expect(parseRecoveryHashes('["abc", 123, null, "def"]')).toEqual([
      "abc",
      "def",
    ]);
  });
});
