// Faculty / teacher / teacher_assistant scoping (UNI-48).
//
// A faculty actor must see only:
//   - courses they are assigned to (course_assignments.role='faculty')
//   - students enrolled in those courses (course_assignments.role='student')
//   - teacher assistants assigned to those courses (role='teacher_assistant')
//
// The dashboard summary must return 200 for faculty (not 403) and report
// counts within the actor's university; the Mailgun status endpoint must
// return 403 for any role other than super_admin.

import { describe, expect, it } from "vitest";

import type { Role } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { handleListCourses } from "../../src/routes/courses.js";
import { handleDashboardSummary } from "../../src/routes/dashboard.js";
import { handleListStudents } from "../../src/routes/students.js";
import { handleListTeacherAssistants } from "../../src/routes/teacher-assistants.js";
import { handleGetMailgunStatus } from "../../src/routes/settings.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const FACULTY_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUPER_ADMIN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Courses A1+A2 are taught by FACULTY_ID; B1 is taught by someone else.
const COURSE_A1 = "11111111-aaaa-aaaa-aaaa-111111111111";
const COURSE_A2 = "22222222-aaaa-aaaa-aaaa-222222222222";
const COURSE_B1 = "33333333-aaaa-aaaa-aaaa-333333333333";

// Students enrolled: STUDENT_X+Y in A1, STUDENT_Y in A2, STUDENT_Z in B1.
const STUDENT_X = "ssssssss-aaaa-0000-0000-000000000001";
const STUDENT_Y = "ssssssss-aaaa-0000-0000-000000000002";
const STUDENT_Z = "ssssssss-aaaa-0000-0000-000000000003";

// TAs: TA_P assigned to A1, TA_Q assigned to B1 (so TA_Q must NOT show up
// in the faculty's TA list even though it's the same university).
const TA_P_USER = "tttttttt-aaaa-0000-0000-000000000001";
const TA_Q_USER = "tttttttt-bbbb-0000-0000-000000000002";
const TA_P_ROW = "tttttttt-aaaa-1111-1111-000000000001";
const TA_Q_ROW = "tttttttt-bbbb-1111-1111-000000000002";

const TS = "2026-05-04T00:00:00.000Z";

interface SeededCourse {
  id: string;
  university_id: string;
  department_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  status: "active";
  created_at: string;
  updated_at: string;
}

interface SeededAssignment {
  course_id: string;
  user_id: string;
  role: "faculty" | "teacher" | "teacher_assistant" | "student";
}

interface SeededStudentRow {
  id: string;
  user_id: string;
  university_id: string;
}

interface SeededTaRow {
  id: string;
  user_id: string;
  university_id: string;
}

const COURSES: SeededCourse[] = [
  {
    id: COURSE_A1,
    university_id: UNI_A,
    department_id: null,
    name: "Algorithms",
    code: "CS-201",
    description: null,
    status: "active",
    created_at: TS,
    updated_at: TS,
  },
  {
    id: COURSE_A2,
    university_id: UNI_A,
    department_id: null,
    name: "Compilers",
    code: "CS-301",
    description: null,
    status: "active",
    created_at: TS,
    updated_at: TS,
  },
  {
    id: COURSE_B1,
    university_id: UNI_A, // same university — scoping must be by assignment, not uni.
    department_id: null,
    name: "Databases",
    code: "CS-401",
    description: null,
    status: "active",
    created_at: TS,
    updated_at: TS,
  },
];

const ASSIGNMENTS: SeededAssignment[] = [
  // Faculty teaches A1 + A2.
  { course_id: COURSE_A1, user_id: FACULTY_ID, role: "faculty" },
  { course_id: COURSE_A2, user_id: FACULTY_ID, role: "faculty" },
  // STUDENT_X enrolled only in A1; STUDENT_Y in A1+A2; STUDENT_Z only in B1.
  { course_id: COURSE_A1, user_id: STUDENT_X, role: "student" },
  { course_id: COURSE_A1, user_id: STUDENT_Y, role: "student" },
  { course_id: COURSE_A2, user_id: STUDENT_Y, role: "student" },
  { course_id: COURSE_B1, user_id: STUDENT_Z, role: "student" },
  // TA_P helps A1; TA_Q only on B1.
  { course_id: COURSE_A1, user_id: TA_P_USER, role: "teacher_assistant" },
  { course_id: COURSE_B1, user_id: TA_Q_USER, role: "teacher_assistant" },
];

const STUDENT_ROWS: SeededStudentRow[] = [
  { id: "stu-row-x", user_id: STUDENT_X, university_id: UNI_A },
  { id: "stu-row-y", user_id: STUDENT_Y, university_id: UNI_A },
  { id: "stu-row-z", user_id: STUDENT_Z, university_id: UNI_A },
];

const TA_ROWS: SeededTaRow[] = [
  { id: TA_P_ROW, user_id: TA_P_USER, university_id: UNI_A },
  { id: TA_Q_ROW, user_id: TA_Q_USER, university_id: UNI_A },
];

