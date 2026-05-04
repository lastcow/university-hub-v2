import { describe, expect, it } from "vitest";

import {
  generateInvitationToken,
  hashInvitationToken,
} from "../../src/auth/invitation-token.js";

describe("invitation token", () => {
  it("generates url-safe tokens", () => {
    const token = generateInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes -> 43 base64url chars (no padding)
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it("produces unique tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateInvitationToken());
    expect(seen.size).toBe(100);
  });

  it("hashes deterministically", async () => {
    const token = "fixed-test-token-value";
    const a = await hashInvitationToken(token);
    const b = await hashInvitationToken(token);
    expect(a).toBe(b);
    // SHA-256 hex = 64 chars
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it("differs across tokens", async () => {
    const a = await hashInvitationToken("alpha");
    const b = await hashInvitationToken("beta");
    expect(a).not.toBe(b);
  });
});
