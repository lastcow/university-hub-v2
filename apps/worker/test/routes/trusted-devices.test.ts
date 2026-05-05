// Trusted-device MFA bypass + grant route tests (UNI-47).
//
// Covers the acceptance criteria spelled out in the issue:
//
//   - Happy-path bypass: cookie + matching IP + university_admin →
//     session issued, no MFA challenge cookie, audit row written.
//   - IP mismatch falls through to TOTP — no bypass audit, MFA challenge
//     cookie is set.
//   - Expired cookie falls through, stale row is deleted.
//   - super_admin always TOTP — even with a valid cookie + matching IP,
//     the bypass refuses and a challenge cookie is set.
//   - Cross-user cookie is rejected and the row is dropped defensively.
//   - GET /api/auth/trusted-devices returns the redacted list for the
//     calling user only.
//   - DELETE /api/auth/trusted-devices/:id revokes + audits.
//   - POST /api/auth/trusted-devices/revoke-all sweeps + audits per row.
//   - Admin-of-other revoke is super_admin-only; university_admin is 403.

import { describe, expect, it } from "vitest";

import type { Role, SignInResponse } from "@university-hub/shared";

import { hashPassword } from "../../src/auth/password.js";
import { hashTrustedDeviceToken } from "../../src/auth/trusted-device.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { handleSignIn } from "../../src/routes/auth.js";
import {
  handleAdminListTrustedDevices,
  handleAdminRevokeAllTrustedDevices,
  handleListTrustedDevices,
  handleRevokeAllTrustedDevices,
  handleRevokeTrustedDevice,
} from "../../src/routes/trusted-devices.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const PASSWORD = "DevPassword!2026";
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
}

function makeSignInDb(
  user: UserFixture,
  trusted: TrustedDeviceFixture[] = [],
): ProgrammableD1 {
  const db = new ProgrammableD1();
  // user lookup
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
      sql.includes("WHERE token_hash = ?")
    ) {
      const row = trusted.find((t) => t.token_hash === params[0]);
      return row ?? null;
    }
    if (
      sql.includes("FROM rate_limit_counters") &&
      sql.includes("WHERE key = ?")
    ) {
      return null;
    }
    return undefined;
  });
  return db;
}

function envFor(): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    APP_NAME: "University Hub",
    SESSION_SECRET,
  };
}

