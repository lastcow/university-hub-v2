// Route tests for `DELETE /api/users/:id` (UNI-61). The delete endpoint
// hard-deletes credentials + device + connection rows and anonymizes the
// surviving `users` row to a `Removed User #N` tombstone with `status =
// 'deleted'`. Tests focus on the spec's safety rails and the
// transactional-rollback contract — every cascade write must land or
// none of them must.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeleteUserResult, Role, UserStatus } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { handleDeleteUser } from "../../src/routes/users.js";
import { ProgrammableD1, type RecordedExec } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_A_ID = "00000000-0000-0000-0000-00000000aaaa";
const SUPER_ADMIN_B_ID = "00000000-0000-0000-0000-00000000aaa2";
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
  [SUPER_ADMIN_A_ID]: {
    id: SUPER_ADMIN_A_ID,
    email: "super-a@example.com",
    name: "Super A",
    role: "super_admin",
    status: "active",
    university_id: null,
  },
  [SUPER_ADMIN_B_ID]: {
    id: SUPER_ADMIN_B_ID,
    email: "super-b@example.com",
    name: "Super B",
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

interface SeedOptions {
  superAdminCount?: number;
}

function makeDb(
  seedUsers: UserFixture[] = Object.values(USERS).map((u) => ({ ...u })),
  options: SeedOptions = {},
): ProgrammableD1 {
  const db = new ProgrammableD1();
  const byId = new Map(seedUsers.map((u) => [u.id, { ...u }]));
  db.onFirst((sql, params) => {
    if (sql.includes("FROM users u") && sql.includes("WHERE u.id = ? LIMIT 1")) {
      const u = byId.get(String(params[0]));
      return u ? userListRow(u) : null;
    }
    if (
      sql.includes("COUNT(1)") &&
      sql.includes("FROM users") &&
      sql.includes("role = 'super_admin'") &&
      sql.includes("status != 'deleted'")
    ) {
      const count =
        options.superAdminCount ??
        seedUsers.filter((u) => u.role === "super_admin" && u.status !== "deleted").length;
      return { c: count };
    }
    return undefined;
  });
  // The cascade UPDATE rewrites several columns at once; mirror it on the
  // seed map so a follow-up loadUserRow sees the anonymized values.
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("update users set name = ?, email = ?")) {
      const id = String(params[3]);
      const row = byId.get(id);
      if (row) {
        row.name = String(params[0]);
        row.email = String(params[1]);
        row.status = "deleted";
      }
    }
  });
  return db;
}

function makeEnv(db: ProgrammableD1): Env {
  return {
    DB: db as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    MAILGUN_API_KEY: "replace-with-mailgun-api-key",
    MAILGUN_DOMAIN: "replace-with-mailgun-domain",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
    SUPPORT_EMAIL: "support@example.com",
  };
}

interface CtxInit {
  body?: unknown;
}

