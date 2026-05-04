// Route tests for courses CRUD + course assignments (UNI-12). Focus areas:
//   - List filter by department, status, search.
//   - Create with department-belongs-to-university validation.
//   - PATCH + DELETE scoping; audit rows on every write.
//   - Course assignment add/remove with role enum (spec §18) + duplicate guard.

import { describe, expect, it } from "vitest";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import {
  handleCreateCourse,
  handleCreateCourseAssignment,
  handleDeleteCourse,
  handleDeleteCourseAssignment,
  handleGetCourse,
  handleListCourseAssignments,
  handleListCourses,
  handleUpdateCourse,
} from "../../src/routes/courses.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const SUPER_ADMIN_ID = "00000000-0000-0000-0000-00000000aaaa";
const UNI_A_ADMIN_ID = "00000000-0000-0000-0000-00000000bbbb";
const UNI_B_ADMIN_ID = "00000000-0000-0000-0000-00000000cccc";
const STAFF_ID = "00000000-0000-0000-0000-00000000dddd";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";
const DEPT_A = "33333333-3333-3333-3333-333333333333";
const DEPT_B = "44444444-4444-4444-4444-444444444444";
const COURSE_A = "55555555-5555-5555-5555-555555555555";
const COURSE_B = "66666666-6666-6666-6666-666666666666";
const TEACHER_ID = "77777777-7777-7777-7777-777777777777";
const ASSIGNMENT_ID = "88888888-8888-8888-8888-888888888888";

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

interface SeededCourse {
  id: string;
  university_id: string;
  department_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  status: "active" | "inactive" | "archived";
  created_at: string;
  updated_at: string;
}

interface SeededAssignment {
  id: string;
  course_id: string;
  user_id: string;
  role: "faculty" | "teacher" | "teacher_assistant" | "student" | "viewer";
  created_at: string;
  updated_at: string;
}

