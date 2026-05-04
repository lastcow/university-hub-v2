// Tests for src/middleware/rate-limit.ts (UNI-25). Covers:
//   - increment + reset behavior across the configured window
//   - 429 emission with Retry-After header + envelope shape
//   - per-key isolation (different IPs / emails / sessions don't bleed)
//   - the four composable limiters
//   - applyGenericLimit auth/anonymous routing + /api/health bypass
//
// Backed by an in-memory stand-in for the rate_limit_counters table — we
// don't need ProgrammableD1's full machinery here since the schema is one
// table with three columns. A controllable clock lets the tests advance
// time without sleeping.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/env.js";
import {
  applyGenericLimit,
  bySession,
  byEmail,
  byIp,
  byIpEmail,
  rateLimitedResponse,
} from "../../src/middleware/rate-limit.js";

interface CounterRow {
  count: number;
  window_started_at: number;
  expires_at: number;
}

class InMemoryRateLimitDB {
  readonly store = new Map<string, CounterRow>();

  prepare(sql: string): Statement {
    return new Statement(this, sql, []);
  }
}

class Statement {
  constructor(
    private readonly db: InMemoryRateLimitDB,
    private readonly sql: string,
    private readonly params: readonly unknown[],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const sql = normalize(this.sql);
    if (sql.startsWith("SELECT count, expires_at FROM rate_limit_counters")) {
      const key = this.params[0] as string;
      const row = this.db.store.get(key);
      if (!row) return null;
      return { count: row.count, expires_at: row.expires_at } as unknown as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number; last_row_id: number | null } }> {
    const sql = normalize(this.sql);
    if (sql.startsWith("PRAGMA")) {
      return { meta: { changes: 0, last_row_id: null } };
    }
    if (sql.startsWith("INSERT INTO rate_limit_counters")) {
      // INSERT ... ON CONFLICT DO UPDATE SET count=1, window_started_at=?, expires_at=?
      // Param order: [key, now, expiresAt, now, expiresAt]
      const [key, now, expiresAt] = this.params as [string, number, number, number, number];
      this.db.store.set(key, {
        count: 1,
        window_started_at: now,
        expires_at: expiresAt,
      });
      return { meta: { changes: 1, last_row_id: null } };
    }
    if (sql.startsWith("UPDATE rate_limit_counters SET count = count + 1")) {
      const key = this.params[0] as string;
      const row = this.db.store.get(key);
      if (row) row.count += 1;
      return { meta: { changes: row ? 1 : 0, last_row_id: null } };
    }
    return { meta: { changes: 0, last_row_id: null } };
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function makeEnv(overrides: Partial<Env> = {}): { env: Env; db: InMemoryRateLimitDB } {
  const db = new InMemoryRateLimitDB();
  const env: Env = {
    DB: db as unknown as D1Database,
    APP_ENV: "development",
    ...overrides,
  };
  return { env, db };
}

describe("consume() — sign-in (byIpEmail)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows the first 5 attempts and denies the 6th in one 15-min window", async () => {
    const { env } = makeEnv();
    const ip = "203.0.113.7";
    const email = "victim@example.com";

    for (let i = 1; i <= 5; i += 1) {
      const out = await byIpEmail(env, "auth.sign_in", ip, email, {
        limit: 5,
        windowSeconds: 15 * 60,
      });
      expect(out.allowed).toBe(true);
      expect(out.count).toBe(i);
    }

    const sixth = await byIpEmail(env, "auth.sign_in", ip, email, {
      limit: 5,
      windowSeconds: 15 * 60,
    });
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it("a correct credential is still locked out until the window resets", async () => {
    const { env } = makeEnv();
    const ip = "203.0.113.7";
    const email = "victim@example.com";

    for (let i = 1; i <= 5; i += 1) {
      await byIpEmail(env, "auth.sign_in", ip, email, {
        limit: 5,
        windowSeconds: 15 * 60,
      });
    }

    // 14 minutes later — still inside the window
    vi.setSystemTime(new Date("2026-05-04T12:14:00Z"));
    const stillDenied = await byIpEmail(env, "auth.sign_in", ip, email, {
      limit: 5,
      windowSeconds: 15 * 60,
    });
    expect(stillDenied.allowed).toBe(false);

    // 16 minutes after the first attempt — window has reset
    vi.setSystemTime(new Date("2026-05-04T12:16:00Z"));
    const allowedAgain = await byIpEmail(env, "auth.sign_in", ip, email, {
      limit: 5,
      windowSeconds: 15 * 60,
    });
    expect(allowedAgain.allowed).toBe(true);
    expect(allowedAgain.count).toBe(1);
  });

  it("isolates different (IP, email) pairs", async () => {
    const { env } = makeEnv();

    // attacker hammers victim from one IP
    for (let i = 0; i < 5; i += 1) {
      await byIpEmail(env, "auth.sign_in", "203.0.113.7", "victim@example.com", {
        limit: 5,
        windowSeconds: 15 * 60,
      });
    }
    // a different IP signing in as the same email should also have its own bucket
    const otherIp = await byIpEmail(env, "auth.sign_in", "198.51.100.1", "victim@example.com", {
      limit: 5,
      windowSeconds: 15 * 60,
    });
    expect(otherIp.allowed).toBe(true);

    // and the original IP signing in as a different user is also fresh
    const otherEmail = await byIpEmail(env, "auth.sign_in", "203.0.113.7", "other@example.com", {
      limit: 5,
      windowSeconds: 15 * 60,
    });
    expect(otherEmail.allowed).toBe(true);
  });
});

describe("byEmail (password reset)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps password-reset requests at 3 per email per hour", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 3; i += 1) {
      const out = await byEmail(env, "auth.password_reset", "user@example.com", {
        limit: 3,
        windowSeconds: 60 * 60,
      });
      expect(out.allowed).toBe(true);
    }
    const fourth = await byEmail(env, "auth.password_reset", "user@example.com", {
      limit: 3,
      windowSeconds: 60 * 60,
    });
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("normalizes case + whitespace so 'A@x' and 'a@x ' share the bucket", async () => {
    const { env } = makeEnv();
    await byEmail(env, "auth.password_reset", "User@Example.com", {
      limit: 1,
      windowSeconds: 60,
    });
    const denied = await byEmail(env, "auth.password_reset", "  user@example.com ", {
      limit: 1,
      windowSeconds: 60,
    });
    expect(denied.allowed).toBe(false);
  });
});

