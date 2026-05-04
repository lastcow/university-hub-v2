// Route tests for the user-management endpoints (UNI-11). Focused on the
// privilege-escalation and university-scoping rules called out in the issue
// acceptance criteria — every denied write should produce a 403 response and
// an audit_logs row tagged `denied: true`.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Role, UserStatus } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import type { FetchLike } from "../../src/mail/mailgun.js";
import {
  handleGetUser,
  handleListUsers,
  handleUpdateUser,
  handleUpdateUserRole,
  handleUpdateUserStatus,
} from "../../src/routes/users.js";
import { ProgrammableD1, type RecordedExec } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const UNI_B_ADMIN_ID = "00000000-0000-0000-0000-00000000cccc";
const TARGET_STAFF_ID = "00000000-0000-0000-0000-00000000dddd";
const OTHER_UNI_USER_ID = "00000000-0000-0000-0000-00000000eeee";
const ANOTHER_UNI_ADMIN_ID = "00000000-0000-0000-0000-00000000ffff";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

interface UserFixture {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  university_id: string | null;
}

const USERS: Record<string, UserFixture> = {
  [SUPER_ADMIN_ID]: {
    id: SUPER_ADMIN_ID,
    email: "super@example.com",
    name: "Super",
    role: "super_admin",
    status: "active",
    university_id: null,
  },
  [UNI_A_ADMIN_ID]: {
    id: UNI_A_ADMIN_ID,
    email: "admin-a@example.com",
    name: "Admin A",
    role: "university_admin",
    status: "active",
    university_id: UNI_A,
  },
  [UNI_B_ADMIN_ID]: {
    id: UNI_B_ADMIN_ID,
    email: "admin-b@example.com",
    name: "Admin B",
    role: "university_admin",
    status: "active",
    university_id: UNI_B,
  },
  [TARGET_STAFF_ID]: {
    id: TARGET_STAFF_ID,
    email: "staff-a@example.com",
    name: "Staff A",
    role: "staff",
    status: "active",
    university_id: UNI_A,
  },
  [OTHER_UNI_USER_ID]: {
    id: OTHER_UNI_USER_ID,
    email: "staff-b@example.com",
    name: "Staff B",
    role: "staff",
    status: "active",
    university_id: UNI_B,
  },
  [ANOTHER_UNI_ADMIN_ID]: {
    id: ANOTHER_UNI_ADMIN_ID,
    email: "admin-a2@example.com",
    name: "Admin A2",
    role: "university_admin",
    status: "active",
    university_id: UNI_A,
  },
};

function userListRow(u: UserFixture, university_name: string | null = null) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    university_id: u.university_id,
    last_sign_in_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    university_name,
  };
}

function makeDb(seedUsers: UserFixture[] = Object.values(USERS).map((u) => ({ ...u }))): ProgrammableD1 {
  const db = new ProgrammableD1();
  const byId = new Map(seedUsers.map((u) => [u.id, { ...u }]));
  db.onFirst((sql, params) => {
    if (sql.includes("FROM users u") && sql.includes("WHERE u.id = ? LIMIT 1")) {
      const u = byId.get(String(params[0]));
      return u ? userListRow(u) : null;
    }
    return undefined;
  });
  db.onAll((sql, params) => {
    if (sql.includes("FROM users u") && sql.includes("ORDER BY u.created_at DESC")) {
      let rows = Array.from(byId.values()).map((u) => userListRow(u));
      if (sql.includes("u.university_id = ?")) {
        const universityId = params[0];
        rows = rows.filter((r) => r.university_id === universityId);
      }
      return rows;
    }
    return undefined;
  });
  // Apply UPDATE users SET <field> = ?, updated_at = ? WHERE id = ? to the seed
  // map so a follow-up loadUserRow returns the new value. Routes only update
  // one column per call (name / role / status), so a tiny dispatch table is
  // enough.
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("update users set role = ?")) {
      const id = String(params[2]);
      const row = byId.get(id);
      if (row) row.role = params[0] as Role;
    } else if (lower.startsWith("update users set status = ?")) {
      const id = String(params[2]);
      const row = byId.get(id);
      if (row) row.status = params[0] as UserStatus;
    } else if (lower.startsWith("update users set name = ?")) {
      const id = String(params[2]);
      const row = byId.get(id);
      if (row) row.name = String(params[0]);
    }
  });
  return db;
}

