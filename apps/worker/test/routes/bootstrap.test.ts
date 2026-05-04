// Route tests for the production bootstrap endpoint (UNI-16).
//
// The endpoint is the only "create a user without an existing admin" path
// in the system, so the security gates matter:
//   - 404 when BOOTSTRAP_SECRET is unset (route effectively hidden)
//   - 401 with a wrong / missing Bearer token
//   - 409 when a super_admin already exists (true one-shot gate)
//   - happy path: inserts users + universities rows, audits, returns the new
//     SessionUser, and never returns the password hash.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import type { RequestContext } from "../../src/middleware/auth.js";
import { handleBootstrapSuperAdmin } from "../../src/routes/bootstrap.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const ENDPOINT = "https://hub.example.com/api/bootstrap/super-admin";

function envWith(overrides: Partial<Env>): Env {
  return {
    DB: undefined as unknown as D1Database,
    ASSETS: { fetch: () => new Response("") } as unknown as Fetcher,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    ...overrides,
  };
}

function ctxFor(
  env: Env,
  db: ProgrammableD1,
  init: { authorization?: string; body?: unknown },
): RequestContext {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.authorization !== undefined) headers.authorization = init.authorization;
  return {
    request: new Request(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(init.body ?? {}),
    }),
    env: { ...env, DB: db as unknown as D1Database },
    url: new URL(ENDPOINT),
    cookies: {},
    auth: null,
  };
}

function dbWithoutSuperAdmin(): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onFirst((sql, params) => {
    if (sql.includes("FROM users") && sql.includes("WHERE role = 'super_admin'")) {
      return null;
    }
    if (sql.includes("FROM users WHERE email = ?")) {
      return null;
    }
    return undefined;
  });
  return db;
}

function dbWithExistingSuperAdmin(): ProgrammableD1 {
  const db = new ProgrammableD1();
  db.onFirst((sql) => {
    if (sql.includes("FROM users") && sql.includes("WHERE role = 'super_admin'")) {
      return { id: "existing-super" };
    }
    return undefined;
  });
  return db;
}

const VALID_BODY = {
  email: "admin@example.com",
  name: "Site Admin",
  password: "CorrectHorseBattery1",
  university_name: "Example University",
};

