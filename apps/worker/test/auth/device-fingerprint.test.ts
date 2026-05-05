// Unit tests for the server-side device fingerprint helper (UNI-49).
//
// Fingerprint inputs: User-Agent (canonicalized to family + major version
// + OS), Accept-Language (primary tag), IP /16 prefix. Hash is HMAC-SHA-256
// keyed by SESSION_SECRET so rotation invalidates every existing
// fingerprint at the same time it invalidates sessions and trusted-
// device cookie tokens.

import { describe, expect, it } from "vitest";

import {
  computeDeviceFingerprint,
  deriveDeviceLabel,
  ipBucketForFingerprint,
} from "../../src/auth/device-fingerprint.js";
import type { Env } from "../../src/env.js";

const SESSION_SECRET = "test-session-secret-fixture";

function envFor(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    SESSION_SECRET,
    ...overrides,
  };
}

describe("ipBucketForFingerprint()", () => {
  it("collapses IPv4 to a /16", () => {
    expect(ipBucketForFingerprint("203.0.113.10")).toBe("203.0.0.0/16");
    expect(ipBucketForFingerprint("198.51.100.42")).toBe("198.51.0.0/16");
  });

  it("collapses IPv6 to the first 32 bits", () => {
    expect(ipBucketForFingerprint("2001:db8:abcd:1234::1")).toBe(
      "2001:db8::/32",
    );
  });

  it("returns a sentinel for empty / 0.0.0.0", () => {
    expect(ipBucketForFingerprint("")).toBe("ip:none");
    expect(ipBucketForFingerprint("0.0.0.0")).toBe("ip:unknown");
  });
});

describe("deriveDeviceLabel()", () => {
  it("identifies common browser + OS combinations", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.71 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/115.0",
      ),
    ).toBe("Firefox on Windows");
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
  });

  it("falls back to a generic label for unknown UAs", () => {
    expect(deriveDeviceLabel("totally-bogus")).toBe("Browser on Unknown OS");
    expect(deriveDeviceLabel(null)).toBe("Unknown device");
  });
});

describe("computeDeviceFingerprint()", () => {
  it("emits a stable HMAC-SHA-256 for the same inputs", async () => {
    const env = envFor();
    const a = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Mac",
      acceptLanguage: "en-US,en;q=0.9",
      ip: "203.0.113.10",
    });
    const b = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Mac",
      acceptLanguage: "en-US,en;q=0.9",
      ip: "203.0.113.10",
    });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(64);
    expect(a.hash).toMatch(/^[0-9a-f]+$/);
  });

  it("ignores patch-version drift in the User-Agent", async () => {
    // Browsers regularly bump their patch version (Chrome 120.0.6099 →
    // 120.0.6100); the fingerprint must keep matching so a Tuesday
    // sign-in doesn't re-MFA after a Monday auto-update.
    const env = envFor();
    const a = await computeDeviceFingerprint(env, {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.71 Safari/537.36",
      acceptLanguage: "en-US",
      ip: "203.0.113.10",
    });
    const b = await computeDeviceFingerprint(env, {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6100.99 Safari/537.36",
      acceptLanguage: "en-US",
      ip: "203.0.113.10",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("buckets across an adjacent /24 (same /16 ISP block)", async () => {
    // Mobile carriers and corporate VPNs hand out adjacent /24s under
    // the same /16. The fingerprint must absorb that hop-to-hop churn
    // so the user doesn't re-MFA every time their ISP rotates a NAT.
    const env = envFor();
    const a = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Linux",
      acceptLanguage: "en-US",
      ip: "203.0.10.1",
    });
    const b = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Linux",
      acceptLanguage: "en-US",
      ip: "203.0.99.255",
    });
    expect(a.hash).toBe(b.hash);
  });

  it("differs when the IP /16 prefix changes (different ISP / continent)", async () => {
    // The point of including IP at all is to refuse a bypass when the
    // user shows up on a totally different network. /16 absorbs ISP
    // churn but NOT a Comcast-vs-Vodafone swing.
    const env = envFor();
    const a = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Mac",
      acceptLanguage: "en-US",
      ip: "203.0.113.10",
    });
    const b = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Mac",
      acceptLanguage: "en-US",
      ip: "198.51.100.10",
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it("differs when the browser family changes (Chrome → Firefox)", async () => {
    const env = envFor();
    const a = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 Chrome/120 Mac",
      acceptLanguage: "en-US",
      ip: "203.0.113.10",
    });
    const b = await computeDeviceFingerprint(env, {
      userAgent: "Mozilla/5.0 (Macintosh) Firefox/115.0",
      acceptLanguage: "en-US",
      ip: "203.0.113.10",
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it("rotating SESSION_SECRET produces a different hash for the same inputs", async () => {
    const inputs = {
      userAgent: "Mozilla/5.0 Chrome/120 Mac",
      acceptLanguage: "en-US",
      ip: "203.0.113.10",
    };
    const a = await computeDeviceFingerprint(
      envFor({ SESSION_SECRET: "secret-a" }),
      inputs,
    );
    const b = await computeDeviceFingerprint(
      envFor({ SESSION_SECRET: "secret-b" }),
      inputs,
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it("fails closed when SESSION_SECRET is unset", async () => {
    const env = envFor({ SESSION_SECRET: undefined });
    await expect(
      computeDeviceFingerprint(env, {
        userAgent: "ua",
        acceptLanguage: null,
        ip: "203.0.113.10",
      }),
    ).rejects.toThrow(/SESSION_SECRET/);
  });
});
