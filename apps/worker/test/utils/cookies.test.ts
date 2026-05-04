// Tests for the session cookie helpers. The split deploy means the SPA on
// Pages and the Worker on workers.dev are cross-site, so the production
// cookie has to use `SameSite=None; Secure` for the browser to attach it on
// fetch(...). Local dev keeps `SameSite=Lax` without Secure so http://localhost
// sign-in still works.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
  parseCookies,
  sessionCookieAttributes,
} from "../../src/utils/cookies.js";

function envWith(overrides: Partial<Env>): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_NAME: "University Hub",
    ...overrides,
  } as Env;
}

describe("sessionCookieAttributes", () => {
  it("returns SameSite=None; Secure in production", () => {
    expect(sessionCookieAttributes(envWith({ APP_ENV: "production" }))).toEqual({
      sameSite: "None",
      secure: true,
    });
  });

  it("returns SameSite=Lax without Secure in development", () => {
    expect(sessionCookieAttributes(envWith({ APP_ENV: "development" }))).toEqual({
      sameSite: "Lax",
      secure: false,
    });
  });

  it("treats an unset APP_ENV as development", () => {
    expect(sessionCookieAttributes(envWith({}))).toEqual({
      sameSite: "Lax",
      secure: false,
    });
  });
});

describe("buildSessionSetCookie", () => {
  it("emits SameSite=None + Secure + HttpOnly in production", () => {
    const cookie = buildSessionSetCookie(envWith({ APP_ENV: "production" }), {
      name: "university_hub_session",
      value: "abc123",
      expires: new Date("2026-01-01T00:00:00Z"),
    });
    expect(cookie).toContain("university_hub_session=abc123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Expires=");
  });

  it("emits SameSite=Lax without Secure in development", () => {
    const cookie = buildSessionSetCookie(envWith({ APP_ENV: "development" }), {
      name: "university_hub_session",
      value: "abc123",
      expires: new Date("2026-01-01T00:00:00Z"),
    });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("buildSessionClearCookie", () => {
  it("expires the cookie with the same SameSite/Secure attributes (prod)", () => {
    const cookie = buildSessionClearCookie(
      envWith({ APP_ENV: "production" }),
      "university_hub_session",
    );
    expect(cookie).toContain("university_hub_session=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });

  it("expires the cookie with SameSite=Lax in dev", () => {
    const cookie = buildSessionClearCookie(
      envWith({ APP_ENV: "development" }),
      "university_hub_session",
    );
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
  });
});

describe("parseCookies", () => {
  it("parses a typical Cookie header", () => {
    const parsed = parseCookies("a=1; b=hello%20world; c=");
    expect(parsed).toEqual({ a: "1", b: "hello world", c: "" });
  });

  it("returns {} for null/empty input", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });
});
