// /api/auth/* session-token surface (UNI-70 regression).
//
// Background: in production the SPA on `*.pages.dev` calls the Worker on
// `*.workers.dev`. They are separate eTLD+1's, so every request from the
// SPA is third-party. Modern browsers (Safari ITP, Firefox total cookie
// protection, Brave, Chrome with 3p cookies disabled) silently drop the
// cross-site `Set-Cookie`. Until UNI-70 the worker only returned the
// session as an HttpOnly cookie, so a user who finished MFA landed on the
// dashboard and every subsequent `/api/*` call 401'd with
// "Authentication required."
//
// UNI-70 mirrors UNI-68: the worker now also surfaces the raw session
// token in the response body, and the SPA echoes it back as
// `Authorization: Bearer <token>` on every request. The cookie path is
// preserved as defense in depth.
//
// These tests pin the contract:
//
//   1. Sign-in's `ok` body MUST include `session_token`, and SHA-256 of
//      the token MUST equal the persisted `sessions.token_hash` (HMAC of
//      the token under SESSION_SECRET).
//   2. MFA `/challenge` happy path with `remember_device: false` MUST
//      include `session_token` in the body — the exact path the user
//      reported in UNI-70.
//   3. Authenticated request with `Authorization: Bearer <token>` and
//      NO cookie resolves the session — the cross-site-cookie-blocked
//      browser scenario.
//   4. Authenticated request with cookie only (no header) still resolves
//      — defense in depth for browsers that allow cross-site cookies.
//   5. Authenticated request with neither header nor cookie returns 401.
//   6. Authorization header takes precedence over a stale cookie value.
//   7. End-to-end: sign-in → MFA verify (remember_device unchecked) →
//      `/api/auth/me` via Bearer header succeeds. This is the user's
//      reported flow ("Authentication required" on every component) and
//      what the acceptance criteria asks the regression to cover.

import { describe, expect, it } from "vitest";

import type { Role, SignInResponse } from "@university-hub/shared";

import { hashSessionToken } from "../../src/auth/session.js";
import { hashPassword } from "../../src/auth/password.js";
import { generateTotpCode } from "../../src/auth/totp.js";
import type { Env } from "../../src/env.js";
import { buildContext, type RequestContext } from "../../src/middleware/auth.js";
import { handleMe, handleSignIn, handleSignOut } from "../../src/routes/auth.js";
import { handleMfaChallenge } from "../../src/routes/mfa.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const PASSWORD = "DevPassword!2026";
const TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const SESSION_SECRET = "test-session-secret-fixture";

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
    id: "00000000-0000-0000-0000-uni70fixture",
    email: `${role}@example.com`,
    name: `Test ${role}`,
    role,
    status: "active",
    university_id: null,
    password_hash: await hashPassword(PASSWORD),
    last_sign_in_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    mfa_secret: TOTP_SECRET,
    mfa_enabled_at: "2026-01-02T00:00:00.000Z",
    mfa_recovery_codes_hash: "[]",
  };
}

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    APP_NAME: "University Hub",
    SESSION_SECRET,
  };
}

interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string | null;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_activity_at: string;
}

interface ChallengeRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

/**
 * Programmable D1 that captures both `mfa_challenges` and `sessions`
 * INSERTs so the test can verify the token in the response body matches
 * the persisted row, and so the verify path can re-resolve the row by
 * hash on the next request.
 */
function makeDb(user: UserFixture): {
  db: ProgrammableD1;
  sessions: Record<string, SessionRecord>;
  challenges: Record<string, ChallengeRecord>;
} {
  const db = new ProgrammableD1();
  const sessions: Record<string, SessionRecord> = {};
  const challenges: Record<string, ChallengeRecord> = {};

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
    if (sql.startsWith("INSERT INTO sessions")) {
      const [
        id,
        user_id,
        token_hash,
        ip_address,
        user_agent,
        expires_at,
        created_at,
        last_activity_at,
      ] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
      ];
      sessions[token_hash] = {
        id,
        user_id,
        token_hash,
        ip_address,
        user_agent,
        expires_at,
        created_at,
        last_activity_at,
      };
    }
    if (sql.startsWith("DELETE FROM sessions WHERE token_hash = ?")) {
      delete sessions[String(params[0])];
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
    // session JOIN users — what `resolveSessionByToken` issues. We
    // recognize it by the alias prefix (`u_id`, `u_email`, ...) since
    // the SQL is multi-line and reformatted by ProgrammableD1.
    if (
      sql.includes("FROM sessions s") &&
      sql.includes("JOIN users u") &&
      sql.includes("WHERE s.token_hash = ?")
    ) {
      const row = sessions[String(params[0])];
      if (!row || row.user_id !== user.id) return null;
      return {
        id: row.id,
        user_id: row.user_id,
        token_hash: row.token_hash,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        expires_at: row.expires_at,
        created_at: row.created_at,
        last_activity_at: row.last_activity_at,
        u_id: user.id,
        u_email: user.email,
        u_name: user.name,
        u_role: user.role,
        u_status: user.status,
        u_university_id: user.university_id,
        u_password_hash: user.password_hash,
        u_last_sign_in_at: user.last_sign_in_at,
        u_created_at: user.created_at,
        u_updated_at: user.updated_at,
      };
    }
    if (
      sql.includes("FROM system_settings") &&
      sql.includes("WHERE key = ?")
    ) {
      return null;
    }
    return undefined;
  });

  return { db, sessions, challenges };
}

