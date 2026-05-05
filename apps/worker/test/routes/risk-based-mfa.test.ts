// Risk-based MFA gate tests for non-admin roles (UNI-49).
//
// Decision tree at sign-in for a non-admin user (faculty / teacher /
// teacher_assistant / student / staff / guest / viewer):
//
//   - not enrolled         → MFA challenge issued (forced enrollment)
//   - no fingerprint row   → MFA challenge issued
//   - row.last_mfa_at fresh
//     within revalidation_days → bypass, no challenge
//   - row.last_mfa_at stale  → MFA challenge issued
//
// Admins (super_admin, university_admin) NEVER hit this gate; they go
// through the every-time challenge path instead. The UNI-47 cookie
// bypass for university_admin is exercised in trusted-devices.test.ts;
// here we only cover the new fingerprint path.

import { describe, expect, it } from "vitest";

import type { Role, SignInResponse } from "@university-hub/shared";

import { computeDeviceFingerprint } from "../../src/auth/device-fingerprint.js";
import { hashPassword } from "../../src/auth/password.js";
import type { Env } from "../../src/env.js";
import type { RequestContext } from "../../src/middleware/auth.js";
import { handleSignIn } from "../../src/routes/auth.js";
import { handleMfaStatus } from "../../src/routes/mfa.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const PASSWORD = "DevPassword!2026";
const SESSION_SECRET = "test-session-secret-fixture";
const REQ_IP = "203.0.113.10";

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

async function fixture(role: Role, id: string): Promise<UserFixture> {
  return {
    id,
    email: `${role}@example.com`,
    name: `Test ${role}`,
    role,
    status: "active",
    university_id: null,
    password_hash: await hashPassword(PASSWORD),
    last_sign_in_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    mfa_secret: "JBSWY3DPEHPK3PXP",
    mfa_enabled_at: "2026-01-02T00:00:00.000Z",
    mfa_recovery_codes_hash: "[]",
  };
}

interface TrustedDeviceFixture {
  id: string;
  user_id: string;
  token_hash: string;
  ip_address: string;
  user_agent: string | null;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
  device_fingerprint_hash: string | null;
  label: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_mfa_at: string | null;
}

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    APP_NAME: "University Hub",
    SESSION_SECRET,
  };
}

function makeSignInDb(
  user: UserFixture,
  trusted: TrustedDeviceFixture[] = [],
  systemSettings: Record<string, string> = { mfa_revalidation_days: "30" },
): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onFirst((sql, params) => {
    if (sql.startsWith("SELECT 1 AS ok") || sql.includes("PRAGMA")) {
      return { ok: 1 };
    }
    if (sql.includes("FROM users") && sql.includes("WHERE email = ?")) {
      if (params[0] === user.email) return user;
      return null;
    }
    if (
      sql.includes("FROM trusted_devices") &&
      sql.includes("WHERE user_id = ?") &&
      sql.includes("AND device_fingerprint_hash = ?")
    ) {
      const userId = String(params[0]);
      const fp = String(params[1]);
      const row = trusted.find(
        (t) => t.user_id === userId && t.device_fingerprint_hash === fp,
      );
      return row ?? null;
    }
    if (
      sql.includes("FROM system_settings") &&
      sql.includes("WHERE key = ?")
    ) {
      const key = String(params[0]);
      const value = systemSettings[key];
      return value !== undefined ? { key, value } : null;
    }
    if (
      sql.includes("FROM rate_limit_counters") &&
      sql.includes("WHERE key = ?")
    ) {
      return null;
    }
    if (
      sql.includes("FROM trusted_devices") &&
      sql.includes("WHERE token_hash = ?")
    ) {
      return null;
    }
    return undefined;
  });
  return db;
}

const HEADERS_DEFAULT: Record<string, string> = {
  "content-type": "application/json",
  "cf-connecting-ip": REQ_IP,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.6099.71 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

async function callSignIn(
  user: UserFixture,
  options: {
    trusted?: TrustedDeviceFixture[];
    systemSettings?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
): Promise<{ res: Response; body: SignInResponse | null; db: ProgrammableD1 }> {
  const db = makeSignInDb(user, options.trusted ?? [], options.systemSettings);
  const env = { ...envFor(), DB: db as unknown as D1Database };
  const headers: Record<string, string> = {
    ...HEADERS_DEFAULT,
    ...(options.headers ?? {}),
  };
  const request = new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers,
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
  return { res, body, db };
}

function setCookies(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") out.push(value);
  });
  return out;
}