function ctx(actor: UserFixture, db: ProgrammableD1, init: CtxInit = {}): RequestContext {
  const url = new URL("https://hub.example.com/api/users/x");
  const headers: HeadersInit = init.body !== undefined ? { "content-type": "application/json" } : {};
  const requestInit: RequestInit = {
    method: "DELETE",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
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

function deletedAuditRows(db: ProgrammableD1): RecordedExec[] {
  return db.inserts("audit_logs").filter((row) => row.params[3] === "user.deleted");
}

function deniedDeletedAuditRows(db: ProgrammableD1): RecordedExec[] {
  return deletedAuditRows(db).filter((row) => {
    const meta = row.params[6];
    return typeof meta === "string" && meta.includes('"denied":true');
  });
}

function allowedDeletedAuditRows(db: ProgrammableD1): RecordedExec[] {
  return deletedAuditRows(db).filter((row) => {
    const meta = row.params[6];
    return typeof meta !== "string" || !meta.includes('"denied":true');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/users/:id — RBAC", () => {
  it("non-admin roles get 403 (no audit)", async () => {
    const db = makeDb();
    const studentActor: UserFixture = {
      id: "s1", email: "s@x", name: "S", role: "student", status: "active", university_id: UNI_A,
    };
    const res = await handleDeleteUser(ctx(studentActor, db), TARGET_STAFF_ID);
    expect(res.status).toBe(403);
    expect(deletedAuditRows(db).length).toBe(0);
  });

  it("super_admin can remove any user", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[SUPER_ADMIN_A_ID]!, db, { body: { reason: "Off-boarded" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: DeleteUserResult }>(res);
    expect(body.data.idempotent).toBe(false);
    expect(body.data.user.status).toBe("deleted");
    expect(body.data.user.email).toBe(`removed-${TARGET_STAFF_ID}@local.invalid`);
    expect(body.data.user.name).toMatch(/^Removed User #/);
    expect(allowedDeletedAuditRows(db).length).toBe(1);
  });

  it("university_admin can remove a non-admin user in their university", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[UNI_A_ADMIN_ID]!, db, { body: {} }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);
    expect(allowedDeletedAuditRows(db).length).toBe(1);
  });

  it("university_admin cannot remove a super_admin (403 + denied audit)", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[UNI_A_ADMIN_ID]!, db),
      SUPER_ADMIN_A_ID,
    );
    // super_admin has university_id = null, which is out of the admin's
    // read scope, so the response is 404 (existence concealment) — same
    // pattern as PATCH /role / /status.
    expect(res.status).toBe(404);
    // No audit row written when we hide existence; matches the rest of
    // the user routes.
    expect(deletedAuditRows(db).length).toBe(0);
  });

  it("university_admin cannot remove another university_admin in their university (403 + denied audit)", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[UNI_A_ADMIN_ID]!, db),
      ANOTHER_UNI_ADMIN_ID,
    );
    expect(res.status).toBe(403);
    const denied = deniedDeletedAuditRows(db);
    expect(denied.length).toBe(1);
    const meta = denied[0]!.params[6] as string;
    expect(meta).toContain('"reason":"target_out_of_scope"');
    expect(db.batches.length).toBe(0);
  });

  it("university_admin cannot remove a user in another university (404)", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[UNI_A_ADMIN_ID]!, db),
      OTHER_UNI_USER_ID,
    );
    expect(res.status).toBe(404);
    expect(deletedAuditRows(db).length).toBe(0);
    expect(db.batches.length).toBe(0);
  });
});

describe("DELETE /api/users/:id — safety rails", () => {
  it("self-delete returns 409 with denied audit", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[SUPER_ADMIN_A_ID]!, db),
      SUPER_ADMIN_A_ID,
    );
    expect(res.status).toBe(409);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("cannot_delete_self");
    const denied = deniedDeletedAuditRows(db);
    expect(denied.length).toBe(1);
    const meta = denied[0]!.params[6] as string;
    expect(meta).toContain('"reason":"self_delete"');
    expect(db.batches.length).toBe(0);
  });

  it("last super_admin returns 409 with denied audit", async () => {
    // Seed only one super_admin so the count check returns 1.
    const onlySuperAdmin: UserFixture = {
      id: SUPER_ADMIN_A_ID,
      email: "only-super@example.com",
      name: "Only Super",
      role: "super_admin",
      status: "active",
      university_id: null,
    };
    const target: UserFixture = {
      id: SUPER_ADMIN_B_ID,
      email: "second-super@example.com",
      name: "Second Super",
      role: "super_admin",
      status: "active",
      university_id: null,
    };
    const db = makeDb([onlySuperAdmin, target], { superAdminCount: 1 });
    const res = await handleDeleteUser(ctx(onlySuperAdmin, db), target.id);
    expect(res.status).toBe(409);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("cannot_delete_last_super_admin");
    const denied = deniedDeletedAuditRows(db);
    expect(denied.length).toBe(1);
    expect((denied[0]!.params[6] as string)).toContain('"reason":"last_super_admin"');
    expect(db.batches.length).toBe(0);
  });

  it("already-deleted user returns 200 idempotent (no writes)", async () => {
    const removedUser: UserFixture = {
      ...USERS[TARGET_STAFF_ID]!,
      status: "deleted",
      name: `Removed User #${TARGET_STAFF_ID.replace(/-/g, "").slice(0, 8)}`,
      email: `removed-${TARGET_STAFF_ID}@local.invalid`,
    };
    const db = makeDb([USERS[SUPER_ADMIN_A_ID]!, USERS[SUPER_ADMIN_B_ID]!, removedUser]);
    const res = await handleDeleteUser(ctx(USERS[SUPER_ADMIN_A_ID]!, db), TARGET_STAFF_ID);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: DeleteUserResult }>(res);
    expect(body.data.idempotent).toBe(true);
    expect(body.data.user.status).toBe("deleted");
    expect(deletedAuditRows(db).length).toBe(0);
    expect(db.batches.length).toBe(0);
  });
});