const HEADERS_DEFAULT: Record<string, string> = {
  "content-type": "application/json",
  "cf-connecting-ip": "203.0.113.10",
  "user-agent": "vitest",
};

async function callSignIn(
  user: UserFixture,
  db: ProgrammableD1,
): Promise<{ res: Response; body: SignInResponse | null }> {
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
  return { res, body };
}

async function callMfaChallenge(
  db: ProgrammableD1,
  challengeToken: string,
): Promise<{ res: Response; body: { user?: unknown; session_token?: string } | null }> {
  const env: Env = { ...envFor(), DB: db as unknown as D1Database };
  const code = await generateTotpCode(TOTP_SECRET);
  const request = new Request("http://localhost/api/auth/mfa/challenge", {
    method: "POST",
    headers: {
      ...HEADERS_DEFAULT,
      "x-mfa-challenge-token": challengeToken,
    },
    body: JSON.stringify({ code, remember_device: false }),
  });
  const ctx: RequestContext = {
    request,
    env,
    url: new URL(request.url),
    cookies: {},
    auth: null,
  };
  const res = await handleMfaChallenge(ctx);
  let body: { user?: unknown; session_token?: string } | null = null;
  try {
    const json = (await res.clone().json()) as {
      data?: { user?: unknown; session_token?: string };
    };
    body = json.data ?? null;
  } catch {
    body = null;
  }
  return { res, body };
}

async function callMe(
  db: ProgrammableD1,
  options: { headerToken?: string | null; cookieToken?: string | null },
): Promise<{ res: Response; bodyText: string }> {
  const env: Env = { ...envFor(), DB: db as unknown as D1Database };
  const headers: Record<string, string> = { ...HEADERS_DEFAULT };
  if (options.headerToken) {
    headers["authorization"] = `Bearer ${options.headerToken}`;
  }
  if (options.cookieToken) {
    headers["cookie"] = `university_hub_session=${options.cookieToken}`;
  }
  const request = new Request("http://localhost/api/auth/me", {
    method: "GET",
    headers,
  });
  const ctx = await buildContext(request, env);
  const res = handleMe(ctx);
  const bodyText = await res.clone().text();
  return { res, bodyText };
}