async function fingerprintFor(
  ip: string = REQ_IP,
  userAgent: string = HEADERS_DEFAULT["user-agent"]!,
  acceptLanguage: string = HEADERS_DEFAULT["accept-language"]!,
): Promise<string> {
  const env = envFor();
  const fp = await computeDeviceFingerprint(env, {
    userAgent,
    acceptLanguage,
    ip,
  });
  return fp.hash;
}

function makeTrustedRow(
  userId: string,
  fingerprintHash: string,
  lastMfaAt: string,
): TrustedDeviceFixture {
  return {
    id: "td-fp-1",
    user_id: userId,
    token_hash: "", // fingerprint-only row, no cookie
    ip_address: REQ_IP,
    user_agent: HEADERS_DEFAULT["user-agent"]!,
    expires_at: "9999-12-31T23:59:59.000Z",
    created_at: "2026-04-01T00:00:00.000Z",
    last_used_at: null,
    device_fingerprint_hash: fingerprintHash,
    label: "Chrome on macOS",
    first_seen_at: "2026-04-01T00:00:00.000Z",
    last_seen_at: lastMfaAt,
    last_mfa_at: lastMfaAt,
  };
}

const NON_ADMIN_USER_ID = "00000000-0000-0000-0000-000fac111111";

describe("UNI-49 risk-based MFA gate (non-admin roles)", () => {
  it("first sign-in from a previously-unseen device → MFA challenge", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    const { res, body } = await callSignIn(user);
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.trusted_device_eligible).toBe(true);
    }
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_mfa_challenge=");
    expect(cookies).not.toContain("university_hub_session=");
  });

  it("same browser, fresh last_mfa_at within window → bypass, no challenge", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    const fp = await fingerprintFor();
    // Last MFA was an hour ago; revalidation window is 30 days.
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row = makeTrustedRow(user.id, fp, recent);
    const { res, body, db } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("ok");
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_session=");
    expect(cookies).not.toContain("university_hub_mfa_challenge=");
    const auditActions = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).toContain("mfa.bypassed_via_revalidation_window");
    expect(auditActions).toContain("auth.sign_in");
  });

  it("same browser, stale last_mfa_at past window → re-MFA", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    const fp = await fingerprintFor();
    // Last MFA was 60 days ago; revalidation window is 30 days.
    const stale = new Date(
      Date.now() - 60 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const row = makeTrustedRow(user.id, fp, stale);
    const { res, body, db } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    const auditActions = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).not.toContain("mfa.bypassed_via_revalidation_window");
  });

  it("new browser (different fingerprint) → MFA challenge with checkbox", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    // The stored fingerprint is for Firefox on Linux; the user is signing
    // in from Chrome on macOS so the fingerprint lookup misses.
    const otherFp = await fingerprintFor(
      REQ_IP,
      "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/115.0",
      "fr-FR",
    );
    const recent = new Date().toISOString();
    const row = makeTrustedRow(user.id, otherFp, recent);
    const { res, body } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.trusted_device_eligible).toBe(true);
    }
  });

  it("different IP /16 → MFA challenge (fingerprint changes when network changes)", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    // Stored row was built around a different IP /16.
    const otherFp = await fingerprintFor("198.51.100.10");
    const recent = new Date().toISOString();
    const row = makeTrustedRow(user.id, otherFp, recent);
    const { res, body } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
  });

  it("super_admin always-MFA — even with a fresh fingerprint row, no bypass", async () => {
    const user = await fixture(
      "super_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    const fp = await fingerprintFor();
    const recent = new Date().toISOString();
    const row = makeTrustedRow(user.id, fp, recent);
    const { res, body, db } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.trusted_device_eligible).toBe(false);
    }
    const auditActions = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).not.toContain("mfa.bypassed_via_revalidation_window");
  });

  it("university_admin keeps the UNI-47 cookie path; risk-based gate does NOT apply", async () => {
    // Even with a fresh fingerprint row that would bypass for a faculty
    // user, university_admin still gets the always-challenge path
    // (UNI-49 explicit recommendation: admins re-MFA every sign-in).
    const user = await fixture(
      "university_admin",
      "00000000-0000-0000-0000-0000bbbbbbbb",
    );
    const fp = await fingerprintFor();
    const recent = new Date().toISOString();
    const row = makeTrustedRow(user.id, fp, recent);
    const { res, body, db } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    const auditActions = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).not.toContain("mfa.bypassed_via_revalidation_window");
  });

  it("not enrolled → MFA challenge regardless of fingerprint state", async () => {
    const user = await fixture("student", NON_ADMIN_USER_ID);
    user.mfa_enabled_at = null; // never enrolled
    user.mfa_secret = null;
    const fp = await fingerprintFor();
    // Even if a row existed, lacking enrollment forces the challenge.
    const recent = new Date().toISOString();
    const row = makeTrustedRow(user.id, fp, recent);
    const { res, body } = await callSignIn(user, { trusted: [row] });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.mfa_enrolled).toBe(false);
    }
  });

  it("revalidation window of 1 day re-MFAs after 25 hours", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    const fp = await fingerprintFor();
    const justOver = new Date(
      Date.now() - 25 * 60 * 60 * 1000,
    ).toISOString();
    const row = makeTrustedRow(user.id, fp, justOver);
    const { body } = await callSignIn(user, {
      trusted: [row],
      systemSettings: { mfa_revalidation_days: "1" },
    });
    expect(body?.status).toBe("mfa_required");
  });
});