function makeEnv(db: ProgrammableD1, fetchImpl?: FetchLike): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    // Intentionally missing Mailgun secrets — `dispatch()` will short-circuit
    // to a `mailgun_not_configured` failure, which is exactly what the
    // production environment looks like per the Manager note. We just want
    // to assert that the email_logs row is still written and the response
    // stays safe.
    MAILGUN_API_KEY: "replace-with-mailgun-api-key",
    MAILGUN_DOMAIN: "replace-with-mailgun-domain",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
    SUPPORT_EMAIL: "support@example.com",
    ...(fetchImpl ? {} : {}),
  };
}

function ctx(actor: UserFixture, db: ProgrammableD1, init?: { method?: string; body?: unknown; query?: string }): RequestContext {
  const url = new URL(`https://hub.example.com/api/users${init?.query ?? ""}`);
  const headers: HeadersInit = init?.body ? { "content-type": "application/json" } : {};
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  const request = new Request(url, requestInit);
  const env = makeEnv(db);
  const auth: AuthState = {
    user: { ...actor, password_hash: "x" } as unknown as UserRow,
    session: {
      id: "s",
      user_id: actor.id,
      token_hash: "h",
      ip_address: null,
      user_agent: null,
      expires_at: "2099",
      created_at: "2026",
      last_activity_at: "2026",
    },
  };
  return { request, env, url, cookies: {}, auth };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function auditDeniedRows(db: ProgrammableD1, action: string): RecordedExec[] {
  return db.inserts("audit_logs").filter((row) => {
    if (row.params[3] !== action) return false;
    const meta = row.params[6];
    if (typeof meta !== "string") return false;
    return meta.includes('"denied":true');
  });
}

function auditAllowedRows(db: ProgrammableD1, action: string): RecordedExec[] {
  return db.inserts("audit_logs").filter((row) => {
    if (row.params[3] !== action) return false;
    const meta = row.params[6];
    if (typeof meta !== "string") return true;
    return !meta.includes('"denied":true');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/users — list scoping", () => {
  it("non-admin roles get 403", async () => {
    const db = makeDb();
    const studentActor: UserFixture = {
      id: "s1", email: "s@x", name: "S", role: "student", status: "active", university_id: UNI_A,
    };
    const res = await handleListUsers(ctx(studentActor, db));
    expect(res.status).toBe(403);
  });

  it("super_admin sees every user", async () => {
    const db = makeDb();
    const res = await handleListUsers(ctx(USERS[SUPER_ADMIN_ID]!, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data.length).toBe(Object.keys(USERS).length);
  });

  it("university_admin only sees their own university", async () => {
    const db = makeDb();
    const res = await handleListUsers(ctx(USERS[UNI_A_ADMIN_ID]!, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ university_id: string | null }> }>(res);
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row.university_id).toBe(UNI_A);
    }
  });
});

describe("GET /api/users/:id — cross-university read is rejected as 404", () => {
  it("university_admin cannot read users from another university", async () => {
    const db = makeDb();
    const res = await handleGetUser(ctx(USERS[UNI_A_ADMIN_ID]!, db), OTHER_UNI_USER_ID);
    expect(res.status).toBe(404);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("not_found");
  });

  it("super_admin can read any user", async () => {
    const db = makeDb();
    const res = await handleGetUser(ctx(USERS[SUPER_ADMIN_ID]!, db), OTHER_UNI_USER_ID);
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/users/:id/role — privilege escalation guard", () => {
  it("rejects university_admin promoting a staff to super_admin (403 + denied audit)", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { role: "super_admin" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(403);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("forbidden");

    // Audit row recorded with denied=true and a reason explaining why.
    const denied = auditDeniedRows(db, "user.role_changed");
    expect(denied.length).toBe(1);
    const meta = denied[0]!.params[6] as string;
    expect(meta).toContain("role_not_assignable");
    expect(meta).toContain("super_admin");

    // No actual UPDATE on users table.
    expect(db.updates("users").length).toBe(0);
  });

  it("rejects university_admin promoting to university_admin (peer escalation)", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { role: "university_admin" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(403);
    const denied = auditDeniedRows(db, "user.role_changed");
    expect(denied.length).toBe(1);
    expect(db.updates("users").length).toBe(0);
  });

  it("rejects university_admin trying to change another university_admin's role", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { role: "staff" } }),
      ANOTHER_UNI_ADMIN_ID,
    );
    expect(res.status).toBe(403);
    const denied = auditDeniedRows(db, "user.role_changed");
    expect(denied.length).toBe(1);
    const meta = denied[0]!.params[6] as string;
    expect(meta).toContain("target_out_of_scope");
  });

  it("rejects university_admin acting on a user in another university (404)", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { role: "staff" } }),
      OTHER_UNI_USER_ID,
    );
    expect(res.status).toBe(404);
  });

  it("rejects an actor changing their own role (no self-demotion)", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[SUPER_ADMIN_ID]!, db, { method: "PATCH", body: { role: "staff" } }),
      SUPER_ADMIN_ID,
    );
    expect(res.status).toBe(403);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("forbidden_self");
    expect(db.updates("users").length).toBe(0);
  });

  it("allows super_admin to change a user's role and writes a non-denied audit row", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[SUPER_ADMIN_ID]!, db, { method: "PATCH", body: { role: "faculty" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);
    expect(db.updates("users").length).toBe(1);
    const allowed = auditAllowedRows(db, "user.role_changed");
    expect(allowed.length).toBe(1);
  });

  it("allows university_admin to switch a non-admin role inside their university", async () => {
    const db = makeDb();
    const res = await handleUpdateUserRole(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { role: "teacher" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);
    expect(db.updates("users").length).toBe(1);
  });

  // UNI-26: role changes invalidate every existing session for the target so
  // the new role takes effect on the very next request rather than waiting
  // for the session cookie to expire.
  it("revokes the target user's sessions when role changes and audits each one", async () => {
    const db = makeDb();
    const targetSessions = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        user_id: TARGET_STAFF_ID,
        created_at: "2026-05-04T08:00:00.000Z",
        last_activity_at: "2026-05-04T11:00:00.000Z",
        ip_address: "203.0.113.10",
        user_agent: "Mozilla/5.0",
      },
      {
        id: "22222222-2222-2222-2222-222222222222",
        user_id: TARGET_STAFF_ID,
        created_at: "2026-05-04T09:00:00.000Z",
        last_activity_at: "2026-05-04T10:00:00.000Z",
        ip_address: "198.51.100.10",
        user_agent: "Firefox",
      },
    ];
    db.onAll((sql, params) => {
      if (
        sql.includes("FROM sessions") &&
        sql.includes("WHERE user_id = ?") &&
        sql.includes("ORDER BY last_activity_at DESC")
      ) {
        return params[0] === TARGET_STAFF_ID ? targetSessions : [];
      }
      return undefined;
    });

    const res = await handleUpdateUserRole(
      ctx(USERS[SUPER_ADMIN_ID]!, db, { method: "PATCH", body: { role: "faculty" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);

    const deletes = db.executions
      .filter((e) => /^DELETE FROM sessions/i.test(e.sql))
      .map((e) => String(e.params[0]));
    expect(deletes).toEqual(targetSessions.map((s) => s.id));

    const sessionAudits = db
      .inserts("audit_logs")
      .filter((r) => r.params[3] === "session.revoked");
    expect(sessionAudits).toHaveLength(2);
    for (const row of sessionAudits) {
      const meta = row.params[6] as string;
      expect(meta).toContain('"reason":"role_change"');
      expect(meta).toContain(TARGET_STAFF_ID);
    }
  });
});