async function callSignIn(
  user: UserFixture,
  options: {
    cookies?: Record<string, string>;
    ip?: string;
    trusted?: TrustedDeviceFixture[];
  } = {},
): Promise<{ res: Response; body: SignInResponse | null; db: ProgrammableD1 }> {
  const db = makeSignInDb(user, options.trusted ?? []);
  const env = { ...envFor(), DB: db as unknown as D1Database };
  const cookieHeader = options.cookies
    ? Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("; ")
    : "";
  const headers: HeadersInit = {
    "content-type": "application/json",
    "cf-connecting-ip": options.ip ?? "203.0.113.10",
  };
  if (cookieHeader) (headers as Record<string, string>).cookie = cookieHeader;
  const request = new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers,
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  });
  const ctx: RequestContext = {
    request,
    env,
    url: new URL(request.url),
    cookies: options.cookies ?? {},
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

const REQ_IP = "203.0.113.10";
const OTHER_IP = "203.0.113.99";

async function makeTrustedFixture(
  userId: string,
  options: {
    ip?: string;
    expiresAt?: string;
    rawToken?: string;
  } = {},
): Promise<{ row: TrustedDeviceFixture; rawToken: string }> {
  const rawToken = options.rawToken ?? "raw-trusted-device-token-aaaa";
  const tokenHash = await hashTrustedDeviceToken(rawToken, SESSION_SECRET);
  return {
    rawToken,
    row: {
      id: "td-1",
      user_id: userId,
      token_hash: tokenHash,
      ip_address: options.ip ?? REQ_IP,
      user_agent: "ua",
      expires_at: options.expiresAt ?? "2099-01-01T00:00:00.000Z",
      created_at: "2026-04-01T00:00:00.000Z",
      last_used_at: null,
    },
  };
}

describe("/api/auth/sign-in — UNI-47 trusted-device bypass", () => {
  it("happy path: university_admin with a valid cookie + matching IP skips the MFA challenge", async () => {
    const user = await fixture(
      "university_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    const { row, rawToken } = await makeTrustedFixture(user.id);
    const { res, body, db } = await callSignIn(user, {
      cookies: { university_hub_device_trust: rawToken },
      ip: REQ_IP,
      trusted: [row],
    });
    expect(res.status).toBe(200);
    // Session was issued directly — no MFA challenge.
    expect(body?.status).toBe("ok");
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_session=");
    expect(cookies).not.toContain("university_hub_mfa_challenge=");

    // Audit row for the bypass exists.
    const auditAction = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditAction).toContain("mfa.bypassed_via_trusted_device");
    // last_used_at update fired.
    expect(db.updates("trusted_devices").length).toBeGreaterThan(0);
  });

  it("IP mismatch falls through to the MFA challenge — no bypass audit", async () => {
    const user = await fixture(
      "university_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    const { row, rawToken } = await makeTrustedFixture(user.id, {
      ip: OTHER_IP,
    });
    const { res, body, db } = await callSignIn(user, {
      cookies: { university_hub_device_trust: rawToken },
      ip: REQ_IP,
      trusted: [row],
    });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.trusted_device_eligible).toBe(true);
    }
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_mfa_challenge=");
    expect(cookies).not.toContain("university_hub_session=");
    const auditActions = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).not.toContain("mfa.bypassed_via_trusted_device");
  });

  it("expired cookie falls through and the stale row is deleted", async () => {
    const user = await fixture(
      "university_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    const { row, rawToken } = await makeTrustedFixture(user.id, {
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const { res, body, db } = await callSignIn(user, {
      cookies: { university_hub_device_trust: rawToken },
      ip: REQ_IP,
      trusted: [row],
    });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    const deletes = db.executions.filter((e) =>
      /^DELETE FROM trusted_devices/i.test(e.sql),
    );
    expect(deletes.length).toBeGreaterThan(0);
  });

  it("super_admin is always-MFA — a valid cookie + matching IP does NOT bypass", async () => {
    const user = await fixture(
      "super_admin",
      "00000000-0000-0000-0000-0000bbbbbbbb",
    );
    const { row, rawToken } = await makeTrustedFixture(user.id);
    const { res, body, db } = await callSignIn(user, {
      cookies: { university_hub_device_trust: rawToken },
      ip: REQ_IP,
      trusted: [row],
    });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      // super_admin is never eligible — the SPA hides the checkbox.
      expect(body.trusted_device_eligible).toBe(false);
    }
    const cookies = setCookies(res).join(" | ");
    expect(cookies).toContain("university_hub_mfa_challenge=");
    expect(cookies).not.toContain("university_hub_session=");
    const auditActions = db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).not.toContain("mfa.bypassed_via_trusted_device");
  });

  it("cookie issued for a different user is rejected and the row is dropped", async () => {
    const user = await fixture(
      "university_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    // The cookie hashes to a row whose user_id is someone else.
    const { row, rawToken } = await makeTrustedFixture(
      "11111111-1111-1111-1111-111111111111",
    );
    const { res, body, db } = await callSignIn(user, {
      cookies: { university_hub_device_trust: rawToken },
      ip: REQ_IP,
      trusted: [row],
    });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    // Defensive delete of the cross-user row.
    const deletes = db.executions.filter((e) =>
      /^DELETE FROM trusted_devices/i.test(e.sql),
    );
    expect(deletes.length).toBeGreaterThan(0);
  });

  it("no cookie at all falls through to the regular MFA challenge", async () => {
    const user = await fixture(
      "university_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    const { res, body } = await callSignIn(user, { ip: REQ_IP });
    expect(res.status).toBe(200);
    expect(body?.status).toBe("mfa_required");
    if (body?.status === "mfa_required") {
      expect(body.trusted_device_eligible).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Trusted-device management surface
// ---------------------------------------------------------------------------

const ACTOR_ID = "00000000-0000-0000-0000-aaaaaaaaaaaa";
const OTHER_USER_ID = "11111111-1111-1111-1111-bbbbbbbbbbbb";

function makeListDb(trusted: TrustedDeviceFixture[]): ProgrammableD1 {
  const db = new ProgrammableD1();
  const byUser = new Map<string, TrustedDeviceFixture[]>();
  for (const t of trusted) {
    const arr = byUser.get(t.user_id) ?? [];
    arr.push(t);
    byUser.set(t.user_id, arr);
  }
  db.onAll((sql, params) => {
    if (sql.includes("FROM trusted_devices") && sql.includes("user_id = ?")) {
      const userId = String(params[0]);
      return byUser.get(userId) ?? [];
    }
    return undefined;
  });
  db.onFirst((sql) => {
    if (sql.includes("FROM system_settings") && sql.includes("key = ?")) {
      return { key: "mfa_trusted_device_days", value: "30" };
    }
    return undefined;
  });
  // Mutate on revoke to support multi-step assertions.
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("delete from trusted_devices where id = ?")) {
      const id = String(params[0]);
      for (const [u, rows] of byUser.entries()) {
        byUser.set(
          u,
          rows.filter((r) => r.id !== id),
        );
      }
    }
    if (lower.startsWith("delete from trusted_devices where user_id = ?")) {
      const u = String(params[0]);
      byUser.set(u, []);
    }
  });
  return db;
}

function ctxFor(
  db: ProgrammableD1,
  role: Role = "university_admin",
  userId: string = ACTOR_ID,
): RequestContext {
  const url = new URL("https://hub.example.com/api/auth/trusted-devices");
  const env: Env = {
    DB: db as unknown as D1Database,
    APP_ENV: "development",
    SESSION_SECRET,
  };
  const auth: AuthState = {
    user: {
      id: userId,
      email: "actor@example.com",
      name: "Actor",
      role,
      status: "active",
      university_id: null,
      password_hash: "x",
      last_sign_in_at: null,
      created_at: "2026-05-04T11:00:00.000Z",
      updated_at: "2026-05-04T11:00:00.000Z",
    },
    session: {
      id: "session-1",
      user_id: userId,
      token_hash: "h",
      ip_address: null,
      user_agent: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-05-04T11:00:00.000Z",
      last_activity_at: "2026-05-04T11:55:00.000Z",
    },
  };
  return {
    request: new Request(url, { method: "GET" }),
    env,
    url,
    cookies: {},
    auth,
  };
}

async function jsonBody<T>(res: Response): Promise<T> {
  const raw = (await res.json()) as { data: T };
  return raw.data;
}

describe("GET /api/auth/trusted-devices", () => {
  it("returns the calling user's rows with redacted excerpts and the trust window", async () => {
    const { row } = await makeTrustedFixture(ACTOR_ID, { ip: "203.0.113.42" });
    const db = makeListDb([row]);
    const res = await handleListTrustedDevices(ctxFor(db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      trusted_devices: Array<{
        id: string;
        ip_excerpt: string | null;
      }>;
      trust_window_days: number;
    }>(res);
    expect(body.trusted_devices).toHaveLength(1);
    expect(body.trusted_devices[0]!.ip_excerpt).toBe("203.0.113.0/24");
    expect(body.trust_window_days).toBe(30);
  });
});

describe("DELETE /api/auth/trusted-devices/:id", () => {
  it("revokes the row, audits with reason=manual", async () => {
    const { row } = await makeTrustedFixture(ACTOR_ID);
    const db = makeListDb([row]);
    const res = await handleRevokeTrustedDevice(ctxFor(db), row.id);
    expect(res.status).toBe(200);
    const audits = db.inserts("audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.params[3]).toBe("mfa.trusted_device_revoked");
    expect(String(audits[0]!.params[6])).toContain('"reason":"manual"');
  });

  it("404s when the id doesn't belong to the caller", async () => {
    const db = makeListDb([]);
    const res = await handleRevokeTrustedDevice(
      ctxFor(db),
      "deadbeef-dead-dead-dead-deaddeaddead",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/auth/trusted-devices/revoke-all", () => {
  it("sweeps every row for the caller and writes one audit row per id", async () => {
    const a = await makeTrustedFixture(ACTOR_ID, {
      rawToken: "tok-a",
    });
    const b = await makeTrustedFixture(ACTOR_ID, {
      rawToken: "tok-b",
    });
    b.row.id = "td-2";
    const db = makeListDb([a.row, b.row]);
    const res = await handleRevokeAllTrustedDevices(ctxFor(db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ revoked_count: number }>(res);
    expect(body.revoked_count).toBe(2);
    const audits = db
      .inserts("audit_logs")
      .filter((e) => e.params[3] === "mfa.trusted_device_revoked");
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(String(row.params[6])).toContain('"reason":"revoke_all"');
    }
  });
});

describe("super_admin admin-of-other surfaces", () => {
  it("403s when a university_admin tries to revoke another user's devices", async () => {
    const { row } = await makeTrustedFixture(OTHER_USER_ID);
    const db = makeListDb([row]);
    const res = await handleAdminRevokeAllTrustedDevices(
      ctxFor(db, "university_admin"),
      OTHER_USER_ID,
    );
    expect(res.status).toBe(403);
    expect(db.inserts("audit_logs")).toHaveLength(0);
  });

  it("super_admin can list and revoke another user's devices", async () => {
    const { row } = await makeTrustedFixture(OTHER_USER_ID);
    const db = makeListDb([row]);
    const list = await handleAdminListTrustedDevices(
      ctxFor(db, "super_admin", "actor-super"),
      OTHER_USER_ID,
    );
    expect(list.status).toBe(200);
    const body = await jsonBody<{
      trusted_devices: unknown[];
    }>(list);
    expect(body.trusted_devices).toHaveLength(1);

    const revoke = await handleAdminRevokeAllTrustedDevices(
      ctxFor(db, "super_admin", "actor-super"),
      OTHER_USER_ID,
    );
    expect(revoke.status).toBe(200);
    const audits = db
      .inserts("audit_logs")
      .filter((e) => e.params[3] === "mfa.trusted_device_revoked");
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!.params[6])).toContain('"reason":"admin_revoke"');
    expect(String(audits[0]!.params[6])).toContain(
      `"target_user_id":"${OTHER_USER_ID}"`,
    );
  });
});
