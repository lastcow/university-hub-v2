// Route tests for the active-sessions surface (UNI-26).
//
//   GET    /api/auth/sessions
//   DELETE /api/auth/sessions/:id
//   POST   /api/auth/sessions/revoke-all
//
// Covers privacy redaction (IP /24, UA truncation), the "this device" flag,
// the audit-log shape on revoke / revoke-all, and the explicit guard against
// revoking your own session through the manual endpoint.

import { describe, expect, it } from "vitest";

import type {
  SessionListResponse,
  SessionRevokeAllResponse,
} from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleListSessions,
  handleRevokeAllOtherSessions,
  handleRevokeSession,
  truncateIp,
  truncateUserAgent,
} from "../../src/routes/sessions.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const ACTOR_ID = "00000000-0000-0000-0000-00000000aaaa";
const CURRENT_SESSION_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_SESSION_ID_2 = "33333333-3333-3333-3333-333333333333";

interface SeededSession {
  id: string;
  user_id: string;
  created_at: string;
  last_activity_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

function makeDb(seed: SeededSession[] = []): ProgrammableD1 {
  const db = new ProgrammableD1();
  const byUser = new Map<string, SeededSession[]>();
  for (const s of seed) {
    const arr = byUser.get(s.user_id) ?? [];
    arr.push(s);
    byUser.set(s.user_id, arr);
  }
  db.onAll((sql, params) => {
    if (
      sql.includes("FROM sessions") &&
      sql.includes("WHERE user_id = ?") &&
      sql.includes("ORDER BY last_activity_at DESC")
    ) {
      const userId = String(params[0]);
      const rows = byUser.get(userId) ?? [];
      // Sort by last_activity_at desc to mimic the SQL ORDER BY.
      return [...rows].sort((a, b) =>
        a.last_activity_at < b.last_activity_at ? 1 : -1,
      );
    }
    return undefined;
  });
  // Mutate the seed map on DELETE so a follow-up listing sees fewer rows.
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("delete from sessions where id = ?")) {
      const id = String(params[0]);
      for (const [userId, rows] of byUser.entries()) {
        const filtered = rows.filter((r) => r.id !== id);
        if (filtered.length !== rows.length) byUser.set(userId, filtered);
      }
    }
  });
  return db;
}

function makeEnv(db: ProgrammableD1, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    APP_ENV: "development",
    ...overrides,
  };
}

