// Sign-in / MFA gate test (UNI-24).
//
// Asserts that the role-based MFA gate is wired up:
//   - For roles in MFA_REQUIRED_ROLES, /api/auth/sign-in does NOT issue a
//     session cookie. Instead it sets the mfa_challenge cookie and the body
//     reports `status: "mfa_required"`.
//   - For other roles, the existing behaviour is unchanged: session cookie
//     set, `status: "ok"`.
//
// Lower-level handlers (verify-enroll, challenge, etc.) are exercised
// indirectly via the TOTP and recovery-code unit tests. End-to-end click
// flow is QA's responsibility.

import { describe, expect, it } from "vitest";

import type { Role, SignInResponse } from "@university-hub/shared";

import { hashPassword } from "../../src/auth/password.js";
import type { Env } from "../../src/env.js";
import { handleSignIn } from "../../src/routes/auth.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const PASSWORD = "DevPassword!2026";

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
    id: `00000000-0000-0000-0000-${role.padEnd(12, "0").slice(0, 12)}`,
    email: `${role}@example.com`,
    name: `Test ${role}`,
    role,
    status: "active",
    university_id: null,
    password_hash: await hashPassword(PASSWORD),
    last_sign_in_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    mfa_secret: null,
    mfa_enabled_at: null,
    mfa_recovery_codes_hash: null,
  };
}

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    APP_NAME: "University Hub",
  };
}

function makeDb(user: UserFixture): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok") || sql.includes("PRAGMA")) {
      return { ok: 1 };
    }
    if (
      sql.includes("FROM users") &&
      sql.includes("WHERE email = ?") &&
      params[0] === user.email
    ) {
      return user;
    }
    return undefined;
  });
  return db;
}

async function callSignIn(
  user: UserFixture,
  password: string = PASSWORD,
): Promise<{ res: Response; body: SignInResponse | null }> {
  const db = makeDb(user);
  const env = { ...envFor(), DB: db as unknown as D1Database };
  const request = new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password }),
  });
  const ctx = {
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

function setCookies(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.push(value);
  });
  return out;
}

describe("/api/auth/sign-in — MFA gate", () => {
  it("issues a session immediately for non-MFA roles", async () => {
    const user = await fixture("staff");
    const { res, body } = await callSignIn(user);
    expect(res.status).toBe(200);
    expect(body?.status).toBe("ok");
    if (body?.status === "ok") {
      expect(body.user.id).toBe(user.id);
    }
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_session=");
    expect(cookies).not.toContain("university_hub_mfa_challenge=");
  });

  it("issues an MFA challenge cookie and 'mfa_required' body for super_admin", async () => {
    const user = await fixture("super_admin");
    const { res, body } = await callSignIn(user);
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.mfa_enrolled).toBe(false);
    }
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_mfa_challenge=");
    expect(cookies).not.toContain("university_hub_session=");
  });

  it("issues an MFA challenge cookie for university_admin", async () => {
    const user = await fixture("university_admin");
    const { res, body } = await callSignIn(user);
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
  });

  it("reports mfa_enrolled=true when the user already has mfa_enabled_at", async () => {
    const user = await fixture("super_admin");
    user.mfa_secret = "JBSWY3DPEHPK3PXP";
    user.mfa_enabled_at = "2026-04-01T00:00:00.000Z";
    user.mfa_recovery_codes_hash = "[]";
    const { body } = await callSignIn(user);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.mfa_enrolled).toBe(true);
    }
  });

  it("rejects a wrong password before considering MFA", async () => {
    const user = await fixture("super_admin");
    const { res } = await callSignIn(user, "wrong-password");
    expect(res.status).toBe(401);
    const cookies = setCookies(res).join(" | ");
    expect(cookies).not.toContain("university_hub_mfa_challenge=");
  });
});
