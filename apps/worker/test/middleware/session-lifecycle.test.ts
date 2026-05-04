// Tests for the UNI-26 session lifecycle wiring in middleware/auth.ts.
//
// Two layers are exercised:
//   1. sessionTimeoutReason() — the pure function deciding idle vs absolute.
//   2. buildContext() — the full path that resolves the cookie, applies the
//      timeout, deletes the row, writes the `session.revoked` audit entry,
//      and otherwise slides the idle window forward by touching
//      last_activity_at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSession,
  hashSessionToken,
  resolveSessionByToken,
} from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import {
  buildContext,
  sessionTimeoutReason,
} from "../../src/middleware/auth.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SESSION_TOKEN = "session-token-fixture";
const TEST_SESSION_SECRET = "test-session-secret-fixture";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    SESSION_COOKIE_NAME: "test_session",
    SESSION_SECRET: TEST_SESSION_SECRET,
    ...overrides,
  };
}

function makeSessionRow(opts: {
  createdAt: string;
  lastActivityAt: string;
  expiresAt?: string;
}) {
  return {
    id: "session-1",
    user_id: "user-1",
    token_hash: "h",
    ip_address: "203.0.113.10",
    user_agent: "Mozilla/5.0",
    expires_at: opts.expiresAt ?? "2099-01-01T00:00:00.000Z",
    created_at: opts.createdAt,
    last_activity_at: opts.lastActivityAt,
  };
}

describe("sessionTimeoutReason()", () => {
  const env = makeEnv();

  it("returns null for a session active inside both windows", () => {
    const session = makeSessionRow({
      createdAt: "2026-05-04T09:00:00.000Z",
      lastActivityAt: "2026-05-04T09:25:00.000Z",
    });
    const now = new Date("2026-05-04T09:30:00.000Z");
    expect(sessionTimeoutReason(env, session, now)).toBeNull();
  });

  it("returns 'idle_timeout' once last_activity_at exceeds the idle window", () => {
    const session = makeSessionRow({
      createdAt: "2026-05-04T09:00:00.000Z",
      // 31 minutes ago — above the 30-minute default
      lastActivityAt: "2026-05-04T08:59:00.000Z",
    });
    const now = new Date("2026-05-04T09:30:30.000Z");
    expect(sessionTimeoutReason(env, session, now)).toBe("idle_timeout");
  });

  it("returns 'absolute_timeout' once created_at is past the absolute window", () => {
    const session = makeSessionRow({
      // 13 hours ago — above the 12-hour default
      createdAt: "2026-05-03T20:00:00.000Z",
      // active, so idle does not fire
      lastActivityAt: "2026-05-04T08:55:00.000Z",
    });
    const now = new Date("2026-05-04T09:00:00.000Z");
    expect(sessionTimeoutReason(env, session, now)).toBe("absolute_timeout");
  });

  it("idle wins over absolute when both fire on the same request", () => {
    const session = makeSessionRow({
      createdAt: "2026-05-03T20:00:00.000Z",
      lastActivityAt: "2026-05-04T07:00:00.000Z",
    });
    const now = new Date("2026-05-04T09:00:00.000Z");
    expect(sessionTimeoutReason(env, session, now)).toBe("idle_timeout");
  });

  it("respects custom env overrides", () => {
    const tightenedIdle = makeEnv({ SESSION_IDLE_TIMEOUT_SECONDS: "60" });
    const session = makeSessionRow({
      createdAt: "2026-05-04T09:00:00.000Z",
      lastActivityAt: "2026-05-04T09:25:00.000Z",
    });
    const now = new Date("2026-05-04T09:30:00.000Z");
    expect(sessionTimeoutReason(tightenedIdle, session, now)).toBe(
      "idle_timeout",
    );
  });
});