function ctx(db: ProgrammableD1, sessionId: string = CURRENT_SESSION_ID): RequestContext {
  const url = new URL("https://hub.example.com/api/auth/sessions");
  const env = makeEnv(db);
  const auth: AuthState = {
    user: {
      id: ACTOR_ID,
      email: "actor@example.com",
      name: "Actor",
      role: "staff",
      status: "active",
      university_id: null,
      password_hash: "x",
      last_sign_in_at: null,
      created_at: "2026-05-04T11:00:00.000Z",
      updated_at: "2026-05-04T11:00:00.000Z",
    } as UserRow,
    session: {
      id: sessionId,
      user_id: ACTOR_ID,
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

describe("truncateIp", () => {
  it("masks the last IPv4 octet to /24", () => {
    expect(truncateIp("203.0.113.42")).toBe("203.0.113.0/24");
  });
  it("masks IPv6 to /48", () => {
    expect(truncateIp("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
  });
  it("returns null for null/empty input", () => {
    expect(truncateIp(null)).toBeNull();
    expect(truncateIp("")).toBeNull();
    expect(truncateIp("   ")).toBeNull();
  });
});

describe("truncateUserAgent", () => {
  it("trims to 80 chars + ellipsis when longer", () => {
    const long =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    const out = truncateUserAgent(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(80);
    expect(out!.endsWith("…")).toBe(true);
  });
  it("returns the original when shorter than the cap", () => {
    expect(truncateUserAgent("curl/8.4")).toBe("curl/8.4");
  });
});

describe("GET /api/auth/sessions", () => {
  it("lists sessions for the calling user with privacy excerpts and is_current", async () => {
    const db = makeDb([
      {
        id: CURRENT_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T11:00:00.000Z",
        last_activity_at: "2026-05-04T11:55:00.000Z",
        ip_address: "203.0.113.42",
        user_agent: "Mozilla/5.0 Chrome",
      },
      {
        id: OTHER_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T08:00:00.000Z",
        last_activity_at: "2026-05-04T08:30:00.000Z",
        ip_address: "198.51.100.10",
        user_agent: "Mozilla/5.0 Firefox",
      },
    ]);
    const res = await handleListSessions(ctx(db));
    expect(res.status).toBe(200);

    const body = await jsonBody<SessionListResponse>(res);
    expect(body.idle_timeout_seconds).toBe(1800);
    expect(body.absolute_timeout_seconds).toBe(43200);
    expect(body.sessions).toHaveLength(2);

    const current = body.sessions.find((s) => s.id === CURRENT_SESSION_ID)!;
    expect(current.is_current).toBe(true);
    expect(current.ip_excerpt).toBe("203.0.113.0/24");

    const other = body.sessions.find((s) => s.id === OTHER_SESSION_ID)!;
    expect(other.is_current).toBe(false);
    expect(other.ip_excerpt).toBe("198.51.100.0/24");
  });
});

describe("DELETE /api/auth/sessions/:id", () => {
  it("revokes a non-current session, deletes the row, and audits with reason=manual", async () => {
    const db = makeDb([
      {
        id: CURRENT_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T11:00:00.000Z",
        last_activity_at: "2026-05-04T11:55:00.000Z",
        ip_address: "203.0.113.42",
        user_agent: "Mozilla/5.0 Chrome",
      },
      {
        id: OTHER_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T08:00:00.000Z",
        last_activity_at: "2026-05-04T08:30:00.000Z",
        ip_address: "198.51.100.10",
        user_agent: "Firefox",
      },
    ]);
    const res = await handleRevokeSession(ctx(db), OTHER_SESSION_ID);
    expect(res.status).toBe(200);

    const deletes = db.executions.filter((e) =>
      /^DELETE FROM sessions/i.test(e.sql),
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]!.params[0])).toBe(OTHER_SESSION_ID);

    const audits = db.inserts("audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.params[3]).toBe("session.revoked");
    const meta = audits[0]!.params[6] as string;
    expect(meta).toContain('"reason":"manual"');
  });

  it("rejects revoking the current session through the manual endpoint", async () => {
    const db = makeDb([
      {
        id: CURRENT_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T11:00:00.000Z",
        last_activity_at: "2026-05-04T11:55:00.000Z",
        ip_address: "203.0.113.42",
        user_agent: "Mozilla/5.0 Chrome",
      },
    ]);
    const res = await handleRevokeSession(ctx(db), CURRENT_SESSION_ID);
    expect(res.status).toBe(400);
    expect(db.executions.some((e) => /^DELETE FROM sessions/i.test(e.sql))).toBe(
      false,
    );
    expect(db.inserts("audit_logs")).toHaveLength(0);
  });

  it("404s when the session id doesn't belong to the caller", async () => {
    const db = makeDb([
      {
        id: CURRENT_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T11:00:00.000Z",
        last_activity_at: "2026-05-04T11:55:00.000Z",
        ip_address: null,
        user_agent: null,
      },
    ]);
    const res = await handleRevokeSession(
      ctx(db),
      "44444444-4444-4444-4444-444444444444",
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/auth/sessions/revoke-all", () => {
  it("revokes every other session, retains the current one, audits each", async () => {
    const db = makeDb([
      {
        id: CURRENT_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T11:00:00.000Z",
        last_activity_at: "2026-05-04T11:55:00.000Z",
        ip_address: null,
        user_agent: null,
      },
      {
        id: OTHER_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T08:00:00.000Z",
        last_activity_at: "2026-05-04T08:30:00.000Z",
        ip_address: null,
        user_agent: null,
      },
      {
        id: OTHER_SESSION_ID_2,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T06:00:00.000Z",
        last_activity_at: "2026-05-04T06:15:00.000Z",
        ip_address: null,
        user_agent: null,
      },
    ]);

    const res = await handleRevokeAllOtherSessions(ctx(db));
    expect(res.status).toBe(200);

    const body = await jsonBody<SessionRevokeAllResponse>(res);
    expect(body.revoked_count).toBe(2);

    const deletes = db.executions
      .filter((e) => /^DELETE FROM sessions/i.test(e.sql))
      .map((e) => String(e.params[0]));
    expect(deletes).toContain(OTHER_SESSION_ID);
    expect(deletes).toContain(OTHER_SESSION_ID_2);
    expect(deletes).not.toContain(CURRENT_SESSION_ID);

    const audits = db.inserts("audit_logs");
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row.params[3]).toBe("session.revoked");
      expect(row.params[6] as string).toContain('"reason":"sign_out_all"');
    }
  });

  it("returns 0 when only the current session exists", async () => {
    const db = makeDb([
      {
        id: CURRENT_SESSION_ID,
        user_id: ACTOR_ID,
        created_at: "2026-05-04T11:00:00.000Z",
        last_activity_at: "2026-05-04T11:55:00.000Z",
        ip_address: null,
        user_agent: null,
      },
    ]);
    const res = await handleRevokeAllOtherSessions(ctx(db));
    const body = await jsonBody<SessionRevokeAllResponse>(res);
    expect(body.revoked_count).toBe(0);
    expect(db.executions.some((e) => /^DELETE FROM sessions/i.test(e.sql))).toBe(
      false,
    );
    expect(db.inserts("audit_logs")).toHaveLength(0);
  });
});