describe("POST /api/bootstrap/super-admin", () => {
  it("404s when BOOTSTRAP_SECRET is unset (endpoint is hidden)", async () => {
    const db = dbWithoutSuperAdmin();
    const env = envWith({});
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, { authorization: "Bearer anything", body: VALID_BODY }),
    );
    expect(res.status).toBe(404);
    // No DB writes attempted when the route is disabled.
    expect(db.executions.length).toBe(0);
  });

  it("404s when BOOTSTRAP_SECRET is the example placeholder", async () => {
    const db = dbWithoutSuperAdmin();
    const env = envWith({ BOOTSTRAP_SECRET: "replace-with-bootstrap-secret" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, { authorization: "Bearer replace-with-bootstrap-secret", body: VALID_BODY }),
    );
    expect(res.status).toBe(404);
  });

  it("401s with no Authorization header", async () => {
    const db = dbWithoutSuperAdmin();
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, { body: VALID_BODY }),
    );
    expect(res.status).toBe(401);
  });

  it("401s with a mismatched Bearer token", async () => {
    const db = dbWithoutSuperAdmin();
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, { authorization: "Bearer wrong-secret", body: VALID_BODY }),
    );
    expect(res.status).toBe(401);
  });

  it("409s once any super_admin already exists, even with the right secret", async () => {
    const db = dbWithExistingSuperAdmin();
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, { authorization: "Bearer real-bootstrap-secret-1234", body: VALID_BODY }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("already_bootstrapped");
    // Must NOT have written a new user / university.
    expect(db.inserts("users").length).toBe(0);
    expect(db.inserts("universities").length).toBe(0);
  });

  it("400s on a too-short password", async () => {
    const db = dbWithoutSuperAdmin();
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, {
        authorization: "Bearer real-bootstrap-secret-1234",
        body: { ...VALID_BODY, password: "short" },
      }),
    );
    expect(res.status).toBe(400);
    expect(db.inserts("users").length).toBe(0);
  });

  it("400s on an obviously invalid email", async () => {
    const db = dbWithoutSuperAdmin();
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, {
        authorization: "Bearer real-bootstrap-secret-1234",
        body: { ...VALID_BODY, email: "not-an-email" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates the university + super_admin, audits both, and returns SessionUser without password_hash", async () => {
    const db = new ProgrammableD1();
    let lastInsertedUserId: string | null = null;
    let lastInsertedUniId: string | null = null;
    db.onFirst((sql, params) => {
      if (sql.includes("FROM users") && sql.includes("WHERE role = 'super_admin'")) {
        return null;
      }
      if (sql.includes("FROM users WHERE email = ?")) {
        return null;
      }
      // The handler refetches the freshly inserted user row at the end to
      // build its response — return a synthetic row matching the insert.
      if (sql.includes("FROM users WHERE id = ?")) {
        return {
          id: lastInsertedUserId,
          email: VALID_BODY.email,
          password_hash: "pbkdf2-sha256$100000$xxx$yyy",
          name: VALID_BODY.name,
          role: "super_admin",
          status: "active",
          university_id: lastInsertedUniId,
          last_sign_in_at: null,
          created_at: "2026-05-04T00:00:00.000Z",
          updated_at: "2026-05-04T00:00:00.000Z",
        };
      }
      return undefined;
    });
    db.onWrite((sql, params) => {
      if (sql.toLowerCase().startsWith("insert into universities")) {
        lastInsertedUniId = String(params[0]);
      }
      if (sql.toLowerCase().startsWith("insert into users")) {
        lastInsertedUserId = String(params[0]);
      }
    });
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, {
        authorization: "Bearer real-bootstrap-secret-1234",
        body: VALID_BODY,
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      data: { user: Record<string, unknown>; university_id: string };
    };
    // SessionUser shape — explicitly NOT including password_hash.
    expect(json.data.user.email).toBe(VALID_BODY.email);
    expect(json.data.user.role).toBe("super_admin");
    expect(json.data.user.status).toBe("active");
    expect(json.data).not.toHaveProperty("password_hash");
    expect(json.data.user).not.toHaveProperty("password_hash");
    expect(json.data.university_id).toBe(lastInsertedUniId);

    expect(db.inserts("universities").length).toBe(1);
    expect(db.inserts("users").length).toBe(1);

    const userInsert = db.inserts("users")[0]!;
    // Stored password is a hash, not the plaintext.
    const storedHash = userInsert.params[2] as string;
    expect(storedHash.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(storedHash).not.toContain(VALID_BODY.password);

    const auditInserts = db.inserts("audit_logs");
    expect(auditInserts.length).toBeGreaterThanOrEqual(2);
    const actions = auditInserts.map((e) => e.params[3]);
    expect(actions).toContain("university.created");
    expect(actions).toContain("user.created");
  });

  it("creates the super_admin without a university when university_name is omitted", async () => {
    const db = new ProgrammableD1();
    let lastInsertedUserId: string | null = null;
    db.onFirst((sql) => {
      if (sql.includes("FROM users") && sql.includes("WHERE role = 'super_admin'")) {
        return null;
      }
      if (sql.includes("FROM users WHERE email = ?")) {
        return null;
      }
      if (sql.includes("FROM users WHERE id = ?")) {
        return {
          id: lastInsertedUserId,
          email: VALID_BODY.email,
          password_hash: "pbkdf2-sha256$x$y$z",
          name: VALID_BODY.name,
          role: "super_admin",
          status: "active",
          university_id: null,
          last_sign_in_at: null,
          created_at: "2026-05-04T00:00:00.000Z",
          updated_at: "2026-05-04T00:00:00.000Z",
        };
      }
      return undefined;
    });
    db.onWrite((sql, params) => {
      if (sql.toLowerCase().startsWith("insert into users")) {
        lastInsertedUserId = String(params[0]);
      }
    });
    const env = envWith({ BOOTSTRAP_SECRET: "real-bootstrap-secret-1234" });
    const { university_name: _omit, ...bodyWithoutUni } = VALID_BODY;
    const res = await handleBootstrapSuperAdmin(
      ctxFor(env, db, {
        authorization: "Bearer real-bootstrap-secret-1234",
        body: bodyWithoutUni,
      }),
    );
    expect(res.status).toBe(201);
    expect(db.inserts("universities").length).toBe(0);
    expect(db.inserts("users").length).toBe(1);
  });
});
