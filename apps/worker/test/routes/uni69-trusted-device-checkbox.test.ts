// UNI-69 regression: ticking "Trust this device" on the MFA challenge page
// must not 500. The original symptom was a generic
// "An unexpected error occurred while handling the request." response
// because `recordFingerprintMfaSuccess` always inserted
// `trusted_devices.token_hash = ""`, while the column carries a
// `NOT NULL UNIQUE` constraint — so the second fingerprint-only row
// (different user, or same user from a second device) collided with the
// first and threw out of the route handler into the global 500 catcher.
//
// Acceptance criteria from the issue:
//
//   1. Submitting valid creds + valid TOTP with "Remember this device"
//      checked completes sign-in on the first attempt, sets the
//      trusted-device row, and the generic 500 is gone from this happy
//      path.
//   2. Subsequent fingerprint-only INSERTs from the same or different
//      users coexist without colliding.
//
// These tests cover both the non-admin (UNI-49 fingerprint) path that
// was actually broken AND the university_admin (UNI-47 cookie) path,
// since the user-facing checkbox renders for both roles. The crucial
// case is the third one — it sets up the exact precondition (a prior
// fingerprint-only row already on the table) that made every later
// "Trust this device" tick blow up before this fix.

import { describe, expect, it } from "vitest";

import type { Role } from "@university-hub/shared";

import { createMfaChallenge } from "../../src/auth/mfa-challenge.js";
import { hashPassword } from "../../src/auth/password.js";
import { generateTotpCode } from "../../src/auth/totp.js";
import {
  FINGERPRINT_ONLY_TOKEN_PREFIX,
  isFingerprintOnlyTokenHash,
  recordFingerprintMfaSuccess,
} from "../../src/auth/trusted-device.js";
import type { Env } from "../../src/env.js";
import type { RequestContext } from "../../src/middleware/auth.js";
import { handleMfaChallenge } from "../../src/routes/mfa.js";
import { ProgrammableD1, type RecordedExec } from "../helpers/programmable-d1.js";

const PASSWORD = "DevPassword!2026";
const SECRET = "JBSWY3DPEHPK3PXP";
const SESSION_SECRET = "test-session-secret-fixture";
const REQ_IP = "203.0.113.10";
const HEADERS_DEFAULT: Record<string, string> = {
  "content-type": "application/json",
  "cf-connecting-ip": REQ_IP,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.6099.71 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
};

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

async function userFixture(role: Role, id: string): Promise<UserFixture> {
  return {
    id,
    email: `${role}-${id.slice(0, 8)}@example.com`,
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
    SESSION_SECRET,
  };
}

interface SeededTrustedDeviceRow {
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

/**
 * In-memory `trusted_devices` store shaped like the production schema
 * (UNI-47 + UNI-49) PLUS the column-level `NOT NULL UNIQUE` constraint
 * on `token_hash` enforced locally so this test catches the original
 * bug. `ProgrammableD1` does not enforce SQLite constraints, which is
 * why the existing test suite passed even though production was broken.
 */
class FakeTrustedDevicesStore {
  readonly rows: SeededTrustedDeviceRow[] = [];