// ---------------------------------------------------------------------------
// In-memory D1 stand-in that honours the new scoping subqueries.
// ---------------------------------------------------------------------------

function makeDb(): ProgrammableD1 {
  const db = new ProgrammableD1();

  // Resolve "courses I'm assigned to in role X" from the seeded ASSIGNMENTS.
  function coursesForActor(userId: string, role: string): string[] {
    return ASSIGNMENTS.filter((a) => a.user_id === userId && a.role === role).map(
      (a) => a.course_id,
    );
  }
  function studentsInCourses(courseIds: readonly string[]): string[] {
    return ASSIGNMENTS.filter(
      (a) => a.role === "student" && courseIds.includes(a.course_id),
    ).map((a) => a.user_id);
  }
  function tasInCourses(courseIds: readonly string[]): string[] {
    return ASSIGNMENTS.filter(
      (a) => a.role === "teacher_assistant" && courseIds.includes(a.course_id),
    ).map((a) => a.user_id);
  }

  db.onAll((sql, params) => {
    // ---- Courses list ----
    if (sql.includes("FROM courses c") && sql.includes("ORDER BY c.name ASC")) {
      let list = [...COURSES];
      if (sql.includes("c.university_id = ?")) {
        const uniId = params[0];
        list = list.filter((c) => c.university_id === uniId);
      }
      if (sql.includes("course_assignments WHERE user_id = ? AND role = ?")) {
        // params: [uniId?, actorId, role] — actorId is the second-to-last
        // string that matches a known user id; role is the last one.
        const role = String(params[params.length - 1]);
        const actorId = String(params[params.length - 2]);
        const myCourses = coursesForActor(actorId, role);
        list = list.filter((c) => myCourses.includes(c.id));
      }
      return list.map((c) => ({
        ...c,
        university_name: "Uni A",
        department_name: null,
        assignment_count: ASSIGNMENTS.filter((a) => a.course_id === c.id).length,
      }));
    }

    // ---- Students list ----
    if (sql.includes("FROM students s") && sql.includes("ORDER BY u.name ASC")) {
      let rows = [...STUDENT_ROWS];
      if (sql.includes("s.university_id = ?")) {
        rows = rows.filter((r) => r.university_id === params[0]);
      }
      if (sql.includes("FROM course_assignments ca_student")) {
        // Last two params are actor_id + actor_role (role of the actor in
        // their own course assignments, not 'student').
        const actorRole = String(params[params.length - 1]);
        const actorId = String(params[params.length - 2]);
        const myCourses = coursesForActor(actorId, actorRole);
        const allowed = studentsInCourses(myCourses);
        rows = rows.filter((r) => allowed.includes(r.user_id));
      }
      return rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        university_id: r.university_id,
        department_id: null,
        student_number: null,
        directory_info_opt_out: 0,
        under_18: 0,
        parent_guardian_email: null,
        created_at: TS,
        updated_at: TS,
        name: `Student ${r.user_id.slice(-1)}`,
        email: `${r.user_id.slice(-1)}@example.com`,
        university_name: "Uni A",
        department_name: null,
      }));
    }

    // ---- Teacher-assistants list ----
    if (
      sql.includes("FROM teacher_assistants ta") &&
      sql.includes("ORDER BY u.name ASC")
    ) {
      let rows = [...TA_ROWS];
      if (sql.includes("ta.university_id = ?")) {
        rows = rows.filter((r) => r.university_id === params[0]);
      }
      if (sql.includes("FROM course_assignments ca_ta")) {
        const actorRole = String(params[params.length - 1]);
        const actorId = String(params[params.length - 2]);
        const myCourses = coursesForActor(actorId, actorRole);
        const allowed = tasInCourses(myCourses);
        rows = rows.filter((r) => allowed.includes(r.user_id));
      }
      return rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        university_id: r.university_id,
        department_id: null,
        created_at: TS,
        updated_at: TS,
        name: r.user_id,
        email: `${r.user_id}@example.com`,
        university_name: "Uni A",
        department_name: null,
      }));
    }

    return undefined;
  });

  db.onFirst((sql, params) => {
    // Dashboard counts.
    if (sql.startsWith("SELECT COUNT(*) AS c FROM universities")) {
      if (sql.includes("AND id = ?")) {
        return params[0] === UNI_A ? { c: 1 } : { c: 0 };
      }
      return { c: 1 };
    }
    if (sql.startsWith("SELECT COUNT(*) AS c FROM users")) {
      if (sql.includes("AND university_id = ?")) {
        return params[0] === UNI_A ? { c: 7 } : { c: 0 };
      }
      return { c: 9 };
    }
    if (sql.startsWith("SELECT COUNT(*) AS c FROM invitations")) {
      if (sql.includes("AND university_id = ?")) {
        return params[0] === UNI_A ? { c: 2 } : { c: 0 };
      }
      return { c: 5 };
    }
    return undefined;
  });

  return db;
}

function makeEnv(db: ProgrammableD1): Env {
  return {
    DB: db as unknown as D1Database,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    APP_ENV: "production",
    MAILGUN_API_KEY: "x",
    MAILGUN_DOMAIN: "x",
    MAILGUN_FROM_EMAIL: "no-reply@example.com",
    MAILGUN_FROM_NAME: "University Hub",
  } as unknown as Env;
}

