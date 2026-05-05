// Integration tests for the worker's top-level CORS layer (UNI-65).
//
// Hits the worker's exported `fetch` handler — not route handlers directly
// — so a regression that strips the global CORS wrap (e.g. a future route
// shuffle that re-mounts a sub-router without re-applying middleware)
// surfaces here. The route-level tests in `routes/*.test.ts` short-circuit
// the entrypoint, so this file is the one that catches a missing
// `Access-Control-Allow-Origin` header on a real cross-origin response.
//
// The handlers all call `requireAuth` first, so without a session cookie
// every protected route returns 401 without touching D1. A 401 is fine
// here — what we assert is that the response carries the expected CORS
// headers regardless of outcome.
//
// The wildcard origin coverage exercises the `https://*.<project>.pages.dev`
// pattern that Cloudflare emits for per-deploy preview URLs. The CORS
// allowlist must accept those alongside the canonical alias, otherwise
// freshly-deployed Pages URLs (the ones QA hands the FSU operator) trip
// the browser's CORS policy and the SPA can't read the response body.

import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const PROD_ORIGIN = "https://university-hub-v2-web.pages.dev";
const PREVIEW_ORIGIN = "https://abc123.university-hub-v2-web.pages.dev";
const DISALLOWED_ORIGIN = "https://evil.example.com";
const UUID = "00000000-0000-0000-0000-000000000000";

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_NAME: "University Hub",
    APP_ENV: "production",
    ALLOWED_WEB_ORIGINS:
      "https://university-hub-v2-web.pages.dev,https://*.university-hub-v2-web.pages.dev",
  } as unknown as Env;
}

const NOOP_CTX = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function buildRequest(
  method: string,
  pathname: string,
  origin: string,
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(`https://api.example.workers.dev${pathname}`, {
    method,
    headers: {
      origin,
      ...(extraHeaders ?? {}),
    },
  });
}

interface RouteCase {
  method: string;
  pathname: string;
}

// Every `/api/lms/*` surface registered in `src/index.ts`. Adding a new LMS
// route should also add an entry here so the CORS-coverage assertion
// remains exhaustive — a new route that isn't in this list won't fail the
// regression test even if it's missing CORS, which is exactly the failure
// mode UNI-65 was opened to prevent.
const LMS_ROUTES: RouteCase[] = [
  { method: "GET", pathname: "/api/lms/provider-configs" },
  { method: "POST", pathname: "/api/lms/provider-configs" },
  { method: "GET", pathname: "/api/lms/provider-configs/enabled" },
  { method: "DELETE", pathname: `/api/lms/provider-configs/${UUID}` },
  { method: "GET", pathname: "/api/lms/connections" },
  { method: "POST", pathname: "/api/lms/connections/canvas" },
  { method: "POST", pathname: `/api/lms/connections/${UUID}/disconnect` },
  { method: "GET", pathname: `/api/lms/connections/${UUID}/terms` },
  { method: "GET", pathname: "/api/lms/sync-runs" },
  { method: "POST", pathname: "/api/lms/sync-runs" },
  { method: "POST", pathname: "/api/lms/sync-runs/preview" },
  { method: "GET", pathname: `/api/lms/sync-runs/${UUID}` },
];

describe("CORS coverage on /api/lms/* (UNI-65)", () => {
  for (const route of LMS_ROUTES) {
    it(`${route.method} ${route.pathname} echoes Allow-Origin for the canonical Pages alias`, async () => {
      const res = await worker.fetch!(
        buildRequest(route.method, route.pathname, PROD_ORIGIN),
        envFor(),
        NOOP_CTX,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("vary") ?? "").toContain("Origin");
    });

    it(`${route.method} ${route.pathname} echoes Allow-Origin for a Pages preview deploy`, async () => {
      const res = await worker.fetch!(
        buildRequest(route.method, route.pathname, PREVIEW_ORIGIN),
        envFor(),
        NOOP_CTX,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe(
        PREVIEW_ORIGIN,
      );
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it(`${route.method} ${route.pathname} omits Allow-Origin for a disallowed origin`, async () => {
      const res = await worker.fetch!(
        buildRequest(route.method, route.pathname, DISALLOWED_ORIGIN),
        envFor(),
        NOOP_CTX,
      );
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      // Vary still reflects Origin so caches don't collapse responses.
      expect(res.headers.get("vary") ?? "").toContain("Origin");
    });

    it(`OPTIONS ${route.pathname} returns a preflight response with the matched Allow-Origin`, async () => {
      const res = await worker.fetch!(
        buildRequest("OPTIONS", route.pathname, PROD_ORIGIN, {
          "access-control-request-method": route.method,
          "access-control-request-headers": "content-type, authorization",
        }),
        envFor(),
        NOOP_CTX,
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("access-control-allow-methods") ?? "").toContain(
        route.method,
      );
      expect(res.headers.get("access-control-allow-headers") ?? "").toContain(
        "content-type",
      );
      expect(res.headers.get("access-control-max-age")).toBe("600");
    });

    it(`OPTIONS ${route.pathname} preflight succeeds for a Pages preview deploy`, async () => {
      const res = await worker.fetch!(
        buildRequest("OPTIONS", route.pathname, PREVIEW_ORIGIN, {
          "access-control-request-method": route.method,
        }),
        envFor(),
        NOOP_CTX,
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        PREVIEW_ORIGIN,
      );
    });
  }
});

describe("CORS coverage — non-LMS sanity checks (UNI-65)", () => {
  // A handful of non-LMS surfaces to catch a future regression that
  // tries to fix LMS in isolation and accidentally drops global CORS.
  const SPOT_ROUTES: RouteCase[] = [
    { method: "GET", pathname: "/api/auth/me" },
    { method: "GET", pathname: "/api/dashboard/summary" },
    { method: "POST", pathname: "/api/auth/sign-in" },
    { method: "GET", pathname: "/api/health" },
    { method: "GET", pathname: "/api/this/route/does/not/exist" },
  ];

  for (const route of SPOT_ROUTES) {
    it(`${route.method} ${route.pathname} carries CORS headers`, async () => {
      const res = await worker.fetch!(
        buildRequest(route.method, route.pathname, PROD_ORIGIN),
        envFor(),
        NOOP_CTX,
      );
      expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });
  }
});

describe("CORS layer survives backend faults (UNI-65)", () => {
  it("returns a CORS-wrapped response even when the D1 binding access throws", async () => {
    // Hands the worker a `DB` getter that throws on every access. The
    // rate-limit middleware catches this internally (it would lock
    // every user out otherwise — see middleware/rate-limit.ts), but the
    // important assertion for this regression is downstream: a SPA
    // staring at a partial outage must see a proper status, not a CORS
    // opaque failure that hides the real signal from the operator.
    const env = new Proxy({} as Env, {
      get(_target, prop) {
        if (prop === "APP_ENV") return "production";
        if (prop === "ALLOWED_WEB_ORIGINS") {
          return "https://university-hub-v2-web.pages.dev,https://*.university-hub-v2-web.pages.dev";
        }
        if (prop === "APP_NAME") return "University Hub";
        if (prop === "DB") {
          throw new Error("simulated DB binding failure");
        }
        return undefined;
      },
    });

    const res = await worker.fetch!(
      buildRequest("GET", "/api/auth/me", PROD_ORIGIN),
      env,
      NOOP_CTX,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(PROD_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});