  insert(params: readonly unknown[]): void {
    const [
      id,
      user_id,
      token_hash,
      ip_address,
      user_agent,
      expires_at,
      created_at,
      device_fingerprint_hash,
      label,
      first_seen_at,
      last_seen_at,
      last_mfa_at,
    ] = params as [
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    if (token_hash === null || token_hash === undefined) {
      throw new Error("NOT NULL constraint failed: trusted_devices.token_hash");
    }
    if (this.rows.some((r) => r.token_hash === token_hash)) {
      // Mirrors the SQLite UNIQUE constraint on `token_hash` — the
      // exact failure mode that surfaced as the user-reported 500.
      throw new Error(
        `UNIQUE constraint failed: trusted_devices.token_hash (value=${token_hash})`,
      );
    }
    this.rows.push({
      id,
      user_id,
      token_hash,
      ip_address,
      user_agent,
      expires_at,
      created_at,
      last_used_at: null,
      device_fingerprint_hash,
      label,
      first_seen_at,
      last_seen_at,
      last_mfa_at,
    });
  }

  findByUserAndFingerprint(
    user_id: string,
    fp: string,
  ): SeededTrustedDeviceRow | null {
    return (
      this.rows
        .filter(
          (r) => r.user_id === user_id && r.device_fingerprint_hash === fp,
        )
        .sort((a, b) =>
          (b.last_mfa_at ?? b.created_at).localeCompare(
            a.last_mfa_at ?? a.created_at,
          ),
        )[0] ?? null
    );
  }
}

interface DbWithStore {
  db: ProgrammableD1;
  store: FakeTrustedDevicesStore;
}

function makeDb(
  user: UserFixture,
  store: FakeTrustedDevicesStore = new FakeTrustedDevicesStore(),
): DbWithStore {
  const db = new ProgrammableD1();
  const challenges: Record<
    string,
    { id: string; user_id: string; token_hash: string; expires_at: string; created_at: string }
  > = {};

  db.onWrite((sql, params) => {
    if (sql.startsWith("INSERT INTO mfa_challenges")) {
      const [id, user_id, token_hash, , , expires_at] = params as [
        string,
        string,
        string,
        unknown,
        unknown,
        string,
      ];
      challenges[token_hash] = {
        id,
        user_id,
        token_hash,
        expires_at,
        created_at: new Date().toISOString(),
      };
    }
    if (sql.startsWith("DELETE FROM mfa_challenges WHERE token_hash = ?")) {
      delete challenges[String(params[0])];
    }
    if (sql.startsWith("DELETE FROM mfa_challenges WHERE user_id = ?")) {
      const uid = String(params[0]);
      for (const [hash, row] of Object.entries(challenges)) {
        if (row.user_id === uid) delete challenges[hash];
      }
    }
    if (sql.startsWith("INSERT INTO trusted_devices")) {
      store.insert(params);
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
    if (sql.includes("FROM users") && sql.includes("WHERE id = ?")) {
      return params[0] === user.id ? user : null;
    }
    if (sql.includes("FROM users") && sql.includes("WHERE email = ?")) {
      return params[0] === user.email ? user : null;
    }
    if (
      sql.includes("FROM mfa_challenges") &&
      sql.includes("WHERE token_hash = ?")
    ) {
      return challenges[String(params[0])] ?? null;
    }
    if (
      sql.includes("FROM trusted_devices") &&
      sql.includes("WHERE user_id = ?") &&
      sql.includes("AND device_fingerprint_hash = ?")
    ) {
      return store.findByUserAndFingerprint(
        String(params[0]),
        String(params[1]),
      );
    }
    if (
      sql.includes("FROM system_settings") &&
      sql.includes("WHERE key = ?")
    ) {
      return null;
    }
    return undefined;
  });

  return { db, store };
}

async function callChallenge(args: {
  db: ProgrammableD1;
  challengeToken: string;
  rememberDevice: boolean;
  headers?: Record<string, string>;
}): Promise<Response> {
  const env: Env = { ...envFor(), DB: args.db as unknown as D1Database };
  const headers: Record<string, string> = {
    ...HEADERS_DEFAULT,
    "x-mfa-challenge-token": args.challengeToken,
    ...(args.headers ?? {}),
  };
  const code = await generateTotpCode(SECRET);
  const request = new Request("http://localhost/api/auth/mfa/challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ code, remember_device: args.rememberDevice }),
  });
  const ctx: RequestContext = {
    request,
    env,
    url: new URL(request.url),
    cookies: {},
    auth: null,
  };
  return handleMfaChallenge(ctx);
}

async function seedChallengeRow(
  db: ProgrammableD1,
  user: UserFixture,
): Promise<string> {
  const created = await createMfaChallenge(db as unknown as D1Database, {
    userId: user.id,
    ipAddress: REQ_IP,
    userAgent: HEADERS_DEFAULT["user-agent"]!,
  });
  return created.token;
}

function trustedDeviceInserts(db: ProgrammableD1): RecordedExec[] {
  return db.inserts("trusted_devices");
}

function setCookies(res: Response): string[] {
  const out: string[] = [];
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") out.push(v);
  });
  return out;
}