describe("bySession (MFA challenge)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps verification attempts within one challenge token", async () => {
    const { env } = makeEnv();
    const token = "mfa-challenge-abc";
    for (let i = 0; i < 5; i += 1) {
      const out = await bySession(env, "auth.mfa_challenge", token, {
        limit: 5,
        windowSeconds: 5 * 60,
      });
      expect(out.allowed).toBe(true);
    }
    const sixth = await bySession(env, "auth.mfa_challenge", token, {
      limit: 5,
      windowSeconds: 5 * 60,
    });
    expect(sixth.allowed).toBe(false);
  });

  it("a fresh challenge token gets its own bucket", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 5; i += 1) {
      await bySession(env, "auth.mfa_challenge", "first-token", {
        limit: 5,
        windowSeconds: 5 * 60,
      });
    }
    const fresh = await bySession(env, "auth.mfa_challenge", "second-token", {
      limit: 5,
      windowSeconds: 5 * 60,
    });
    expect(fresh.allowed).toBe(true);
  });
});

describe("byIp (anonymous traffic)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps the request rate per IP", async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 30; i += 1) {
      const out = await byIp(env, "api.anonymous", "203.0.113.42", {
        limit: 30,
        windowSeconds: 60,
      });
      expect(out.allowed).toBe(true);
    }
    const denied = await byIp(env, "api.anonymous", "203.0.113.42", {
      limit: 30,
      windowSeconds: 60,
    });
    expect(denied.allowed).toBe(false);
  });
});

describe("rateLimitedResponse", () => {
  it("emits 429 with Retry-After + 'rate_limited' code and retry_after_seconds", async () => {
    const res = rateLimitedResponse(
      {
        allowed: false,
        count: 5,
        limit: 5,
        retryAfterSeconds: 47,
      },
      "Slow down.",
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("47");
    const json = (await res.json()) as {
      ok: boolean;
      error: { code: string; message: string; retry_after_seconds: number };
    };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("rate_limited");
    expect(json.error.retry_after_seconds).toBe(47);
    expect(json.error.message).toBe("Slow down.");
  });

  it("clamps retry_after to at least 1 second so headers are never zero", async () => {
    const res = rateLimitedResponse({
      allowed: false,
      count: 1,
      limit: 1,
      retryAfterSeconds: 0,
    });
    expect(res.headers.get("Retry-After")).toBe("1");
  });
});

describe("applyGenericLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips /api/health entirely (no DB write)", async () => {
    const { env, db } = makeEnv();
    const request = new Request("http://localhost/api/health");
    const ctx = {
      request,
      env,
      url: new URL(request.url),
      cookies: {},
      auth: null,
    };
    const out = await applyGenericLimit(ctx);
    expect(out).toBeNull();
    expect(db.store.size).toBe(0);
  });

  it("uses the per-IP bucket for unauthenticated callers", async () => {
    const { env } = makeEnv({ RATE_LIMIT_API_ANON_MAX: "2", RATE_LIMIT_API_ANON_WINDOW_SECONDS: "60" });
    const request = new Request("http://localhost/api/auth/sign-in", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.5" },
    });
    const ctx = {
      request,
      env,
      url: new URL(request.url),
      cookies: {},
      auth: null,
    };
    const a = await applyGenericLimit(ctx);
    const b = await applyGenericLimit(ctx);
    const c = await applyGenericLimit(ctx);
    expect(a?.allowed).toBe(true);
    expect(b?.allowed).toBe(true);
    expect(c?.allowed).toBe(false);
  });

  it("uses the per-session bucket for authenticated callers", async () => {
    const { env } = makeEnv({ RATE_LIMIT_API_AUTH_MAX: "2", RATE_LIMIT_API_AUTH_WINDOW_SECONDS: "60" });
    const request = new Request("http://localhost/api/dashboard/summary", {
      headers: { "cf-connecting-ip": "198.51.100.5" },
    });
    const ctx = {
      request,
      env,
      url: new URL(request.url),
      cookies: {},
      auth: {
        user: {
          id: "user-1",
          email: "u@x",
          name: "U",
          role: "staff",
          status: "active",
          university_id: null,
          last_sign_in_at: null,
          password_hash: "x",
          created_at: "",
          updated_at: "",
        },
        session: {
          id: "session-abc",
          user_id: "user-1",
          token_hash: "h",
          ip_address: null,
          user_agent: null,
          expires_at: "2099-01-01T00:00:00Z",
          created_at: "",
        },
      },
    } as never;
    const a = await applyGenericLimit(ctx);
    const b = await applyGenericLimit(ctx);
    const c = await applyGenericLimit(ctx);
    expect(a?.allowed).toBe(true);
    expect(b?.allowed).toBe(true);
    expect(c?.allowed).toBe(false);
  });
});
