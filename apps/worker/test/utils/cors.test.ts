// Tests for the CORS middleware that gates the API-only Worker.
//
// The Worker no longer ships static assets — the SPA lives on a separate
// Cloudflare Pages origin and every browser fetch is cross-origin, so the
// CORS rules are part of the auth boundary. These tests verify:
//   - exact-match origins are echoed back with credentials enabled,
//   - wildcard subdomain rules accept Pages preview URLs,
//   - disallowed origins do NOT receive Allow-Origin / Allow-Credentials,
//   - localhost is included by default in dev,
//   - OPTIONS preflight returns 204 with the right Allow-* headers.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import {
  buildPreflightResponse,
  corsHeaders,
  matchAllowedOrigin,
  withCors,
} from "../../src/utils/cors.js";

function envWith(overrides: Partial<Env>): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_NAME: "University Hub",
    ...overrides,
  } as Env;
}

const PROD = (allowed: string) =>
  envWith({ APP_ENV: "production", ALLOWED_WEB_ORIGINS: allowed });

const DEV = (allowed = "") =>
  envWith({ APP_ENV: "development", ALLOWED_WEB_ORIGINS: allowed });

function reqWithOrigin(origin: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://api.example.workers.dev/api/auth/me", {
    ...init,
    headers,
  });
}

describe("matchAllowedOrigin", () => {
  it("echoes an exact-match production origin", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("https://university-hub-v2-web.pages.dev");
    expect(matchAllowedOrigin(env, req)).toBe(
      "https://university-hub-v2-web.pages.dev",
    );
  });

  it("rejects a similar-but-different origin", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("https://evil.pages.dev");
    expect(matchAllowedOrigin(env, req)).toBeNull();
  });

  it("accepts a Pages preview via wildcard subdomain", () => {
    const env = PROD("https://*.university-hub-v2-web.pages.dev");
    const req = reqWithOrigin(
      "https://abc123.university-hub-v2-web.pages.dev",
    );
    expect(matchAllowedOrigin(env, req)).toBe(
      "https://abc123.university-hub-v2-web.pages.dev",
    );
  });

  it("does NOT accept a multi-label spoof of a wildcard subdomain", () => {
    // `*.foo.com` must NOT match `evil.attacker.com.foo.com`-style hosts.
    const env = PROD("https://*.university-hub-v2-web.pages.dev");
    const req = reqWithOrigin(
      "https://evil.attacker.university-hub-v2-web.pages.dev",
    );
    expect(matchAllowedOrigin(env, req)).toBeNull();
  });

  it("rejects http when the rule is https", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("http://university-hub-v2-web.pages.dev");
    expect(matchAllowedOrigin(env, req)).toBeNull();
  });

  it("returns null when the request has no Origin header", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin(null);
    expect(matchAllowedOrigin(env, req)).toBeNull();
  });

  it("supports multiple comma-separated entries", () => {
    const env = PROD(
      "https://university-hub-v2-web.pages.dev, https://hub.example.com",
    );
    expect(
      matchAllowedOrigin(env, reqWithOrigin("https://hub.example.com")),
    ).toBe("https://hub.example.com");
    expect(
      matchAllowedOrigin(
        env,
        reqWithOrigin("https://university-hub-v2-web.pages.dev"),
      ),
    ).toBe("https://university-hub-v2-web.pages.dev");
  });

  it("includes http://localhost:5173 by default in dev", () => {
    const env = DEV();
    const req = reqWithOrigin("http://localhost:5173");
    expect(matchAllowedOrigin(env, req)).toBe("http://localhost:5173");
  });

  it("does NOT include localhost in production unless explicitly listed", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("http://localhost:5173");
    expect(matchAllowedOrigin(env, req)).toBeNull();
  });
});

describe("corsHeaders", () => {
  it("attaches Access-Control-Allow-Origin + credentials for matched origins", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const headers = corsHeaders(
      env,
      reqWithOrigin("https://university-hub-v2-web.pages.dev"),
    );
    expect(headers["access-control-allow-origin"]).toBe(
      "https://university-hub-v2-web.pages.dev",
    );
    expect(headers["access-control-allow-credentials"]).toBe("true");
    expect(headers.vary).toContain("Origin");
  });

  it("omits Allow-Origin / Allow-Credentials for disallowed origins (Vary stays)", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const headers = corsHeaders(env, reqWithOrigin("https://evil.example.com"));
    expect(headers["access-control-allow-origin"]).toBeUndefined();
    expect(headers["access-control-allow-credentials"]).toBeUndefined();
    expect(headers.vary).toContain("Origin");
  });
});

describe("withCors", () => {
  it("preserves Set-Cookie and other existing headers when mixing in CORS", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("https://university-hub-v2-web.pages.dev");
    const original = new Response(JSON.stringify({ ok: true }), {
      headers: {
        "set-cookie": "university_hub_session=abc; HttpOnly; SameSite=None; Secure",
        "content-type": "application/json",
      },
    });
    const wrapped = withCors(original, env, req);
    expect(wrapped.headers.get("set-cookie")).toContain("university_hub_session=abc");
    expect(wrapped.headers.get("access-control-allow-origin")).toBe(
      "https://university-hub-v2-web.pages.dev",
    );
    expect(wrapped.headers.get("content-type")).toBe("application/json");
  });

  it("merges Vary: Origin into an existing Vary header", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("https://university-hub-v2-web.pages.dev");
    const original = new Response(null, {
      headers: { vary: "Accept-Encoding" },
    });
    const wrapped = withCors(original, env, req);
    const vary = wrapped.headers.get("vary") ?? "";
    expect(vary).toContain("Accept-Encoding");
    expect(vary).toContain("Origin");
  });
});

describe("buildPreflightResponse", () => {
  it("returns 204 with full Allow-* headers for matched origins", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin(
      "https://university-hub-v2-web.pages.dev",
      {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type, authorization",
        },
      },
    );
    const res = buildPreflightResponse(env, req);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://university-hub-v2-web.pages.dev",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods") ?? "").toContain(
      "POST",
    );
    expect(res.headers.get("access-control-allow-headers") ?? "").toContain(
      "content-type",
    );
    expect(res.headers.get("access-control-max-age")).toBe("600");
  });

  it("returns a body-less 204 with no Allow-Origin for disallowed origins", () => {
    const env = PROD("https://university-hub-v2-web.pages.dev");
    const req = reqWithOrigin("https://evil.example.com", {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST" },
    });
    const res = buildPreflightResponse(env, req);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });
});