// ---------------------------------------------------------------------------
// /api/auth/mfa/status — UNI-48 regression + UNI-49 new fields
// ---------------------------------------------------------------------------

describe("GET /api/auth/mfa/status — extended payload (UNI-49)", () => {
  it("returns clean JSON for any authenticated user, including non-admins", async () => {
    const user = await fixture("faculty", NON_ADMIN_USER_ID);
    const db = new ProgrammableD1();
    db.onFirst((sql, params) => {
      if (sql.startsWith("SELECT 1 AS ok") || sql.includes("PRAGMA")) {
        return { ok: 1 };
      }
      if (sql.includes("FROM users") && sql.includes("WHERE id = ?")) {
        if (params[0] === user.id) return user;
        return null;
      }
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("COUNT(*)")
      ) {
        return { c: 2 };
      }
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("MAX(last_mfa_at)")
      ) {
        return { last: "2026-05-04T12:00:00.000Z" };
      }
      if (
        sql.includes("FROM system_settings") &&
        sql.includes("WHERE key = ?")
      ) {
        return { key: String(params[0]), value: "30" };
      }
      return null;
    });
    const env: Env = { ...envFor(), DB: db as unknown as D1Database };
    const ctx: RequestContext = {
      request: new Request("http://localhost/api/auth/mfa/status"),
      env,
      url: new URL("http://localhost/api/auth/mfa/status"),
      cookies: {},
      auth: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          university_id: user.university_id,
          password_hash: user.password_hash,
          last_sign_in_at: user.last_sign_in_at,
          created_at: user.created_at,
          updated_at: user.updated_at,
        },
        session: {
          id: "session-1",
          user_id: user.id,
          token_hash: "h",
          ip_address: null,
          user_agent: null,
          expires_at: "2099-01-01T00:00:00.000Z",
          created_at: "2026-05-05T00:00:00.000Z",
          last_activity_at: "2026-05-05T00:00:00.000Z",
        },
      },
    };
    const res = await handleMfaStatus(ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        required: boolean;
        enrolled: boolean;
        last_mfa_at: string | null;
        trusted_device_count: number;
        revalidation_days: number;
      };
    };
    expect(body.data.required).toBe(true);
    expect(body.data.enrolled).toBe(true);
    expect(body.data.last_mfa_at).toBe("2026-05-04T12:00:00.000Z");
    expect(body.data.trusted_device_count).toBe(2);
    expect(body.data.revalidation_days).toBe(30);
  });
});