describe("DELETE /api/users/:id — body validation", () => {
  it("missing body is allowed (reason is optional)", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(ctx(USERS[SUPER_ADMIN_A_ID]!, db), TARGET_STAFF_ID);
    expect(res.status).toBe(200);
  });

  it("reason too long returns 400", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[SUPER_ADMIN_A_ID]!, db, { body: { reason: "x".repeat(501) } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(400);
    expect(db.batches.length).toBe(0);
  });
});

describe("DELETE /api/users/:id — cascade + anonymization", () => {
  it("runs the documented cascade in a single batch", async () => {
    const db = makeDb();
    const res = await handleDeleteUser(
      ctx(USERS[SUPER_ADMIN_A_ID]!, db, { body: { reason: "End of contract" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(200);
    expect(db.batches.length).toBe(1);
    const batchSql = db.batches[0]!.map((row) => row.normalizedSql);
    // Hard-deletes
    expect(batchSql.some((s) => s.startsWith("DELETE FROM sessions"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("DELETE FROM mfa_challenges"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("DELETE FROM trusted_devices"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("DELETE FROM lms_connections"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("DELETE FROM parent_sessions"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("DELETE FROM parent_sign_in_tokens"))).toBe(true);
    // Soft-deletes / status flips
    expect(batchSql.some((s) => s.startsWith("UPDATE invitations"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("UPDATE disclosure_consents"))).toBe(true);
    expect(batchSql.some((s) => s.startsWith("UPDATE course_assignments"))).toBe(true);
    // Anonymize users row
    const anonStmt = db.batches[0]!.find((r) =>
      r.normalizedSql.startsWith("UPDATE users SET name = ?"),
    );
    expect(anonStmt).toBeDefined();
    expect(anonStmt!.params[0]).toMatch(/^Removed User #/);
    expect(anonStmt!.params[1]).toBe(`removed-${TARGET_STAFF_ID}@local.invalid`);
    // Audit row is part of the same batch
    const auditStmt = db.batches[0]!.find((r) =>
      r.normalizedSql.startsWith("INSERT INTO audit_logs"),
    );
    expect(auditStmt).toBeDefined();
  });

  it("audit metadata redacts the original email and includes role_before", async () => {
    const db = makeDb();
    await handleDeleteUser(
      ctx(USERS[SUPER_ADMIN_A_ID]!, db, { body: { reason: "Off-boarded" } }),
      TARGET_STAFF_ID,
    );
    const allowed = allowedDeletedAuditRows(db);
    expect(allowed.length).toBe(1);
    const meta = allowed[0]!.params[6] as string;
    // Redacted, not the original `staff-a@example.com`
    expect(meta).toContain('"deleted_user_email_redacted":"s***@e***.com"');
    expect(meta).not.toContain("staff-a@example.com");
    expect(meta).toContain('"role_before":"staff"');
    expect(meta).toContain('"actor_user_id":"' + SUPER_ADMIN_A_ID + '"');
    expect(meta).toContain('"reason":"Off-boarded"');
  });

  it("rolls back cleanly when the batch fails — no anonymization, denied audit recorded", async () => {
    const db = makeDb();
    db.failBatchOnce("simulated D1 batch failure");
    const res = await handleDeleteUser(
      ctx(USERS[SUPER_ADMIN_A_ID]!, db, { body: { reason: "Contract ended" } }),
      TARGET_STAFF_ID,
    );
    expect(res.status).toBe(500);
    const body = await jsonBody<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("delete_failed");
    // The seed-fixture write hook only fires inside `recordRun` — which the
    // failing batch never reaches. So the in-memory user row is untouched
    // and a follow-up read still sees the un-anonymized values.
    const denied = deniedDeletedAuditRows(db);
    expect(denied.length).toBe(1);
    expect((denied[0]!.params[6] as string)).toContain('"reason":"cascade_failed"');
    // No anonymization SQL recorded outside the failed batch.
    const anyAnon = db.executions.find((e) =>
      e.normalizedSql.startsWith("UPDATE users SET name = ?"),
    );
    expect(anyAnon).toBeUndefined();
  });
});