describe("UNI-70: session-token surface", () => {
  it("MFA challenge body includes session_token; SHA-256 hashes to the persisted sessions.token_hash", async () => {
    const user = await fixture("staff");
    const { db, sessions } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const verify = await callMfaChallenge(
      db,
      signedIn.body.mfa_challenge_token,
    );
    expect(verify.res.status).toBe(200);
    expect(typeof verify.body?.session_token).toBe("string");
    expect((verify.body?.session_token ?? "").length).toBeGreaterThan(20);

    const tokenHash = await hashSessionToken(
      verify.body!.session_token!,
      SESSION_SECRET,
    );
    expect(sessions[tokenHash]).toBeDefined();
    expect(sessions[tokenHash]?.user_id).toBe(user.id);
  });

  it("happy path: post-MFA /api/auth/me with Authorization: Bearer header (no cookie) returns 200", async () => {
    // This is exactly the scenario the user reported in UNI-70: sign in
    // with valid creds + valid TOTP, leave remember-device unchecked,
    // and then have every component fail with "Authentication required."
    // because the cross-site session cookie was dropped. With UNI-70 the
    // bearer header keeps the session resolvable.
    const user = await fixture("staff");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const verify = await callMfaChallenge(
      db,
      signedIn.body.mfa_challenge_token,
    );
    expect(verify.res.status).toBe(200);
    const sessionToken = verify.body?.session_token;
    expect(typeof sessionToken).toBe("string");

    const me = await callMe(db, { headerToken: sessionToken, cookieToken: null });
    expect(me.res.status, `body=${me.bodyText}`).toBe(200);
    const meJson = JSON.parse(me.bodyText) as { data?: { id?: string } };
    expect(meJson.data?.id).toBe(user.id);
  });

  it("backward compat: cookie only (no Authorization header) still resolves the session", async () => {
    const user = await fixture("staff");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const verify = await callMfaChallenge(
      db,
      signedIn.body.mfa_challenge_token,
    );
    const sessionToken = verify.body?.session_token;

    const me = await callMe(db, { headerToken: null, cookieToken: sessionToken });
    expect(me.res.status, `body=${me.bodyText}`).toBe(200);
  });

  it("neither header nor cookie → 401 unauthenticated", async () => {
    const user = await fixture("staff");
    const { db } = makeDb(user);
    // Seed a session by signing in once so the resolver isn't trivially
    // empty for an unrelated reason.
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    await callMfaChallenge(db, signedIn.body.mfa_challenge_token);

    const me = await callMe(db, { headerToken: null, cookieToken: null });
    expect(me.res.status).toBe(401);
    const json = JSON.parse(me.bodyText) as { error?: { code?: string } };
    expect(json.error?.code).toBe("unauthenticated");
  });

  it("Authorization header takes precedence over a stale session cookie", async () => {
    const user = await fixture("staff");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const verify = await callMfaChallenge(
      db,
      signedIn.body.mfa_challenge_token,
    );
    const sessionToken = verify.body?.session_token;

    // Cookie carries garbage that would never resolve on its own; the
    // header must win and the request must succeed.
    const me = await callMe(db, {
      headerToken: sessionToken,
      cookieToken: "stale-and-bogus-cookie-value",
    });
    expect(me.res.status, `body=${me.bodyText}`).toBe(200);
  });

  it("sign-out via Authorization header revokes the server-side session row", async () => {
    const user = await fixture("staff");
    const { db, sessions } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const verify = await callMfaChallenge(
      db,
      signedIn.body.mfa_challenge_token,
    );
    const sessionToken = verify.body?.session_token;
    expect(typeof sessionToken).toBe("string");

    const tokenHash = await hashSessionToken(sessionToken!, SESSION_SECRET);
    expect(sessions[tokenHash]).toBeDefined();

    // Sign out using ONLY the Authorization header — no session cookie.
    // This mirrors the cross-site browser environment where the SPA
    // never received the Set-Cookie.
    const env: Env = { ...envFor(), DB: db as unknown as D1Database };
    const signOutReq = new Request("http://localhost/api/auth/sign-out", {
      method: "POST",
      headers: {
        ...HEADERS_DEFAULT,
        authorization: `Bearer ${sessionToken}`,
      },
    });
    const signOutCtx = await buildContext(signOutReq, env);
    const signOutRes = await handleSignOut(signOutCtx);
    expect(signOutRes.status).toBe(200);
    // Session row deleted server-side.
    expect(sessions[tokenHash]).toBeUndefined();
  });

  it("ignores non-Bearer Authorization schemes (Basic, Digest) — falls back to cookie", async () => {
    // Defense in depth: a stray `Authorization: Basic ...` from a proxy
    // or an `Authorization: Bearer <BOOTSTRAP_SECRET>` aimed at a
    // different endpoint must not be interpreted as a session token.
    const user = await fixture("staff");
    const { db } = makeDb(user);
    const signedIn = await callSignIn(user, db);
    if (signedIn.body?.status !== "mfa_required") {
      throw new Error("expected mfa_required");
    }
    const verify = await callMfaChallenge(
      db,
      signedIn.body.mfa_challenge_token,
    );
    const sessionToken = verify.body?.session_token;

    const env: Env = { ...envFor(), DB: db as unknown as D1Database };
    const request = new Request("http://localhost/api/auth/me", {
      method: "GET",
      headers: {
        ...HEADERS_DEFAULT,
        authorization: "Basic dXNlcjpwYXNz",
        cookie: `university_hub_session=${sessionToken}`,
      },
    });
    const ctx = await buildContext(request, env);
    const res = handleMe(ctx);
    expect(res.status).toBe(200);
  });
});