describe("UNI-69: 'Trust this device' on /api/auth/mfa/challenge no longer 500s", () => {
  it("recordFingerprintMfaSuccess assigns a unique token_hash per row (not the empty-string sentinel)", async () => {
    // The original bug: every fingerprint-only row was inserted with
    // `token_hash = ""`, colliding with itself the moment two rows
    // existed. This pins the contract that every row carries a unique
    // value AND that each value is recognised as fingerprint-only.
    const store = new FakeTrustedDevicesStore();
    const db = new ProgrammableD1();
    db.onWrite((sql, params) => {
      if (sql.startsWith("INSERT INTO trusted_devices")) {
        store.insert(params);
      }
    });
    db.onFirst(() => null);

    const userA = "00000000-0000-0000-0000-000000000aaa";
    const userB = "00000000-0000-0000-0000-000000000bbb";

    const a = await recordFingerprintMfaSuccess(db as unknown as D1Database, {
      userId: userA,
      deviceFingerprintHash: "fp-aaa",
      label: "Chrome on macOS",
      ipAddress: REQ_IP,
      userAgent: HEADERS_DEFAULT["user-agent"]!,
    });
    const b = await recordFingerprintMfaSuccess(db as unknown as D1Database, {
      userId: userB,
      deviceFingerprintHash: "fp-bbb",
      label: "Firefox on Linux",
      ipAddress: REQ_IP,
      userAgent: HEADERS_DEFAULT["user-agent"]!,
    });
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
    expect(store.rows).toHaveLength(2);
    const [rowA, rowB] = store.rows;
    expect(rowA!.token_hash).not.toBe(rowB!.token_hash);
    expect(rowA!.token_hash.startsWith(FINGERPRINT_ONLY_TOKEN_PREFIX)).toBe(true);
    expect(rowB!.token_hash.startsWith(FINGERPRINT_ONLY_TOKEN_PREFIX)).toBe(true);
    expect(isFingerprintOnlyTokenHash(rowA!.token_hash)).toBe(true);
    expect(isFingerprintOnlyTokenHash(rowB!.token_hash)).toBe(true);
  });

  it("recordFingerprintMfaSuccess UPDATEs an existing (user, fingerprint) row instead of inserting a duplicate", async () => {
    // Make sure the fix did not regress the in-place refresh path.
    const store = new FakeTrustedDevicesStore();
    const db = new ProgrammableD1();
    db.onWrite((sql, params) => {
      if (sql.startsWith("INSERT INTO trusted_devices")) {
        store.insert(params);
      }
    });
    db.onFirst((sql, params) => {
      if (
        sql.includes("FROM trusted_devices") &&
        sql.includes("WHERE user_id = ?") &&
        sql.includes("AND device_fingerprint_hash = ?")
      ) {
        return store.findByUserAndFingerprint(
          String(params[0]),
          String(params[1]),
        );
      }
      return undefined;
    });

    const userId = "00000000-0000-0000-0000-000000000ccc";
    const first = await recordFingerprintMfaSuccess(
      db as unknown as D1Database,
      {
        userId,
        deviceFingerprintHash: "fp-same",
        label: "Chrome on macOS",
        ipAddress: REQ_IP,
        userAgent: "ua-1",
      },
    );
    const second = await recordFingerprintMfaSuccess(
      db as unknown as D1Database,
      {
        userId,
        deviceFingerprintHash: "fp-same",
        label: "Chrome on macOS",
        ipAddress: REQ_IP,
        userAgent: "ua-2",
      },
    );
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    expect(store.rows).toHaveLength(1);
  });

  it("happy path: faculty user ticks 'Trust this device' with a valid TOTP → 200, session issued, fingerprint row written, no 500", async () => {
    // This is the user-reported scenario after the fix. Pre-fix: this
    // request 500'd with "An unexpected error occurred while handling
    // the request." because the second fingerprint-only INSERT collided
    // on `token_hash`. Post-fix: the new row carries a unique sentinel
    // and the request succeeds.
    const user = await userFixture(
      "faculty",
      "00000000-0000-0000-0000-000000fac111",
    );
    const store = new FakeTrustedDevicesStore();
    // Seed an existing fingerprint-only row for ANOTHER user. This is
    // the precondition that broke production: any single existing row
    // with `token_hash=""` made every subsequent fingerprint INSERT
    // fail UNIQUE.
    store.rows.push({
      id: "td-existing",
      user_id: "00000000-0000-0000-0000-000000fac999",
      token_hash: "", // legacy sentinel — exactly what production carried
      ip_address: "198.51.100.42",
      user_agent: "Mozilla/5.0",
      expires_at: "9999-12-31T23:59:59.000Z",
      created_at: "2026-04-01T00:00:00.000Z",
      last_used_at: null,
      device_fingerprint_hash: "fp-existing",
      label: "Chrome on Linux",
      first_seen_at: "2026-04-01T00:00:00.000Z",
      last_seen_at: "2026-04-01T00:00:00.000Z",
      last_mfa_at: "2026-04-01T00:00:00.000Z",
    });

    const ctx = makeDb(user, store);
    const challengeToken = await seedChallengeRow(ctx.db, user);
    const res = await callChallenge({
      db: ctx.db,
      challengeToken,
      rememberDevice: true,
    });
    const text = await res.clone().text();
    expect(res.status, `body=${text}`).toBe(200);
    expect(setCookies(res).join(" | ")).toContain("university_hub_session=");

    // Both the legacy row and the new fingerprint-only row coexist
    // with distinct token_hash values. Pre-fix this was impossible;
    // post-fix it is the new contract.
    expect(ctx.store.rows).toHaveLength(2);
    const fingerprintRows = ctx.store.rows.filter((r) =>
      isFingerprintOnlyTokenHash(r.token_hash),
    );
    expect(fingerprintRows).toHaveLength(2);
    expect(new Set(fingerprintRows.map((r) => r.token_hash)).size).toBe(2);

    // Audit rows from the challenge handler are present.
    const auditActions = ctx.db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).toContain("mfa.device_seen");
    expect(auditActions).toContain("mfa.challenge_passed");
    expect(auditActions).toContain("auth.sign_in");
  });

  it("rememberDevice=false does NOT write a trusted_devices row from /challenge", async () => {
    // The unchecked-checkbox path was never broken; pin the contract
    // so a future tweak doesn't accidentally start writing rows for
    // users who declined to trust the device.
    const user = await userFixture(
      "faculty",
      "00000000-0000-0000-0000-000000fac222",
    );
    const ctx = makeDb(user);
    const challengeToken = await seedChallengeRow(ctx.db, user);
    const res = await callChallenge({
      db: ctx.db,
      challengeToken,
      rememberDevice: false,
    });
    expect(res.status).toBe(200);
    expect(trustedDeviceInserts(ctx.db)).toHaveLength(0);
  });

  it("university_admin ticks the box → cookie path inserts a row with a hex token_hash, no UNIQUE collision with an existing fingerprint-only row", async () => {
    // The user-reported wording was "remember security device" and the
    // checkbox renders for university_admin too — so cover that route's
    // INSERT alongside the fingerprint path. Pre-fix this also failed
    // when a legacy `""` row existed because the SAME UNIQUE constraint
    // covers all rows; post-fix the cookie-path INSERT writes a 64-char
    // hex `token_hash` that cannot collide with any fingerprint
    // sentinel.
    const user = await userFixture(
      "university_admin",
      "00000000-0000-0000-0000-0000aaaaaaaa",
    );
    const store = new FakeTrustedDevicesStore();
    store.rows.push({
      id: "td-existing-fp",
      user_id: "00000000-0000-0000-0000-000000fac999",
      token_hash: "", // legacy fingerprint sentinel
      ip_address: REQ_IP,
      user_agent: "ua",
      expires_at: "9999-12-31T23:59:59.000Z",
      created_at: "2026-04-01T00:00:00.000Z",
      last_used_at: null,
      device_fingerprint_hash: "fp-other",
      label: "ua",
      first_seen_at: "2026-04-01T00:00:00.000Z",
      last_seen_at: "2026-04-01T00:00:00.000Z",
      last_mfa_at: "2026-04-01T00:00:00.000Z",
    });

    const ctx = makeDb(user, store);
    const challengeToken = await seedChallengeRow(ctx.db, user);
    const res = await callChallenge({
      db: ctx.db,
      challengeToken,
      rememberDevice: true,
    });
    expect(res.status).toBe(200);
    const inserts = trustedDeviceInserts(ctx.db);
    expect(inserts).toHaveLength(1);
    const tokenHash = inserts[0]!.params[2] as string;
    // Real cookie hash: 64 lowercase hex chars from HMAC-SHA-256.
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(isFingerprintOnlyTokenHash(tokenHash)).toBe(false);

    const joined = setCookies(res).join(" | ");
    expect(joined).toContain("university_hub_session=");
    expect(joined).toContain("university_hub_device_trust=");
    const auditActions = ctx.db
      .inserts("audit_logs")
      .map((e) => e.params[3] as string);
    expect(auditActions).toContain("mfa.trusted_device_granted");
  });

  it("isFingerprintOnlyTokenHash recognises both legacy '' and new fp_only:* sentinels but rejects real cookie hashes", () => {
    expect(isFingerprintOnlyTokenHash("")).toBe(true);
    expect(isFingerprintOnlyTokenHash("fp_only:1234")).toBe(true);
    expect(
      isFingerprintOnlyTokenHash(
        "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      ),
    ).toBe(false);
  });
});
