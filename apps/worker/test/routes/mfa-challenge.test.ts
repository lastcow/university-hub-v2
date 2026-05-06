// /api/auth/mfa/challenge happy + header-only paths (UNI-68 regression).
//
// Background: prior to UNI-68 the pending-MFA challenge token was carried
// only on the `university_hub_mfa_challenge` HttpOnly cookie. In
// production the SPA on `*.pages.dev` calls the Worker on `*.workers.dev`,
// which is a cross-site fetch — and modern browsers (Safari ITP, Firefox
// total cookie protection, Brave, Chrome with 3p cookies disabled) drop
// the cross-site `Set-Cookie`. The SPA then submitted a valid TOTP code
// on a request that no longer carried the cookie, which surfaced as
// "Sign in again to complete MFA verification."  even though both the
// password and the TOTP code were correct.
//
// UNI-68 surfaces the token in the sign-in / invitation-accept response
// body (`mfa_challenge_token`) and accepts it back via the
// `X-Mfa-Challenge-Token` request header on the verify endpoints. The
// cookie still ships as defense in depth for clients that allow it.
//
// These tests pin the contract:
//
//   1. Sign-in's `mfa_required` body MUST include `mfa_challenge_token`
//      and the server-side row must hash to that token.
//   2. /api/auth/mfa/challenge with a valid code + header (and NO
//      cookie) returns 200 ok and issues the session — mirroring the
//      cross-site-cookie-blocked browser environment.
//   3. /api/auth/mfa/challenge with a valid code + cookie (and NO
//      header) still works — the cookie path is preserved.
//   4. /api/auth/mfa/challenge with neither still 401s with
//      `mfa_challenge_required`.

import { describe, expect, it } from "vitest";

import type { Role, SignInResponse } from "@university-hub/shared";

import {
  generateMfaChallengeToken,
  hashMfaChallengeToken,
} from "../../src/auth/mfa-challenge.js";
import { hashPassword } from "../../src/auth/password.js";
import { generateTotpCode } from "../../src/auth/totp.js";
import type { Env } from "../../src/env.js";
import type { RequestContext } from "../../src/middleware/auth.js";
import { handleSignIn } from "../../src/routes/auth.js";
import { handleMfaChallenge } from "../../src/routes/mfa.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const PASSWORD = "DevPassword!2026";
const SECRET = "JBSWY3DPEHPK3PXP";

interface UserFixture {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active";
  university_id: string | null;
  password_hash: string;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  mfa_secret: string | null;
  mfa_enabled_at: string | null;
  mfa_recovery_codes_hash: string | null;
}

async function fixture(role: Role): Promise<UserFixture> {
  return {
    id: "00000000-0000-0000-0000-uni68fixture",
    email: `${role}@example.com`,
    name: `Test ${role}`,
    role,
    status: "active",
    university_id: null,
    password_hash: await hashPassword(PASSWORD),
    last_sign_in_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    mfa_secret: SECRET,
    mfa_enabled_at: "2026-01-02T00:00:00.000Z",
    mfa_recovery_codes_hash: "[]",
  };
}

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    APP_NAME: "University Hub",
    SESSION_SECRET: "test-session-secret-fixture",
  };
}

/**
 * Builds a programmable D1 that captures every `mfa_challenges` INSERT so
 * tests can verify the token in the response body matches the row that
 * was just persisted, and that lets the verify path re-resolve the same
 * row by hash.
 */
function makeDb(user: UserFixture): {
  db: ProgrammableD1;
  challengeRowFor: (token: string) => unknown;
} {
  const db = new ProgrammableD1();
  const challenges: Record<string, { id: string; user_id: string; token_hash: string; expires_at: string; created_at: string }> = {};

  db.onWrite((sql, params) => {
    if (sql.startsWith("INSERT INTO mfa_challenges")) {
      const [id, user_id, token_hash] = params as [string, string, string];
      challenges[token_hash] = {
        id,
        user_id,
        token_hash,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        created_at: new Date().toISOString(),
      };
    }
    if (sql.startsWith("DELETE FROM mfa_challenges WHERE token_hash = ?")) {
      delete challenges[String(params[0])];
    }
  });

  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok") || sql.includes("PRAGMA")) {
      return { ok: 1 };
    }
    if (
      sql.includes("FROM rate_limit_counters") &&
      sql.includes("WHERE key = ?")
    ) {
      return null;
    }
    if (
      sql.includes("FROM trusted_devices") &&
      sql.includes("WHERE user_id = ?") &&
      sql.includes("AND device_fingerprint_hash = ?")
    ) {
      return null;
    }
    if (sql.includes("FROM users") && sql.includes("WHERE email = ?")) {
      if (params[0] === user.email) return user;
      return null;
    }
    if (sql.includes("FROM users") && sql.includes("WHERE id = ?")) {
      if (params[0] === user.id) return user;
      return null;
    }
    if (
      sql.includes("FROM mfa_challenges") &&
      sql.includes("WHERE token_hash = ?")
    ) {
      const row = challenges[String(params[0])];
      return row ?? null;
    }
    if (
      sql.includes("FROM system_settings") &&
      sql.includes("WHERE key = ?")
    ) {
      return null;
    }
    return undefined;
  });

  return {
    db,
    challengeRowFor: (token: string) => challenges[token] ?? null,
  };
}