function seedCourse(id: string, universityId: string, departmentId: string | null = null): SeededCourse {
  return {
    id,
    university_id: universityId,
    department_id: departmentId,
    name: "Intro Course",
    code: "INTRO-101",
    description: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function makeDb(opts: {
  courses?: SeededCourse[];
  assignments?: SeededAssignment[];
  users?: Record<string, { id: string; university_id: string | null; name: string; email: string; role: string }>;
} = {}): ProgrammableD1 {
  const db = new ProgrammableD1();
  const courses = new Map(
    (opts.courses ?? [
      seedCourse(COURSE_A, UNI_A, DEPT_A),
      seedCourse(COURSE_B, UNI_B, DEPT_B),
    ]).map((c) => [c.id, { ...c }]),
  );
  const assignments = new Map(
    (opts.assignments ?? []).map((a) => [a.id, { ...a }]),
  );
  const users = opts.users ?? {
    [TEACHER_ID]: {
      id: TEACHER_ID,
      university_id: UNI_A,
      name: "Teacher One",
      email: "teacher@example.com",
      role: "teacher",
    },
  };

  db.onFirst((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("select id from universities")) {
      return params[0] === UNI_A || params[0] === UNI_B ? { id: params[0] } : null;
    }
    if (lower.startsWith("select university_id from departments")) {
      const departmentId = String(params[0]);
      if (departmentId === DEPT_A) return { university_id: UNI_A };
      if (departmentId === DEPT_B) return { university_id: UNI_B };
      return null;
    }
    if (
      lower.startsWith("select id, university_id, department_id, name, code") &&
      lower.includes("from courses") &&
      lower.includes("where id = ?")
    ) {
      return courses.get(String(params[0])) ?? null;
    }
    if (lower.startsWith("select c.id, c.university_id") && lower.includes("where c.id = ?")) {
      const c = courses.get(String(params[0]));
      if (!c) return null;
      return {
        ...c,
        university_name: c.university_id === UNI_A ? "Uni A" : "Uni B",
        department_name: c.department_id === DEPT_A ? "CS" : c.department_id === DEPT_B ? "Math" : null,
        assignment_count: Array.from(assignments.values()).filter((a) => a.course_id === c.id).length,
      };
    }
    if (lower.startsWith("select id, university_id from users")) {
      return users[String(params[0])] ?? null;
    }
    if (lower.startsWith("select id from course_assignments")) {
      const [courseId, userId, role] = [params[0], params[1], params[2]];
      for (const a of assignments.values()) {
        if (a.course_id === courseId && a.user_id === userId && a.role === role) {
          return { id: a.id };
        }
      }
      return null;
    }
    if (lower.startsWith("select user_id, role from course_assignments")) {
      const a = assignments.get(String(params[0]));
      if (a && a.course_id === params[1]) {
        return { user_id: a.user_id, role: a.role };
      }
      return null;
    }
    if (lower.startsWith("select ca.id, ca.course_id") && lower.includes("where ca.id = ?")) {
      const a = assignments.get(String(params[0]));
      if (!a) return null;
      const u = users[a.user_id];
      if (!u) return null;
      return {
        ...a,
        user_name: u.name,
        user_email: u.email,
        user_role: u.role,
      };
    }
    return undefined;
  });
  db.onAll((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("select c.id, c.university_id")) {
      let list = Array.from(courses.values());
      // crude param-driven filtering: if any UUID param matches a known
      // university or department, filter by it.
      for (const p of params) {
        if (typeof p !== "string") continue;
        if (p === UNI_A || p === UNI_B) list = list.filter((c) => c.university_id === p);
        if (p === DEPT_A || p === DEPT_B) list = list.filter((c) => c.department_id === p);
      }
      return list.map((c) => ({
        ...c,
        university_name: c.university_id === UNI_A ? "Uni A" : "Uni B",
        department_name: c.department_id === DEPT_A ? "CS" : c.department_id === DEPT_B ? "Math" : null,
        assignment_count: Array.from(assignments.values()).filter((a) => a.course_id === c.id).length,
      }));
    }
    if (lower.startsWith("select ca.id, ca.course_id")) {
      let list = Array.from(assignments.values());
      const courseId = params.find((p) => typeof p === "string" && courses.has(p)) as string | undefined;
      if (courseId) list = list.filter((a) => a.course_id === courseId);
      return list.map((a) => {
        const u = users[a.user_id]!;
        return {
          ...a,
          user_name: u.name,
          user_email: u.email,
          user_role: u.role,
        };
      });
    }
    return undefined;
  });
  db.onWrite((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("insert into courses")) {
      // params: id, university_id, department_id, name, code, description, status, created_at, updated_at
      courses.set(String(params[0]), {
        id: String(params[0]),
        university_id: String(params[1]),
        department_id: params[2] === null ? null : String(params[2]),
        name: String(params[3]),
        code: params[4] === null ? null : String(params[4]),
        description: params[5] === null ? null : String(params[5]),
        status: String(params[6]) as SeededCourse["status"],
        created_at: String(params[7]),
        updated_at: String(params[8]),
      });
    }
    if (lower.startsWith("delete from courses")) {
      courses.delete(String(params[0]));
    }
    if (lower.startsWith("insert into course_assignments")) {
      assignments.set(String(params[0]), {
        id: String(params[0]),
        course_id: String(params[1]),
        user_id: String(params[2]),
        role: String(params[3]) as SeededAssignment["role"],
        created_at: String(params[4]),
        updated_at: String(params[5]),
      });
    }
    if (lower.startsWith("delete from course_assignments")) {
      assignments.delete(String(params[0]));
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
  const url = new URL(`https://hub.example.com/api/courses`);
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
      expires_at: "2099",
      created_at: "2026",
    },
  };
  return { request: new Request(url, requestInit), env: makeEnv(db), url, cookies: {}, auth };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe("GET /api/courses — scoping & filters", () => {
  it("super_admin sees all courses", async () => {
    const db = makeDb();
    const res = await handleListCourses(ctx(ACTORS.superAdmin, db));
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data).toHaveLength(2);
  });

  it("university_admin sees only their university's courses", async () => {
    const db = makeDb();
    const res = await handleListCourses(ctx(ACTORS.uniAAdmin, db));
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    expect(body.data.map((c) => c.id)).toEqual([COURSE_A]);
  });

  it("supports ?department=<id> filter", async () => {
    const db = makeDb();
    const res = await handleListCourses(
      ctx(ACTORS.superAdmin, db, { query: { department: DEPT_A } }),
    );
    const body = await jsonBody<{ data: Array<{ department_id: string | null }> }>(res);
    expect(body.data.map((c) => c.department_id)).toEqual([DEPT_A]);
  });
});