describe("PATCH /api/users/:id/status — email + audit", () => {
  it("writes audit + triggers an email log row even when Mailgun isn't configured", async () => {
    const db = makeDb();
    const res = await handleUpdateUserStatus(
      ctx(USERS[SUPER_ADMIN_ID]!, db, { method: "PATCH", body: { status: "inactive" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);

    const body = await jsonBody<{
      data: { email_status: string; email_error: string | null; user: { status: string } };
    }>(res);
    expect(body.data.user.status).toBe("inactive");
    // Mailgun is unconfigured in the test env so the email is reported as
    // failed with a stable, sanitized reason — and the API stays safe.
    expect(body.data.email_status).toBe("failed");
    expect(body.data.email_error).toContain("mailgun_not_configured");

    // Audit log: `user.status_changed` with previous + new status, plus the
    // `email.failed` row from the email log path.
    const allowed = auditAllowedRows(db, "user.status_changed");
    expect(allowed.length).toBe(1);
    const failedEmailAudits = db.inserts("audit_logs").filter((r) => r.params[3] === "email.failed");
    expect(failedEmailAudits.length).toBe(1);

    // email_logs row written even though Mailgun was unconfigured.
    const emailLogs = db.inserts("email_logs");
    expect(emailLogs.length).toBe(1);
    expect(emailLogs[0]!.params[3]).toBe("account_status_changed");
    expect(emailLogs[0]!.params[5]).toBe("failed");
  });

  it("rejects university_admin trying to deactivate another university's user", async () => {
    const db = makeDb();
    const res = await handleUpdateUserStatus(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { status: "inactive" } }),
      OTHER_UNI_USER_ID,
    );
    expect(res.status).toBe(404);
  });

  it("rejects university_admin trying to suspend another university_admin", async () => {
    const db = makeDb();
    const res = await handleUpdateUserStatus(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { status: "suspended" } }),
      ANOTHER_UNI_ADMIN_ID,
    );
    expect(res.status).toBe(403);
    const denied = auditDeniedRows(db, "user.status_changed");
    expect(denied.length).toBe(1);
    expect(db.updates("users").length).toBe(0);
    expect(db.inserts("email_logs").length).toBe(0);
  });

  it("revokes the target user's sessions when status changes and audits each one", async () => {
    const db = makeDb();
    const sessions = [
      {
        id: "33333333-3333-3333-3333-333333333333",
        user_id: TARGET_STAFF_ID,
        created_at: "2026-05-04T08:00:00.000Z",
        last_activity_at: "2026-05-04T11:00:00.000Z",
        ip_address: null,
        user_agent: null,
      },
    ];
    db.onAll((sql, params) => {
      if (
        sql.includes("FROM sessions") &&
        sql.includes("WHERE user_id = ?") &&
        sql.includes("ORDER BY last_activity_at DESC")
      ) {
        return params[0] === TARGET_STAFF_ID ? sessions : [];
      }
      return undefined;
    });

    const res = await handleUpdateUserStatus(
      ctx(USERS[SUPER_ADMIN_ID]!, db, { method: "PATCH", body: { status: "suspended" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);

    const sessionAudits = db
      .inserts("audit_logs")
      .filter((r) => r.params[3] === "session.revoked");
    expect(sessionAudits).toHaveLength(1);
    const meta = sessionAudits[0]!.params[6] as string;
    expect(meta).toContain('"reason":"status_change"');
  });

  it("rejects an actor changing their own status", async () => {
    const db = makeDb();
    const res = await handleUpdateUserStatus(
      ctx(USERS[SUPER_ADMIN_ID]!, db, { method: "PATCH", body: { status: "inactive" } }),
      SUPER_ADMIN_ID,
    );
    expect(res.status).toBe(403);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("forbidden_self");
  });
});

describe("PATCH /api/users/:id — profile", () => {
  it("rejects updating a user in another university with 404", async () => {
    const db = makeDb();
    const res = await handleUpdateUser(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { name: "x" } }),
      OTHER_UNI_USER_ID,
    );
    expect(res.status).toBe(404);
  });

  it("rejects university_admin trying to rename another university_admin", async () => {
    const db = makeDb();
    const res = await handleUpdateUser(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { method: "PATCH", body: { name: "Nope" } }),
      ANOTHER_UNI_ADMIN_ID,
    );
    expect(res.status).toBe(403);
  });
});