const HEADERS_DEFAULT: Record<string, string> = {
  "content-type": "application/json",
  "cf-connecting-ip": "203.0.113.10",
  "user-agent": "vitest",
};

async function callSignIn(
  user: UserFixture,
  db: ProgrammableD1,
): Promise<{ res: Response; body: SignInResponse | null; setCookie: string[] }> {
  const env: Env = { ...envFor(), DB: db as unknown as D1Database };
  const request = new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers: HEADERS_DEFAULT,
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  const ctx: RequestContext = {
    request,
    env,
    url: new URL(request.url),
    cookies: {},
    auth: null,
  };
  const res = await handleSignIn(ctx);
  let body: SignInResponse | null = null;
  try {
    const json = (await res.clone().json()) as { data?: SignInResponse };
    body = json.data ?? null;
  } catch {
    body = null;
  }
  const setCookie: string[] = [];
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") setCookie.push(v);
  });
  return { res, body, setCookie };
}

async function callChallenge(
  db: ProgrammableD1,
  options: { headerToken?: string | null; cookieToken?: string | null },
): Promise<{ res: Response; bodyText: string; setCookie: string[] }> {
  const env: Env = { ...envFor(), DB: db as unknown as D1Database };
  const headers: Record<string, string> = { ...HEADERS_DEFAULT };
  if (options.headerToken) headers["x-mfa-challenge-token"] = options.headerToken;
  if (options.cookieToken) headers["cookie"] = `university_hub_mfa_challenge=${options.cookieToken}`;
  const code = await generateTotpCode(SECRET);
  const request = new Request("http://localhost/api/auth/mfa/challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ code, remember_device: false }),
  });
  const ctx: RequestContext = {
    request,
    env,
    url: new URL(request.url),
    cookies: options.cookieToken
      ? { university_hub_mfa_challenge: options.cookieToken }
      : {},
    auth: null,
  };
  const res = await handleMfaChallenge(ctx);
  const bodyText = await res.clone().text();
  const setCookie: string[] = [];
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") setCookie.push(v);
  });
  return { res, bodyText, setCookie };
}

describe("UNI-68: MFA challenge token surface", () => {
  it("sign-in's mfa_required body includes mfa_challenge_token, hashes to the persisted row", async () => {
    const user = await fixture("super_admin");
    const { db, challengeRowFor } = makeDb(user);
    const { res, body } = await callSignIn(user, db);
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status !== "mfa_required") return;
    expect(typeof body.mfa_challenge_token).toBe("string");
    expect(body.mfa_challenge_token.length).toBeGreaterThan(20);
    const tokenHash = await hashMfaChallengeToken(body.mfa_challenge_token);
    expect(challengeRowFor(tokenHash)).not.toBeNull();
  });

  it("happy path: valid TOTP + X-Mfa-Challenge-Token header, no cookie → 200 ok, issues session", async () => {
    const user = await fixture("super_admin");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const token = signedIn.body.mfa_challenge_token;

    const verify = await callChallenge(db, {
      headerToken: token,
      cookieToken: null,
    });
    expect(verify.res.status, `body=${verify.bodyText}`).toBe(200);
    const joined = verify.setCookie.join(" | ");
    expect(joined).toContain("university_hub_session=");
    // The MFA challenge cookie clear is also issued, even though the
    // browser may not have stored the original cookie — harmless.
    expect(joined).toContain("university_hub_mfa_challenge=");
  });

  it("backward compat: valid TOTP + cookie only (no header) still verifies", async () => {
    const user = await fixture("staff");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const token = signedIn.body.mfa_challenge_token;

    const verify = await callChallenge(db, {
      headerToken: null,
      cookieToken: token,
    });
    expect(verify.res.status, `body=${verify.bodyText}`).toBe(200);
    expect(verify.setCookie.join(" | ")).toContain("university_hub_session=");
  });

  it("neither header nor cookie → 401 mfa_challenge_required", async () => {
    const user = await fixture("staff");
    const { db } = makeDb(user);
    // Seed a row by signing in once so the resolver wouldn't trivially
    // 401 for a different reason.
    await callSignIn(user, db);
    const verify = await callChallenge(db, {
      headerToken: null,
      cookieToken: null,
    });
    expect(verify.res.status).toBe(401);
    const json = JSON.parse(verify.bodyText) as { error?: { code?: string } };
    expect(json.error?.code).toBe("mfa_challenge_required");
  });

  it("header takes precedence: cookie + valid header verifies via header", async () => {
    const user = await fixture("staff");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const token = signedIn.body.mfa_challenge_token;
    // A stale cookie value — the header should take precedence.
    const stale = generateMfaChallengeToken();
    const verify = await callChallenge(db, {
      headerToken: token,
      cookieToken: stale,
    });
    expect(verify.res.status, `body=${verify.bodyText}`).toBe(200);
  });
});