describe("POST /api/courses", () => {
  it("rejects non-admins", async () => {
    const db = makeDb();
    const res = await handleCreateCourse(
      ctx(ACTORS.staff, db, { method: "POST", body: { name: "X" } }),
    );
    expect(res.status).toBe(403);
  });

  it("super_admin can create + writes course.created audit", async () => {
    const db = makeDb();
    const res = await handleCreateCourse(
      ctx(ACTORS.superAdmin, db, {
        method: "POST",
        body: {
          university_id: UNI_A,
          department_id: DEPT_A,
          name: "Algorithms",
          code: "CS-201",
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(db.inserts("courses")).toHaveLength(1);
    const audits = db.inserts("audit_logs");
    expect(audits[0]!.params[3]).toBe("course.created");
  });

  it("rejects when department does not belong to the same university", async () => {
    const db = makeDb();
    const res = await handleCreateCourse(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        body: {
          name: "Cross-U Course",
          department_id: DEPT_B,
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(db.inserts("courses")).toHaveLength(0);
  });
});

describe("PATCH /api/courses/:id", () => {
  it("super_admin can update + writes course.updated audit", async () => {
    const db = makeDb();
    const res = await handleUpdateCourse(
      ctx(ACTORS.superAdmin, db, { method: "PATCH", body: { name: "Renamed" } }),
      COURSE_A,
    );
    expect(res.status).toBe(200);
    expect(db.updates("courses")).toHaveLength(1);
    const audits = db.inserts("audit_logs");
    expect(audits[0]!.params[3]).toBe("course.updated");
  });

  it("rejects sibling university_admin (404)", async () => {
    const db = makeDb();
    const res = await handleUpdateCourse(
      ctx(ACTORS.uniBAdmin, db, { method: "PATCH", body: { name: "Renamed" } }),
      COURSE_A,
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/courses/:id", () => {
  it("super_admin deletes + writes course.deleted audit", async () => {
    const db = makeDb();
    const res = await handleDeleteCourse(
      ctx(ACTORS.superAdmin, db, { method: "DELETE" }),
      COURSE_A,
    );
    expect(res.status).toBe(200);
    expect(db.executions.some((e) => e.normalizedSql.startsWith("DELETE FROM courses"))).toBe(true);
    const audits = db.inserts("audit_logs");
    expect(audits[0]!.params[3]).toBe("course.deleted");
  });
});

describe("Course assignments — POST", () => {
  it("rejects non-admin (403)", async () => {
    const db = makeDb();
    const res = await handleCreateCourseAssignment(
      ctx(ACTORS.staff, db, {
        method: "POST",
        body: { user_id: TEACHER_ID, role: "teacher" },
      }),
      COURSE_A,
    );
    expect(res.status).toBe(403);
  });

  it("creates an assignment with the spec role enum", async () => {
    const db = makeDb();
    const res = await handleCreateCourseAssignment(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        body: { user_id: TEACHER_ID, role: "teacher" },
      }),
      COURSE_A,
    );
    expect(res.status).toBe(201);
    const inserted = db.inserts("course_assignments")[0]!;
    expect(inserted.params[1]).toBe(COURSE_A);
    expect(inserted.params[2]).toBe(TEACHER_ID);
    expect(inserted.params[3]).toBe("teacher");
    // Audit row uses course.updated with metadata flagging the assignment add.
    const audits = db.inserts("audit_logs");
    expect(audits[0]!.params[3]).toBe("course.updated");
  });

  it("rejects an unknown role", async () => {
    const db = makeDb();
    const res = await handleCreateCourseAssignment(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        body: { user_id: TEACHER_ID, role: "invalid_role" },
      }),
      COURSE_A,
    );
    expect(res.status).toBe(400);
  });

  it("rejects when target user belongs to a different university", async () => {
    const db = makeDb({
      users: {
        [TEACHER_ID]: {
          id: TEACHER_ID,
          university_id: UNI_B,
          name: "T",
          email: "t@x",
          role: "teacher",
        },
      },
    });
    const res = await handleCreateCourseAssignment(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        body: { user_id: TEACHER_ID, role: "teacher" },
      }),
      COURSE_A,
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when the (course, user, role) tuple already exists", async () => {
    const db = makeDb({
      assignments: [
        {
          id: ASSIGNMENT_ID,
          course_id: COURSE_A,
          user_id: TEACHER_ID,
          role: "teacher",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const res = await handleCreateCourseAssignment(
      ctx(ACTORS.uniAAdmin, db, {
        method: "POST",
        body: { user_id: TEACHER_ID, role: "teacher" },
      }),
      COURSE_A,
    );
    expect(res.status).toBe(409);
  });
});

describe("Course assignments — DELETE", () => {
  it("removes an assignment", async () => {
    const db = makeDb({
      assignments: [
        {
          id: ASSIGNMENT_ID,
          course_id: COURSE_A,
          user_id: TEACHER_ID,
          role: "teacher",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const res = await handleDeleteCourseAssignment(
      ctx(ACTORS.uniAAdmin, db, { method: "DELETE" }),
      COURSE_A,
      ASSIGNMENT_ID,
    );
    expect(res.status).toBe(200);
    expect(db.executions.some((e) => e.normalizedSql.startsWith("DELETE FROM course_assignments"))).toBe(true);
  });
});

describe("GET /api/courses/:id — UNI-22 per-course scoping smoke test", () => {
  // Faculty actor in UNI_A — assignment status is set per-test via the
  // `select role from course_assignments` resolver.
  const facultyActor = {
    id: "00000000-0000-0000-0000-0000000000aa",
    email: "fac@example.com",
    name: "Faculty",
    role: "faculty" as const,
    status: "active" as const,
    university_id: UNI_A,
  };

  function dbWithAssignment(opts: {
    assignedTo?: { courseId: string; role: "faculty" | "teacher" | "teacher_assistant" };
  }): ProgrammableD1 {
    const db = makeDb();
    // Helper queries the courses table by (id, university_id) — the
    // existing makeDb resolver already handles `SELECT id FROM universities`
    // and the course list SELECTs, but the helper uses
    // `SELECT id, university_id FROM courses WHERE id = ?` which the existing
    // resolvers don't handle. Add it here.
    db.onFirst((sql, params) => {
      const lower = sql.toLowerCase();
      if (lower.startsWith("select id, university_id from courses")) {
        const id = String(params[0]);
        if (id === COURSE_A) return { id: COURSE_A, university_id: UNI_A };
        if (id === COURSE_B) return { id: COURSE_B, university_id: UNI_B };
        return null;
      }
      if (lower.startsWith("select role from course_assignments")) {
        const courseId = String(params[0]);
        const userId = String(params[1]);
        const allowed = new Set(params.slice(2).map(String));
        if (
          opts.assignedTo &&
          opts.assignedTo.courseId === courseId &&
          userId === facultyActor.id &&
          allowed.has(opts.assignedTo.role)
        ) {
          return { role: opts.assignedTo.role };
        }
        return null;
      }
      return undefined;
    });
    return db;
  }

  it("faculty assigned to the course can read it (200)", async () => {
    const db = dbWithAssignment({ assignedTo: { courseId: COURSE_A, role: "faculty" } });
    const res = await handleGetCourse(ctx(facultyActor, db), COURSE_A);
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: { id: string } }>(res);
    expect(body.data.id).toBe(COURSE_A);
  });

  it("faculty NOT assigned gets 404 (probe-resistant)", async () => {
    const db = dbWithAssignment({});
    const res = await handleGetCourse(ctx(facultyActor, db), COURSE_A);
    expect(res.status).toBe(404);
  });

  it("faculty assigned to course A cannot read course B (404)", async () => {
    const db = dbWithAssignment({ assignedTo: { courseId: COURSE_A, role: "faculty" } });
    // Same actor, different course.
    const res = await handleGetCourse(ctx(facultyActor, db), COURSE_B);
    expect(res.status).toBe(404);
  });

  it("super_admin still bypasses (200) without an assignments lookup", async () => {
    const db = dbWithAssignment({});
    const res = await handleGetCourse(ctx(ACTORS.superAdmin, db), COURSE_A);
    expect(res.status).toBe(200);
    expect(
      db.executions.some((e) =>
        e.normalizedSql.toLowerCase().startsWith("select role from course_assignments"),
      ),
    ).toBe(false);
  });

  it("university_admin in same uni still bypasses (200)", async () => {
    const db = dbWithAssignment({});
    const res = await handleGetCourse(ctx(ACTORS.uniAAdmin, db), COURSE_A);
    expect(res.status).toBe(200);
  });
});

describe("Course assignments — GET", () => {
  it("lists assignments for a course", async () => {
    const db = makeDb({
      assignments: [
        {
          id: ASSIGNMENT_ID,
          course_id: COURSE_A,
          user_id: TEACHER_ID,
          role: "teacher",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const res = await handleListCourseAssignments(
      ctx(ACTORS.uniAAdmin, db),
      COURSE_A,
    );
    const body = await jsonBody<{ data: Array<{ user_id: string; role: string }> }>(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.role).toBe("teacher");
  });
});