interface ActorOpts {
  id?: string;
  role: Role;
  university_id?: string | null;
}

function ctx(actor: ActorOpts, db: ProgrammableD1, path = "/api/courses"): RequestContext {
  const url = new URL(`https://hub.example.com${path}`);
  const id = actor.id ?? FACULTY_ID;
  const auth: AuthState = {
    user: {
      id,
      email: `${id}@example.com`,
      name: id,
      role: actor.role,
      status: "active",
      university_id: actor.university_id ?? UNI_A,
      password_hash: "x",
      last_sign_in_at: null,
      created_at: TS,
      updated_at: TS,
    } as UserRow,
    session: {
      id: "s",
      user_id: id,
      token_hash: "h",
      ip_address: null,
      user_agent: null,
      expires_at: "2099",
      created_at: TS,
      last_activity_at: TS,
    },
  };
  return {
    request: new Request(url, { method: "GET" }),
    env: makeEnv(db),
    url,
    cookies: {},
    auth,
  };
}

async function jsonBody<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/courses — faculty scoping", () => {
  it("faculty sees only courses they're assigned to (A1, A2 — not B1)", async () => {
    const db = makeDb();
    const res = await handleListCourses(ctx({ role: "faculty" }, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ id: string }> }>(res);
    const ids = body.data.map((c) => c.id).sort();
    expect(ids).toEqual([COURSE_A1, COURSE_A2].sort());
    expect(ids).not.toContain(COURSE_B1);
  });

  it("super_admin still sees every course (no scoping applied)", async () => {
    const db = makeDb();
    const res = await handleListCourses(
      ctx({ id: SUPER_ADMIN_ID, role: "super_admin", university_id: null }, db),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data).toHaveLength(3);
  });

  it("faculty with no assignments sees an empty list, not 403", async () => {
    const db = makeDb();
    const res = await handleListCourses(
      ctx({ id: "no-assignments-faculty", role: "faculty" }, db),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data).toEqual([]);
  });
});

describe("GET /api/students — faculty scoping", () => {
  it("faculty only sees students enrolled in courses they teach", async () => {
    const db = makeDb();
    const res = await handleListStudents(ctx({ role: "faculty" }, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ user_id: string }> }>(res);
    const ids = body.data.map((s) => s.user_id).sort();
    // STUDENT_X (A1) + STUDENT_Y (A1+A2) — STUDENT_Z (only B1) must be hidden.
    expect(ids).toEqual([STUDENT_X, STUDENT_Y].sort());
    expect(ids).not.toContain(STUDENT_Z);
  });

  it("super_admin sees every student", async () => {
    const db = makeDb();
    const res = await handleListStudents(
      ctx({ id: SUPER_ADMIN_ID, role: "super_admin", university_id: null }, db),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: unknown[] }>(res);
    expect(body.data).toHaveLength(3);
  });
});

describe("GET /api/teacher-assistants — faculty scoping", () => {
  it("faculty only sees TAs assigned to courses they teach", async () => {
    const db = makeDb();
    const res = await handleListTeacherAssistants(ctx({ role: "faculty" }, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{ data: Array<{ user_id: string }> }>(res);
    expect(body.data.map((t) => t.user_id)).toEqual([TA_P_USER]);
  });
});

describe("GET /api/dashboard/summary — faculty access", () => {
  it("returns 200 for faculty with counts scoped to their university", async () => {
    const db = makeDb();
    const res = await handleDashboardSummary(ctx({ role: "faculty" }, db));
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { universities: number; users: number; invitations: number };
    }>(res);
    expect(body.data.universities).toBe(1);
    expect(body.data.users).toBe(7);
    expect(body.data.invitations).toBe(2);
  });

  it("super_admin sees global counts", async () => {
    const db = makeDb();
    const res = await handleDashboardSummary(
      ctx({ id: SUPER_ADMIN_ID, role: "super_admin", university_id: null }, db),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{
      data: { universities: number; users: number; invitations: number };
    }>(res);
    expect(body.data.universities).toBe(1);
    expect(body.data.users).toBe(9);
    expect(body.data.invitations).toBe(5);
  });
});

describe("GET /api/settings/mailgun-status — admin gating", () => {
  it("returns 403 for faculty (the reported leak)", async () => {
    const db = makeDb();
    const res = handleGetMailgunStatus(ctx({ role: "faculty" }, db));
    expect(res.status).toBe(403);
  });

  it("returns 403 for university_admin (still admin-ops, not their concern)", async () => {
    const db = makeDb();
    const res = handleGetMailgunStatus(ctx({ role: "university_admin" }, db));
    expect(res.status).toBe(403);
  });

  it("returns 200 for super_admin", async () => {
    const db = makeDb();
    const res = handleGetMailgunStatus(
      ctx({ id: SUPER_ADMIN_ID, role: "super_admin", university_id: null }, db),
    );
    expect(res.status).toBe(200);
  });
});
