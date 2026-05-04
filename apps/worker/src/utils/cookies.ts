// Minimal cookie helpers for the Worker. The session cookie is set on the
// Worker's host (e.g. *.workers.dev) and read by the SPA, which lives on a
// different host (e.g. *.pages.dev) — that is cross-site, so the cookie has
// to use `SameSite=None; Secure` in production. In dev (`APP_ENV ===
// "development"`) we drop Secure and use `SameSite=Lax` so http://localhost
// sign-in still works without HTTPS.

import type { Env } from "../env.js";
import { isProduction } from "../env.js";

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface SetCookieOptions {
  name: string;
  value: string;
  expires?: Date;
  maxAgeSeconds?: number;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export function buildSetCookie(options: SetCookieOptions): string {
  const parts: string[] = [`${options.name}=${encodeURIComponent(options.value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/**
 * Picks the right cookie attributes for the deployment we're running in:
 * cross-site (`SameSite=None; Secure`) in production so the Pages SPA can
 * send the cookie on `fetch(...)`, and `SameSite=Lax` without `Secure` in
 * dev so a plain http://localhost sign-in flow works.
 */
export function sessionCookieAttributes(env: Env): {
  sameSite: "None" | "Lax";
  secure: boolean;
} {
  if (isProduction(env)) {
    return { sameSite: "None", secure: true };
  }
  return { sameSite: "Lax", secure: false };
}

export function buildSessionSetCookie(
  env: Env,
  options: { name: string; value: string; expires: Date },
): string {
  const { sameSite, secure } = sessionCookieAttributes(env);
  return buildSetCookie({
    name: options.name,
    value: options.value,
    expires: options.expires,
    httpOnly: true,
    secure,
    sameSite,
  });
}

export function buildSessionClearCookie(env: Env, name: string): string {
  const { sameSite, secure } = sessionCookieAttributes(env);
  return buildSetCookie({
    name,
    value: "",
    path: "/",
    expires: new Date(0),
    maxAgeSeconds: 0,
    httpOnly: true,
    secure,
    sameSite,
  });
}
