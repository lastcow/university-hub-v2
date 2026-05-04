// Route tests for departments CRUD (UNI-12). Focus areas:
//   - List scoping by university and super_admin's optional filter.
//   - Create/Update/Delete restricted to super_admin or that university's admin.
//   - DELETE blocked when the department still has courses (409).
//   - Audit rows written for create/update/delete.

import { describe, expect, it } from "vitest";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleCreateDepartment,
  handleDeleteDepartment,
  handleGetDepartment,
  handleListDepartments,
  handleUpdateDepartment,
} from "../../src/routes/departments.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const UNI_B_ADMIN_ID = "00000000-0000-0000-0000-00000000cccc";
const STAFF_ID = "00000000-0000-0000-0000-00000000dddd";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";
const DEPT_A = "33333333-3333-3333-3333-333333333333";
const DEPT_B = "44444444-4444-4444-4444-444444444444";

const ACTORS = {
  superAdmin: {
    id: SUPER_ADMIN_ID,
    email: "super@example.com",
    name: "Super",
    role: "super_admin" as const,
    status: "active" as const,
    university_id: null,
  },
  uniAAdmin: {
    id: UNI_A_ADMIN_ID,
    email: "admin-a@example.com",
    name: "Admin A",
    role: "university_admin" as const,
    status: "active" as const,
    university_id: UNI_A,
  },
  uniBAdmin: {
    id: UNI_B_ADMIN_ID,
    email: "admin-b@example.com",
    name: "Admin B",
    role: "university_admin" as const,
    status: "active" as const,
    university_id: UNI_B,
  },
  staff: {
    id: STAFF_ID,
    email: "staff@example.com",
    name: "Staff",
    role: "staff" as const,
    status: "active" as const,
    university_id: UNI_A,
  },
};

interface SeededDept {
  id: string;
  university_id: string;
  name: string;
  code: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function seedDept(
  id: string,
  universityId: string,
  name = "Demo Dept",
  code: string | null = "DEMO",
): SeededDept {
  return {
    id,
    university_id: universityId,
    name,
    code,
    description: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeDb(opts: { departments?: SeededDept[]; courseCounts?: Record<string, number> } = {}): ProgrammableD1 {
  const db = new ProgrammableD1();
  const seed = opts.departments ?? [
    seedDept(DEPT_A, UNI_A, "Computer Science", "CS"),
    seedDept(DEPT_B, UNI_B, "Mathematics", "MATH"),
  ];
  const byId = new Map(seed.map((d) => [d.id, { ...d }]));
  const courseCounts = { ...(opts.courseCounts ?? {}) };

  db.onFirst((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("select id from universities")) {
      return params[0] === UNI_A || params[0] === UNI_B ? { id: params[0] } : null;
    }
    if (lower.startsWith("select id, university_id, name, code, description")
        && lower.includes("from departments")
        && lower.includes("where id = ?")) {
      return byId.get(String(params[0])) ?? null;
    }
    if (lower.startsWith("select d.id, d.university_id, d.name") && lower.includes("where d.id = ?")) {
      const dept = byId.get(String(params[0]));
      if (!dept) return null;
      return {
        ...dept,
        university_name: dept.university_id === UNI_A ? "Uni A" : "Uni B",
        course_count: courseCounts[dept.id] ?? 0,
      };
    }
    if (lower.startsWith("select id from departments") && lower.includes("university_id = ?")) {
      // collision check on code uniqueness
      const [universityId, code, idExclude] = [params[0], params[1], params[2]] as Array<unknown>;
      for (const d of byId.values()) {
        if (d.university_id === universityId && d.code === code && d.id !== idExclude) {
          return { id: d.id };
        }
      }
      return null;
    }
    if (lower.startsWith("select count(1) as count from courses where department_id = ?")) {
      return { count: courseCounts[String(params[0])] ?? 0 };
    }
    return undefined;
  });
  db.onAll((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("select d.id, d.university_id, d.name")) {
      const list = Array.from(byId.values());
      const filtered = params.length
        ? list.filter((d) => params.includes(d.university_id))
        : list;
      return filtered.map((d) => ({
        ...d,
        university_name: d.university_id === UNI_A ? "Uni A" : "Uni B",
        course_count: courseCounts[d.id] ?? 0,
      }));
    }
    return undefined;
  });
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("insert into departments")) {
      // params: id, university_id, name, code, description, created_at, updated_at
      byId.set(String(params[0]), {
        id: String(params[0]),
        university_id: String(params[1]),
        name: String(params[2]),
        code: params[3] === null ? null : String(params[3]),
        description: params[4] === null ? null : String(params[4]),
        created_at: String(params[5]),
        updated_at: String(params[6]),
      });
    }
    if (lower.startsWith("delete from departments")) {
      byId.delete(String(params[0]));
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
    MAILGUN_API_KEY: "x",
    MAILGUN_DOMAIN: "x",
    MAILGUN_FROM_EMAIL: "x@x",
    MAILGUN_FROM_NAME: "x",
  };
}

