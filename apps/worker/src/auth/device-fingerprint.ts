// Server-side device fingerprint for the risk-based MFA gate (UNI-49).
//
// Inputs:
//   - canonicalized User-Agent (browser family + major version + OS family)
//   - Accept-Language (first lang tag, lower-cased)
//   - IP /16 prefix (IPv4) or first 32 bits of an IPv6 address
//
// Hashing: HMAC-SHA-256(SESSION_SECRET, canonical_string), hex-encoded —
// same construction as `auth/session.ts`. Rotating SESSION_SECRET
// invalidates every existing fingerprint at the same time it invalidates
// sessions and trusted-device cookie tokens, which keeps the
// breach-runbook rotation lever consistent.
//
// Why /16 (and not /24 or exact IP) for non-admin roles:
//
//   - Mobile carriers and large ISPs hand out adjacent /24s under the
//     same /16, so /16 absorbs hop-to-hop NAT churn and corporate VPN
//     egress IPs without re-prompting the user.
//   - It does NOT absorb a swing across a different ISP / continent,
//     which is the actual signal we want to catch.
//   - Pure cookie-based bypass (UNI-47, admin-only) keeps an exact-IP
//     gate. The risk-based path here is for non-admins where we trade a
//     sliver of localized network-level confidence for fewer prompts.
//
// Fingerprints are NOT meant to be irrevocable identifiers — they are
// "is this the same browser+network shape" hints that the user can
// always sweep via Settings → Trusted devices. They never carry PII
// beyond what `audit_logs.ip_address` and `sessions.user_agent` already
// store, and the on-disk form is HMAC'd, not the raw concatenation.

import type { Env } from "../env.js";

export interface DeviceFingerprintInput {
  userAgent: string | null;
  acceptLanguage: string | null;
  ip: string;
}

export interface DeviceFingerprint {
  hash: string;
  label: string;
  ipBucket: string;
}

/**
 * Best-effort UA → "Chrome on macOS" label. Identifies the major browser
 * family and OS family from a User-Agent. Surfaced in the trusted-devices
 * UI; never used in the bypass decision (the hash captures that).
 *
 * Stays string-matching only — we do NOT pull in `ua-parser-js` etc., to
 * keep the worker dependency-free.
 */
export function deriveDeviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const browser = (() => {
    if (/Edg\//.test(ua)) return "Edge";
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Chrome\//.test(ua)) return "Chrome";
    if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return "Safari";
    if (/OPR\//.test(ua) || /Opera\//.test(ua)) return "Opera";
    return "Browser";
  })();
  const os = osFamily(ua);
  return `${browser} on ${os}`;
}

// iOS UAs include "Mac OS X" ("iPhone; CPU iPhone OS 17_0 like Mac OS X"),
// so iPhone / iPad / iPod must be checked BEFORE macOS or every iPhone
// label collapses to "Safari on macOS".
function osFamily(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Android/.test(ua)) return "Android";
  if (/Windows NT/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown OS";
}

function canonicalizeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "ua:none";
  // Strip kernel / build numbers that some browsers leak — the version
  // shouldn't change the fingerprint when only the patch version moves
  // (e.g. Chrome 120.0.6099 → 120.0.6100). Keep major version + OS family.
  const browser = (() => {
    const m =
      /(Edg|Firefox|Chrome|Safari|OPR|Opera)\/(\d+)/.exec(userAgent) ?? null;
    if (m) return `${m[1]}/${m[2]}`;
    return "ua";
  })();
  const os = osFamily(userAgent);
  return `${browser}|${os}`;
}

function canonicalizeAcceptLanguage(value: string | null): string {
  if (!value) return "lang:none";
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return "lang:none";
  // Normalize to the primary language tag — "en-US;q=0.9" → "en-us".
  return first.split(";")[0]?.trim() ?? "lang:none";
}

/**
 * IPv4 → "203.0.0.0/16". IPv6 → "2001:db8::/32". Empty / unknown → "ip:none".
 *
 * Falls back to the original string for shapes we don't recognize, which
 * mirrors how `truncateIp` in routes/sessions.ts handles malformed inputs.
 */
export function ipBucketForFingerprint(ip: string): string {
  const trimmed = ip.trim();
  if (!trimmed) return "ip:none";
  if (trimmed === "0.0.0.0") return "ip:unknown";
  if (trimmed.includes(".")) {
    const parts = trimmed.split(".");
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.0.0/16`;
    }
    return trimmed;
  }
  if (trimmed.includes(":")) {
    const blocks = trimmed.split(":").filter((b) => b.length > 0);
    if (blocks.length >= 2) {
      return `${blocks[0]}:${blocks[1]}::/32`;
    }
    return `${trimmed}/32`;
  }
  return trimmed;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function getSessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not configured; refusing to compute device fingerprints.",
    );
  }
  return secret;
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Compute the device fingerprint for a sign-in attempt. Returns the hash
 * (stored on `trusted_devices.device_fingerprint_hash`), the human label
 * (stored on `trusted_devices.label`), and the IP bucket (kept in memory
 * only — useful for audit metadata and tests).
 */
export async function computeDeviceFingerprint(
  env: Env,
  input: DeviceFingerprintInput,
): Promise<DeviceFingerprint> {
  const ua = canonicalizeUserAgent(input.userAgent);
  const lang = canonicalizeAcceptLanguage(input.acceptLanguage);
  const ipBucket = ipBucketForFingerprint(input.ip);
  const canonical = `${ua}|${lang}|${ipBucket}`;
  const hash = await hmacSha256Hex(getSessionSecret(env), canonical);
  return {
    hash,
    label: deriveDeviceLabel(input.userAgent),
    ipBucket,
  };
}
