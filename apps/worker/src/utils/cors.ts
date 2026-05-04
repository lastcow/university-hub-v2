// CORS for the API-only Worker. The SPA ships from a separate Cloudflare
// Pages project, so every browser fetch is cross-origin and carries cookies.
// That means responses must:
//   - echo a single matched origin in `Access-Control-Allow-Origin`
//     (never `*` when credentials are enabled),
//   - set `Access-Control-Allow-Credentials: true`,
//   - vary on Origin so caches do not collapse responses across origins.
//
// The allowlist is driven by ALLOWED_WEB_ORIGINS (comma-separated) plus a
// hard-coded set of dev origins that is appended in development. A leading
// "*." in an entry matches any single-label subdomain — used so Cloudflare
// Pages preview URLs (`<sha>.<project>.pages.dev`) are accepted without
// having to enumerate them.

import type { Env } from "../env.js";
import { isProduction } from "../env.js";

const DEV_DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const PREFLIGHT_MAX_AGE_SECONDS = 600;

interface OriginRule {
  scheme: string;
  host: string;
  wildcardSubdomain: boolean;
}

function parseOriginRule(raw: string): OriginRule | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    // Accept entries that include a wildcard like "https://*.example.com"
    // by swapping the wildcard for a placeholder hostname before parsing.
    const normalized = trimmed.replace("://*.", "://__wildcard__.");
    url = new URL(normalized);
  } catch {
    return null;
  }
  const wildcardSubdomain = url.hostname.startsWith("__wildcard__.");
  const host = wildcardSubdomain ? url.hostname.slice("__wildcard__.".length) : url.hostname;
  return {
    scheme: url.protocol.replace(":", ""),
    host,
    wildcardSubdomain,
  };
}

function getAllowedOrigins(env: Env): OriginRule[] {
  const raw = (env.ALLOWED_WEB_ORIGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!isProduction(env)) {
    for (const origin of DEV_DEFAULT_ORIGINS) {
      if (!raw.includes(origin)) raw.push(origin);
    }
  }
  return raw
    .map(parseOriginRule)
    .filter((rule): rule is OriginRule => rule !== null);
}

function originMatches(rule: OriginRule, origin: URL): boolean {
  if (rule.scheme !== origin.protocol.replace(":", "")) return false;
  if (origin.hostname === rule.host) return true;
  if (!rule.wildcardSubdomain) return false;
  // Match exactly one extra label so `*.foo.com` does not also accept
  // `evil.attacker.com.foo.com`-style spoofs.
  const suffix = `.${rule.host}`;
  if (!origin.hostname.endsWith(suffix)) return false;
  const prefix = origin.hostname.slice(0, -suffix.length);
  return prefix.length > 0 && !prefix.includes(".");
}

/** Returns the request Origin if it is in the configured allowlist. */
export function matchAllowedOrigin(env: Env, request: Request): string | null {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return null;
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return null;
  }
  for (const rule of getAllowedOrigins(env)) {
    if (originMatches(rule, originUrl)) return originHeader;
  }
  return null;
}

/** Headers to mix into every API response. Vary stays present even on misses. */
export function corsHeaders(env: Env, request: Request): Record<string, string> {
  const matched = matchAllowedOrigin(env, request);
  const headers: Record<string, string> = { vary: "Origin" };
  if (matched) {
    headers["access-control-allow-origin"] = matched;
    headers["access-control-allow-credentials"] = "true";
  }
  return headers;
}

/** Build the response for an OPTIONS preflight on an /api/* path. */
export function buildPreflightResponse(env: Env, request: Request): Response {
  const matched = matchAllowedOrigin(env, request);
  const requestedMethod = request.headers.get("access-control-request-method");
  const requestedHeaders = request.headers.get("access-control-request-headers");
  const headers = new Headers({ vary: "Origin, Access-Control-Request-Headers" });
  if (matched) {
    headers.set("access-control-allow-origin", matched);
    headers.set("access-control-allow-credentials", "true");
    headers.set(
      "access-control-allow-methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    headers.set(
      "access-control-allow-headers",
      requestedHeaders ?? "content-type, authorization",
    );
    headers.set("access-control-max-age", String(PREFLIGHT_MAX_AGE_SECONDS));
  }
  // 204 either way — disallowed origins simply get a body-less response with
  // no Allow-* headers, which is enough for the browser to block the request.
  return new Response(null, {
    status: 204,
    headers,
  });
}

/** Mix CORS headers into an existing response (without losing Set-Cookie). */
export function withCors(response: Response, env: Env, request: Request): Response {
  const cors = corsHeaders(env, request);
  for (const [key, value] of Object.entries(cors)) {
    if (key === "vary") {
      const existing = response.headers.get("vary");
      response.headers.set(
        "vary",
        existing ? mergeVary(existing, value) : value,
      );
    } else {
      response.headers.set(key, value);
    }
  }
  return response;
}

function mergeVary(existing: string, addition: string): string {
  const parts = new Set(
    existing
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const entry of addition.split(",").map((s) => s.trim()).filter(Boolean)) {
    parts.add(entry);
  }
  return Array.from(parts).join(", ");
}