function ctx(
  actor: typeof ACTORS[keyof typeof ACTORS],
  db: ProgrammableD1,
  init?: { method?: string; body?: unknown; query?: Record<string, string> },
): RequestContext {
  const url = new URL(`https://hub.example.com/api/departments`);
  if (init?.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }
  const requestInit: RequestInit = {
    method: init?.method ?? "GET",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
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
  return { request: new Request(url, requestInit), env: makeEnv(db), url, cookies: {}, auth };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("GET /api/departments — scoping", () => {
  it("super_admin sees every department", async () => {
    const db = makeDb();
    const res = await handleListDepartments(ctx(ACTORS.superAdmin, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data).toHaveLength(2);
  });

  it("super_admin can filter by university_id", async () => {
    const db = makeDb();
    const res = await handleListDepartments(
      ctx(ACTORS.superAdmin, db, { query: { university_id: UNI_A } }),
    );
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.id).toBe(DEPT_A);
  });

  it("university_admin sees only their university's departments", async () => {
    const db = makeDb();
    const res = await handleListDepartments(ctx(ACTORS.uniAAdmin, db));
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    expect(body.data.map((d) => d.id)).toEqual([DEPT_A]);
  });

  it("non-admin still sees their university's departments", async () => {
    const db = makeDb();
    const res = await handleListDepartments(ctx(ACTORS.staff, db));
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    expect(body.data.map((d) => d.id)).toEqual([DEPT_A]);
  });
});

describe("POST /api/departments", () => {
  it("rejects non-admins", async () => {
    const db = makeDb();
    const res = await handleCreateDepartment(
      ctx(ACTORS.staff, db, { method: "POST", body: { name: "X", code: "X" } }),
    );
    expect(res.status).toBe(403);
    expect(db.inserts("departments")).toHaveLength(0);
  });

  it("super_admin must specify university_id", async () => {
    const db = makeDb();
    const res = await handleCreateDepartment(
      ctx(ACTORS.superAdmin, db, { method: "POST", body: { name: "Engineering", code: "ENG" } }),
    );
    expect(res.status).toBe(400);
  });

  it("super_admin can create + writes department.created audit", async () => {
    const db = makeDb();
    const res = await handleCreateDepartment(
      ctx(ACTORS.superAdmin, db, {
        method: "POST",
        body: { university_id: UNI_A, name: "Engineering", code: "ENG" },
      }),
    );
    expect(res.status).toBe(201);
    expect(db.inserts("departments")).toHaveLength(1);
    const audits = db.inserts("audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.params[3]).toBe("department.created");
  });

  it("university_admin is forced to their own university", async () => {
    const db = makeDb();
    const res = await handleCreateDepartment(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        // Even though they pass UNI_B, the route ignores it.
        body: { university_id: UNI_B, name: "Engineering", code: "ENG" },
      }),
    );
    expect(res.status).toBe(201);
    const inserted = db.inserts("departments")[0]!;
    expect(inserted.params[1]).toBe(UNI_A);
  });

  it("returns 409 on a duplicate code in the same university", async () => {
    const db = makeDb();
    const res = await handleCreateDepartment(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        body: { name: "Computer Science 2", code: "CS" },
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/departments/:id — scoping", () => {
  it("rejects a sibling university_admin (404)", async () => {
    const db = makeDb();
    const res = await handleUpdateDepartment(
      ctx(ACTORS.uniBAdmin, db, { method: "PATCH", body: { name: "Renamed" } }),
      DEPT_A,
    );
    expect(res.status).toBe(404);
    expect(db.updates("departments")).toHaveLength(0);
  });

  it("super_admin can update + writes department.updated audit", async () => {
    const db = makeDb();
    const res = await handleUpdateDepartment(
      ctx(ACTORS.superAdmin, db, { method: "PATCH", body: { name: "CS Renamed" } }),
      DEPT_A,
    );
    expect(res.status).toBe(200);
    expect(db.updates("departments")).toHaveLength(1);
    const audits = db.inserts("audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.params[3]).toBe("department.updated");
  });

  it("non-admin (staff) cannot update (403)", async () => {
    const db = makeDb();
    const res = await handleUpdateDepartment(
      ctx(ACTORS.staff, db, { method: "PATCH", body: { name: "X" } }),
      DEPT_A,
    );
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/departments/:id", () => {
  it("returns 404 to other tenants", async () => {
    const db = makeDb();
    const res = await handleDeleteDepartment(
      ctx(ACTORS.uniBAdmin, db, { method: "DELETE" }),
      DEPT_A,
    );
    expect(res.status).toBe(404);
  });

  it("blocks deletion when courses still reference the department (409)", async () => {
    const db = makeDb({ courseCounts: { [DEPT_A]: 3 } });
    const res = await handleDeleteDepartment(
      ctx(ACTORS.uniAAdmin, db, { method: "DELETE" }),
      DEPT_A,
    );
    expect(res.status).toBe(409);
    expect(db.executions.some((e) => e.normalizedSql.startsWith("DELETE FROM departments")))
      .toBe(false);
    // audit log NOT written when delete is rejected
    expect(db.inserts("audit_logs")).toHaveLength(0);
  });

  it("succeeds when no courses reference the department, writes audit row", async () => {
    const db = makeDb();
    const res = await handleDeleteDepartment(
      ctx(ACTORS.uniAAdmin, db, { method: "DELETE" }),
      DEPT_A,
    );
    expect(res.status).toBe(200);
    expect(db.executions.some((e) => e.normalizedSql.startsWith("DELETE FROM departments")))
      .toBe(true);
    const audits = db.inserts("audit_logs");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.params[3]).toBe("department.deleted");
  });
});

describe("GET /api/departments/:id", () => {
  it("returns 404 for out-of-scope reads (no leak)", async () => {
    const db = makeDb();
    const res = await handleGetDepartment(ctx(ACTORS.uniBAdmin, db), DEPT_A);
    expect(res.status).toBe(404);
  });

  it("returns the row to the owning admin", async () => {
    const db = makeDb();
    const res = await handleGetDepartment(ctx(ACTORS.uniAAdmin, db), DEPT_A);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { id: string; course_count: number } }>(res);
    expect(body.data.id).toBe(DEPT_A);
    expect(body.data.course_count).toBe(0);
  });
});