describe("buildContext() — idle + absolute timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRequest(): Request {
    return new Request("http://localhost/api/dashboard/summary", {
      headers: { cookie: `test_session=${encodeURIComponent(SESSION_TOKEN)}` },
    });
  }

  function setupDb(opts: {
    createdAt: string;
    lastActivityAt: string;
  }): ProgrammableD1 {
    const db = new ProgrammableD1();
    db.onFirst((sql) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return {
          id: "session-1",
          user_id: "user-1",
          token_hash: "ignored",
          ip_address: "203.0.113.10",
          user_agent: "Mozilla/5.0",
          expires_at: "2099-01-01T00:00:00.000Z",
          created_at: opts.createdAt,
          last_activity_at: opts.lastActivityAt,
          u_id: "user-1",
          u_email: "u@example.com",
          u_name: "U",
          u_role: "staff",
          u_status: "active",
          u_university_id: null,
          u_password_hash: "x",
          u_last_sign_in_at: null,
          u_created_at: opts.createdAt,
          u_updated_at: opts.createdAt,
        };
      }
      return undefined;
    });
    return db;
  }

  it("authenticates a fresh session and slides the idle window forward", async () => {
    const db = setupDb({
      createdAt: "2026-05-04T11:30:00.000Z",
      lastActivityAt: "2026-05-04T11:55:00.000Z",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const ctx = await buildContext(makeRequest(), env);

    expect(ctx.auth).not.toBeNull();
    expect(ctx.auth?.session.id).toBe("session-1");
    expect(ctx.auth?.session.last_activity_at).toBe(
      "2026-05-04T12:00:00.000Z",
    );
    // last_activity_at write
    const updates = db.updates("sessions");
    expect(updates.length).toBe(1);
    expect(String(updates[0]!.params[0])).toBe("2026-05-04T12:00:00.000Z");
    // No DELETE / no audit
    expect(db.executions.some((e) => /^DELETE FROM sessions/i.test(e.sql))).toBe(
      false,
    );
    expect(db.inserts("audit_logs").length).toBe(0);
  });

  it("idle-times-out a stale session, deletes the row, and audits the reason", async () => {
    const db = setupDb({
      createdAt: "2026-05-04T11:00:00.000Z",
      // 31 min ago — past the 30 min default
      lastActivityAt: "2026-05-04T11:29:00.000Z",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const ctx = await buildContext(makeRequest(), env);

    expect(ctx.auth).toBeNull();
    const deletes = db.executions.filter((e) =>
      /^DELETE FROM sessions/i.test(e.sql),
    );
    expect(deletes.length).toBe(1);
    expect(String(deletes[0]!.params[0])).toBe("session-1");

    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    expect(audits[0]!.params[3]).toBe("session.revoked");
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"reason":"idle_timeout"');
    expect(meta).toContain('"idle_timeout_seconds":1800');
  });

  it("absolute-times-out a long-lived session that is still active", async () => {
    const db = setupDb({
      // 13 h ago — past the 12 h default
      createdAt: "2026-05-03T22:59:00.000Z",
      lastActivityAt: "2026-05-04T11:59:00.000Z",
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const ctx = await buildContext(makeRequest(), env);

    expect(ctx.auth).toBeNull();
    const audits = db.inserts("audit_logs");
    expect(audits.length).toBe(1);
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"reason":"absolute_timeout"');
  });

  it("does not authenticate a non-active user and does not bump activity", async () => {
    const db = new ProgrammableD1();
    db.onFirst((sql) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return {
          id: "session-1",
          user_id: "user-1",
          token_hash: "ignored",
          ip_address: null,
          user_agent: null,
          expires_at: "2099-01-01T00:00:00.000Z",
          created_at: "2026-05-04T11:55:00.000Z",
          last_activity_at: "2026-05-04T11:55:00.000Z",
          u_id: "user-1",
          u_email: "u@example.com",
          u_name: "U",
          u_role: "staff",
          u_status: "suspended",
          u_university_id: null,
          u_password_hash: "x",
          u_last_sign_in_at: null,
          u_created_at: "2026-05-04T11:55:00.000Z",
          u_updated_at: "2026-05-04T11:55:00.000Z",
        };
      }
      return undefined;
    });
    const env = makeEnv({ DB: db as unknown as D1Database });
    const ctx = await buildContext(makeRequest(), env);

    expect(ctx.auth).toBeNull();
    expect(db.updates("sessions").length).toBe(0);
    expect(db.inserts("audit_logs").length).toBe(0);
  });
});

// Cookie hashing path. The token_hash stored in D1 is HMAC-SHA-256 of the
// raw token keyed by SESSION_SECRET (UNI-37); changing the secret changes
// the output and is what gives operators a sign-everyone-out lever during
// breach containment.
describe("hashSessionToken()", () => {
  it("emits a 64-char lowercase hex HMAC-SHA-256", async () => {
    const out = await hashSessionToken("hello", TEST_SESSION_SECRET);
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different output for the same token under a different secret", async () => {
    const a = await hashSessionToken("hello", "secret-a");
    const b = await hashSessionToken("hello", "secret-b");
    expect(a).not.toBe(b);
  });

  it("is stable for the same (token, secret) pair", async () => {
    const a = await hashSessionToken("hello", TEST_SESSION_SECRET);
    const b = await hashSessionToken("hello", TEST_SESSION_SECRET);
    expect(a).toBe(b);
  });
});

describe("SESSION_SECRET wiring (UNI-37)", () => {
  it("createSession refuses to mint when SESSION_SECRET is unset", async () => {
    const db = new ProgrammableD1();
    const env = makeEnv({
      DB: db as unknown as D1Database,
      SESSION_SECRET: undefined,
    });
    await expect(createSession(env, { userId: "user-1" })).rejects.toThrow(
      /SESSION_SECRET/,
    );
    // Nothing should have been written.
    expect(db.inserts("sessions").length).toBe(0);
  });

  it("createSession stores HMAC-keyed token_hash, not plain SHA-256", async () => {
    const db = new ProgrammableD1();
    const env = makeEnv({ DB: db as unknown as D1Database });

    const created = await createSession(env, { userId: "user-1" });

    const inserts = db.inserts("sessions");
    expect(inserts.length).toBe(1);
    const storedHash = String(inserts[0]!.params[2]);
    const expectedHmac = await hashSessionToken(
      created.token,
      TEST_SESSION_SECRET,
    );
    expect(storedHash).toBe(expectedHmac);

    // Make sure we are NOT storing the unkeyed SHA-256 (regression guard
    // for the pre-UNI-37 behavior where the secret was dead weight).
    const plainSha256 = await (async () => {
      const data = new TextEncoder().encode(created.token);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const arr = new Uint8Array(digest);
      let out = "";
      for (let i = 0; i < arr.length; i++) {
        out += (arr[i] ?? 0).toString(16).padStart(2, "0");
      }
      return out;
    })();
    expect(storedHash).not.toBe(plainSha256);
  });

  it("rotating SESSION_SECRET invalidates outstanding sessions on resolve", async () => {
    // The DB is keyed by token_hash. We seed a row produced under the
    // *old* secret, then resolve the same raw token under the *new*
    // secret — the lookup should miss, which is the runbook property.
    const tokenInUse = "raw-token-fixture-abc";
    const oldSecret = "old-secret-2025";
    const newSecret = "rotated-secret-2026";
    const oldHash = await hashSessionToken(tokenInUse, oldSecret);

    const db = new ProgrammableD1();
    db.onFirst((sql, params) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        // Only return the seeded row when the lookup hash matches the
        // value derived under the OLD secret. Otherwise miss.
        if (String(params[0]) === oldHash) {
          return {
            id: "session-1",
            user_id: "user-1",
            token_hash: oldHash,
            ip_address: null,
            user_agent: null,
            expires_at: "2099-01-01T00:00:00.000Z",
            created_at: "2026-05-04T11:00:00.000Z",
            last_activity_at: "2026-05-04T11:00:00.000Z",
            u_id: "user-1",
            u_email: "u@example.com",
            u_name: "U",
            u_role: "staff",
            u_status: "active",
            u_university_id: null,
            u_password_hash: "x",
            u_last_sign_in_at: null,
            u_created_at: "2026-05-04T11:00:00.000Z",
            u_updated_at: "2026-05-04T11:00:00.000Z",
          };
        }
        return undefined;
      }
      return undefined;
    });

    // Pre-rotation: same token under the old secret resolves.
    const before = await resolveSessionByToken(
      makeEnv({
        DB: db as unknown as D1Database,
        SESSION_SECRET: oldSecret,
      }),
      tokenInUse,
    );
    expect(before).not.toBeNull();
    expect(before?.session.id).toBe("session-1");

    // Post-rotation: same token under the new secret no longer resolves.
    const after = await resolveSessionByToken(
      makeEnv({
        DB: db as unknown as D1Database,
        SESSION_SECRET: newSecret,
      }),
      tokenInUse,
    );
    expect(after).toBeNull();
  });
});

