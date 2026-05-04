// Tests for the UNI-26 session lifecycle wiring in middleware/auth.ts.
//
// Two layers are exercised:
//   1. sessionTimeoutReason() — the pure function deciding idle vs absolute.
//   2. buildContext() — the full path that resolves the cookie, applies the
//      timeout, deletes the row, writes the `session.revoked` audit entry,
//      and otherwise slides the idle window forward by touching
//      last_activity_at.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashSessionToken } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import {
  buildContext,
  sessionTimeoutReason,
} from "../../src/middleware/auth.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SESSION_TOKEN = "session-token-fixture";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    APP_ENV: "development",
    SESSION_COOKIE_NAME: "test_session",
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

// Light proof that the cookie hashing path is wired (we resolve sessions by
// hash, not raw token). Not strictly part of UNI-26 but the new tests above
// rely on the hash function being a pure helper, so a sanity check is cheap.
describe("hashSessionToken()", () => {
  it("emits a 64-char lowercase hex SHA-256", async () => {
    const out = await hashSessionToken("hello");
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]+$/);
  });
});

