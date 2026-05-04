// Route tests for assessments + grades + grade-access-log (UNI-30).
//
// Focus areas:
//   - FERPA record-of-access: every grade read writes a `grade_access_log`
//     row, every mutation writes both an `audit_logs` row and a
//     `grade_access_log` row.
//   - Per-course scoping (sub-issue UNI-22): faculty assigned to course A
//     can read/write grades for course A but not course B; the helper is
//     the gate, not a per-route check.
//   - RBAC: faculty/teacher can record/edit; student/TA cannot.
//   - Student-self read returns only their own grades.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import type { UserRow } from "../../src/auth/session.js";
import {
  handleCreateAssessment,
  handleListAssessments,
  handleUpdateAssessment,
} from "../../src/routes/assessments.js";
import { handleListGradeAccessLog } from "../../src/routes/grade-access-log.js";
import {
  handleCreateGrade,
  handleListCourseGrades,
  handleListStudentGrades,
  handleUpdateGrade,
} from "../../src/routes/grades.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const COURSE_A1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const COURSE_B1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01";

const SUPER_ADMIN_ID = "55555555-0000-0000-0000-000000000001";
const UNI_A_ADMIN_ID = "55555555-0000-0000-0000-000000000002";
const FACULTY_A_ID = "55555555-0000-0000-0000-000000000010";
const FACULTY_B_ID = "55555555-0000-0000-0000-000000000011";
const TEACHER_A_ID = "55555555-0000-0000-0000-000000000020";
const TA_A_ID = "55555555-0000-0000-0000-000000000030";
const STUDENT_A1_ID = "55555555-0000-0000-0000-000000000040";
const STUDENT_A2_ID = "55555555-0000-0000-0000-000000000041";

const ASSESSMENT_A1_HW1 = "66666666-aaaa-0000-0000-000000000001";
const GRADE_HW1_S1 = "77777777-aaaa-0000-0000-000000000001";

const TS = "2026-05-04T00:00:00.000Z";

interface User extends UserRow {}

function user(
  id: string,
  role: User["role"],
  university_id: string | null,
): User {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    role,
    status: "active",
    university_id,
    password_hash: "x",
    last_sign_in_at: null,
    created_at: TS,
    updated_at: TS,
  };
}

const ACTORS = {
  superAdmin: user(SUPER_ADMIN_ID, "super_admin", null),
  uniAAdmin: user(UNI_A_ADMIN_ID, "university_admin", UNI_A),
  facultyA: user(FACULTY_A_ID, "faculty", UNI_A),
  facultyB: user(FACULTY_B_ID, "faculty", UNI_A), // same uni, different course
  teacherA: user(TEACHER_A_ID, "teacher", UNI_A),
  taA: user(TA_A_ID, "teacher_assistant", UNI_A),
  studentA1: user(STUDENT_A1_ID, "student", UNI_A),
  studentA2: user(STUDENT_A2_ID, "student", UNI_A),
};

interface SeededAssessment {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  weight: number;
  max_score: number;
  due_at: string | null;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SeededGrade {
  id: string;
  assessment_id: string;
  student_user_id: string;
  score: number | null;
  letter_grade: string | null;
  feedback: string | null;
  status: "graded" | "pending" | "excused";
  graded_by_user_id: string | null;
  graded_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Fixture {
  db: ProgrammableD1;
  assessments: Map<string, SeededAssessment>;
  grades: Map<string, SeededGrade>;
  /** Course assignments — the per-course matrix. */
  assignments: Map<
    string,
    { course_id: string; user_id: string; role: string }
  >;
}

function seedFixture(): Fixture {
  const db = new ProgrammableD1();
  const courses = new Map<string, { id: string; university_id: string }>([
    [COURSE_A1, { id: COURSE_A1, university_id: UNI_A }],
    [COURSE_B1, { id: COURSE_B1, university_id: UNI_B }],
  ]);
  const users = new Map<string, User>(
    Object.values(ACTORS).map((a) => [a.id, a]),
  );
  const assignments = new Map<
    string,
    { course_id: string; user_id: string; role: string }
  >([
    ["a1", { course_id: COURSE_A1, user_id: FACULTY_A_ID, role: "faculty" }],
    ["a2", { course_id: COURSE_A1, user_id: TEACHER_A_ID, role: "teacher" }],
    [
      "a3",
      { course_id: COURSE_A1, user_id: TA_A_ID, role: "teacher_assistant" },
    ],
    ["a4", { course_id: COURSE_A1, user_id: STUDENT_A1_ID, role: "student" }],
    ["a5", { course_id: COURSE_A1, user_id: STUDENT_A2_ID, role: "student" }],
    ["a6", { course_id: COURSE_B1, user_id: FACULTY_B_ID, role: "faculty" }],
  ]);

  const assessments = new Map<string, SeededAssessment>([
    [
      ASSESSMENT_A1_HW1,
      {
        id: ASSESSMENT_A1_HW1,
        course_id: COURSE_A1,
        title: "Homework 1",
        description: null,
        weight: 0.1,
        max_score: 100,
        due_at: null,
        created_by: FACULTY_A_ID,
        deleted_at: null,
        created_at: TS,
        updated_at: TS,
      },
    ],
  ]);
  const grades = new Map<string, SeededGrade>([
    [
      GRADE_HW1_S1,
      {
        id: GRADE_HW1_S1,
        assessment_id: ASSESSMENT_A1_HW1,
        student_user_id: STUDENT_A1_ID,
        score: 85,
        letter_grade: "B",
        feedback: null,
        status: "graded",
        graded_by_user_id: FACULTY_A_ID,
        graded_at: TS,
        created_at: TS,
        updated_at: TS,
      },
    ],
  ]);

  db.onFirst((sql, params) => {
    const s = sql.toLowerCase();
    if (s.startsWith("select id, university_id from courses where id = ?")) {
      const c = courses.get(String(params[0]));
      return c ?? null;
    }
    if (
      s.startsWith("select university_id from courses where id = ?")
    ) {
      const c = courses.get(String(params[0]));
      return c ? { university_id: c.university_id } : null;
    }
    if (
      s.startsWith("select role from course_assignments") &&
      s.includes("role in")
    ) {
      const [courseId, userId, ...roles] = params as string[];
      for (const a of assignments.values()) {
        if (
          a.course_id === courseId &&
          a.user_id === userId &&
          roles.includes(a.role)
        ) {
          return { role: a.role };
        }
      }
      return null;
    }
    if (
      s.startsWith("select id from course_assignments") &&
      s.includes("where course_id = ? and user_id = ? and role = ?")
    ) {
      for (const a of assignments.values()) {
        if (
          a.course_id === params[0] &&
          a.user_id === params[1] &&
          a.role === params[2]
        ) {
          return { id: "x" };
        }
      }
      return null;
    }
    if (s.startsWith("select a.id, a.course_id, a.deleted_at,")) {
      const a = assessments.get(String(params[0]));
      if (!a) return null;
      const course = courses.get(a.course_id);
      return {
        id: a.id,
        course_id: a.course_id,
        deleted_at: a.deleted_at,
        course_university_id: course?.university_id ?? null,
      };
    }
    if (
      s.startsWith("select a.id, a.course_id, a.title, a.description,") &&
      s.includes("where a.id = ?")
    ) {
      const a = assessments.get(String(params[0]));
      if (!a) return null;
      const course = courses.get(a.course_id);
      return {
        ...a,
        course_name: "Course",
        course_code: "C",
        course_university_id: course?.university_id ?? null,
      };
    }
    if (
      s.startsWith("select g.id, g.assessment_id, g.student_user_id,") &&
      s.includes("where g.id = ?")
    ) {
      const g = grades.get(String(params[0]));
      if (!g) return null;
      const a = assessments.get(g.assessment_id);
      const course = a ? courses.get(a.course_id) : null;
      return {
        ...g,
        assessment_course_id: a?.course_id ?? null,
        course_university_id: course?.university_id ?? null,
      };
    }
    if (
      s.startsWith("select id, role, university_id from users where id = ?")
    ) {
      const u = users.get(String(params[0]));
      return u
        ? { id: u.id, role: u.role, university_id: u.university_id }
        : null;
    }
    if (
      s.startsWith("select id from grades") &&
      s.includes("assessment_id = ? and student_user_id = ?")
    ) {
      for (const g of grades.values()) {
        if (
          g.assessment_id === params[0] &&
          g.student_user_id === params[1]
        ) {
          return { id: g.id };
        }
      }
      return null;
    }
    if (s.startsWith("select count(1) as c from grade_access_log")) {
      return { c: 0 };
    }
    return undefined;
  });

  db.onAll((sql, params) => {
    const s = sql.toLowerCase();
    if (
      s.startsWith("select a.id, a.course_id, a.title, a.description,") &&
      s.includes("where a.course_id = ?")
    ) {
      const courseId = String(params[0]);
      return Array.from(assessments.values())
        .filter((a) => a.course_id === courseId && !a.deleted_at)
        .map((a) => ({
          ...a,
          course_name: "Course",
          course_code: "C",
          course_university_id: courses.get(a.course_id)?.university_id ?? null,
        }));
    }
    if (
      s.startsWith("select g.id, g.assessment_id, g.student_user_id,") &&
      s.includes("from grades g") &&
      s.includes("join assessments a") &&
      s.includes("where a.course_id = ?")
    ) {
      const courseId = String(params[0]);
      const out: unknown[] = [];
      for (const g of grades.values()) {
        const a = assessments.get(g.assessment_id);
        if (!a || a.course_id !== courseId || a.deleted_at) continue;
        const u = users.get(g.student_user_id);
        if (!u) continue;
        out.push({
          ...g,
          student_name: u.name,
          student_email: u.email,
          assessment_title: a.title,
          assessment_max_score: a.max_score,
          course_id: a.course_id,
        });
      }
      return out;
    }
    if (
      s.startsWith("select g.id, g.assessment_id, g.student_user_id,") &&
      s.includes("where g.student_user_id = ?")
    ) {
      const studentId = String(params[0]);
      const courseIds = new Set(params.slice(1).map(String));
      const out: unknown[] = [];
      for (const g of grades.values()) {
        if (g.student_user_id !== studentId) continue;
        const a = assessments.get(g.assessment_id);
        if (!a || a.deleted_at) continue;
        if (!courseIds.has(a.course_id)) continue;
        const u = users.get(g.student_user_id);
        const c = courses.get(a.course_id);
        out.push({
          ...g,
          student_name: u?.name ?? "",
          student_email: u?.email ?? "",
          assessment_title: a.title,
          assessment_max_score: a.max_score,
          assessment_weight: a.weight,
          assessment_due_at: a.due_at,
          course_id: a.course_id,
          course_name: "Course",
          course_code: "C",
          course_university_id: c?.university_id ?? null,
        });
      }
      return out;
    }
    if (
      s.startsWith("select distinct course_id from course_assignments") &&
      s.includes("role = 'student'")
    ) {
      const userId = String(params[0]);
      const out = new Set<string>();
      for (const a of assignments.values()) {
        if (a.user_id === userId && a.role === "student") out.add(a.course_id);
      }
      return Array.from(out).map((course_id) => ({ course_id }));
    }
    if (
      s.startsWith("select distinct ca.course_id from course_assignments ca")
    ) {
      const userId = String(params[0]);
      const role = String(params[1]);
      const out = new Set<string>();
      for (const a of assignments.values()) {
        if (
          a.user_id === userId &&
          a.role === "student" &&
          (role === "super_admin" || true)
        ) {
          out.add(a.course_id);
        }
      }
      return Array.from(out).map((course_id) => ({ course_id }));
    }
    if (
      s.startsWith(
        "select teaching.course_id as course_id, teaching.role as role",
      )
    ) {
      const studentId = String(params[0]);
      const teacherId = String(params[1]);
      const out: { course_id: string; role: string }[] = [];
      const studentCourses = new Set<string>();
      for (const a of assignments.values()) {
        if (a.user_id === studentId && a.role === "student") {
          studentCourses.add(a.course_id);
        }
      }
      for (const a of assignments.values()) {
        if (
          a.user_id === teacherId &&
          studentCourses.has(a.course_id) &&
          (a.role === "faculty" ||
            a.role === "teacher" ||
            a.role === "teacher_assistant")
        ) {
          out.push({ course_id: a.course_id, role: a.role });
        }
      }
      return out;
    }
    if (s.startsWith("select al.id, al.viewer_user_id,")) {
      // grade_access_log list endpoint — return rows synthesized from
      // executions for assertion convenience.
      return [];
    }
    return undefined;
  });

  // Mirror INSERTs back into the in-memory maps so subsequent reads in the
  // same test see the writes.
  db.onWrite((sql, params) => {
    const s = sql.toLowerCase();
    if (s.startsWith("insert into assessments")) {
      const [
        id,
        course_id,
        title,
        description,
        weight,
        max_score,
        due_at,
        created_by,
        created_at,
        updated_at,
      ] = params as readonly (string | number | null)[];
      assessments.set(String(id), {
        id: String(id),
        course_id: String(course_id),
        title: String(title),
        description: description as string | null,
        weight: Number(weight),
        max_score: Number(max_score),
        due_at: due_at as string | null,
        created_by: created_by as string | null,
        deleted_at: null,
        created_at: String(created_at),
        updated_at: String(updated_at),
      });
    }
    if (s.startsWith("insert into grades")) {
      const [
        id,
        assessment_id,
        student_user_id,
        score,
        letter_grade,
        feedback,
        status,
        graded_by_user_id,
        graded_at,
        created_at,
        updated_at,
      ] = params as readonly (string | number | null)[];
      grades.set(String(id), {
        id: String(id),
        assessment_id: String(assessment_id),
        student_user_id: String(student_user_id),
        score: score === null ? null : Number(score),
        letter_grade: letter_grade as string | null,
        feedback: feedback as string | null,
        status: status as SeededGrade["status"],
        graded_by_user_id: graded_by_user_id as string | null,
        graded_at: graded_at as string | null,
        created_at: String(created_at),
        updated_at: String(updated_at),
      });
    }
  });

  return { db, assessments, grades, assignments };
}

// ---------------------------------------------------------------------------
// makeCtx — local helper, doesn't depend on the isolation seed harness.
// ---------------------------------------------------------------------------

function makeCtx(
  actor: UserRow,
  db: ProgrammableD1,
  init: { method?: string; pathname?: string; body?: unknown } = {},
): RequestContext {
  const url = new URL(`https://hub.example.com${init.pathname ?? "/api/test"}`);
  const env: Env = {
    DB: db as unknown as D1Database,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    SESSION_COOKIE_NAME: "university_hub_session",
    MAILGUN_API_KEY: "x",
    MAILGUN_DOMAIN: "x",
    MAILGUN_FROM_EMAIL: "x@example.com",
    MAILGUN_FROM_NAME: "x",
    SUPPORT_EMAIL: "x@example.com",
  };
  const auth: AuthState = {
    user: actor,
    session: {
      id: "s",
      user_id: actor.id,
      token_hash: "h",
      ip_address: null,
      user_agent: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: TS,
      last_activity_at: TS,
    },
  };
  const requestInit: RequestInit = {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  return {
    request: new Request(url, requestInit),
    env,
    url,
    cookies: {},
    auth,
  };
}

async function asJson(res: Response): Promise<unknown> {
  return res.clone().json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UNI-30 / GET /api/courses/:id/grades — gradebook FERPA logging", () => {
  it("faculty assigned to course succeeds and writes one access log per row", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      pathname: `/api/courses/${COURSE_A1}/grades`,
    });
    const res = await handleListCourseGrades(ctx, COURSE_A1);
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as { data: unknown[] };
    expect(body.data).toHaveLength(1);

    const inserts = fix.db.inserts("grade_access_log");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toEqual(
      expect.arrayContaining([
        FACULTY_A_ID,
        "faculty",
        "faculty",
        COURSE_A1,
        ASSESSMENT_A1_HW1,
        GRADE_HW1_S1,
        STUDENT_A1_ID,
        "course_gradebook",
      ]),
    );
  });

  it("faculty NOT assigned to course gets 404 (course-scoping helper)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyB, fix.db, {
      pathname: `/api/courses/${COURSE_A1}/grades`,
    });
    const res = await handleListCourseGrades(ctx, COURSE_A1);
    expect(res.status).toBe(404);
    expect(fix.db.inserts("grade_access_log")).toHaveLength(0);
  });

  it("student in the course is denied (gradebook is not a student surface)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentA1, fix.db, {
      pathname: `/api/courses/${COURSE_A1}/grades`,
    });
    const res = await handleListCourseGrades(ctx, COURSE_A1);
    expect(res.status).toBe(404);
    expect(fix.db.inserts("grade_access_log")).toHaveLength(0);
  });

  it("teacher_assistant on course succeeds and is logged with viewer_course_role 'teacher_assistant'", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.taA, fix.db, {
      pathname: `/api/courses/${COURSE_A1}/grades`,
    });
    const res = await handleListCourseGrades(ctx, COURSE_A1);
    expect(res.status).toBe(200);
    const inserts = fix.db.inserts("grade_access_log");
    expect(inserts[0]?.params).toContain("teacher_assistant");
  });
});

describe("UNI-30 / GET /api/students/:id/grades", () => {
  it("student-self read returns own grades and emits student_self log rows", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentA1, fix.db, {
      pathname: `/api/students/${STUDENT_A1_ID}/grades`,
    });
    const res = await handleListStudentGrades(ctx, STUDENT_A1_ID);
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as { data: { id: string }[] };
    expect(body.data).toHaveLength(1);

    const inserts = fix.db.inserts("grade_access_log");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.params).toContain("student_self");
  });

  it("student cannot read another student's grades", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentA2, fix.db, {
      pathname: `/api/students/${STUDENT_A1_ID}/grades`,
    });
    const res = await handleListStudentGrades(ctx, STUDENT_A1_ID);
    // student role attempting to view another student → 404
    expect(res.status).toBe(404);
    expect(fix.db.inserts("grade_access_log")).toHaveLength(0);
  });

  it("faculty teaching the student's course can read their grades and writes student_view_by_faculty log", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      pathname: `/api/students/${STUDENT_A1_ID}/grades`,
    });
    const res = await handleListStudentGrades(ctx, STUDENT_A1_ID);
    expect(res.status).toBe(200);
    const inserts = fix.db.inserts("grade_access_log");
    expect(inserts.length).toBeGreaterThanOrEqual(1);
    expect(inserts[0]?.params).toContain("student_view_by_faculty");
  });

  it("faculty NOT teaching the student gets 404", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyB, fix.db, {
      pathname: `/api/students/${STUDENT_A1_ID}/grades`,
    });
    const res = await handleListStudentGrades(ctx, STUDENT_A1_ID);
    expect(res.status).toBe(404);
    expect(fix.db.inserts("grade_access_log")).toHaveLength(0);
  });
});

describe("UNI-30 / POST /api/grades — record grade", () => {
  it("faculty on course can record a grade; writes audit_logs + grade_access_log", async () => {
    const fix = seedFixture();
    // Use a brand-new (assessment, student) pair so the dupe guard doesn't
    // reject the insert. Same assessment, different student.
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      method: "POST",
      pathname: "/api/grades",
      body: {
        assessment_id: ASSESSMENT_A1_HW1,
        student_user_id: STUDENT_A2_ID,
        score: 90,
        status: "graded",
      },
    });
    const res = await handleCreateGrade(ctx);
    expect(res.status).toBe(201);

    const audits = fix.db.inserts("audit_logs");
    expect(audits.some((e) => e.params.includes("grade.created"))).toBe(true);
    const accessLogs = fix.db.inserts("grade_access_log");
    expect(accessLogs).toHaveLength(1);
  });

  it("student attempting to POST grade is 403", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentA1, fix.db, {
      method: "POST",
      pathname: "/api/grades",
      body: {
        assessment_id: ASSESSMENT_A1_HW1,
        student_user_id: STUDENT_A1_ID,
        score: 100,
      },
    });
    const res = await handleCreateGrade(ctx);
    expect(res.status).toBe(403);
  });

  it("teacher_assistant cannot record grades (faculty/teacher only)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.taA, fix.db, {
      method: "POST",
      pathname: "/api/grades",
      body: {
        assessment_id: ASSESSMENT_A1_HW1,
        student_user_id: STUDENT_A2_ID,
        score: 100,
      },
    });
    const res = await handleCreateGrade(ctx);
    expect(res.status).toBe(403);
  });

  it("rejects duplicate (assessment, student)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      method: "POST",
      pathname: "/api/grades",
      body: {
        assessment_id: ASSESSMENT_A1_HW1,
        student_user_id: STUDENT_A1_ID,
        score: 100,
      },
    });
    const res = await handleCreateGrade(ctx);
    expect(res.status).toBe(409);
  });

  it("rejects when student is not enrolled in the course", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      method: "POST",
      pathname: "/api/grades",
      body: {
        assessment_id: ASSESSMENT_A1_HW1,
        student_user_id: TEACHER_A_ID, // not a student in the course
        score: 100,
      },
    });
    const res = await handleCreateGrade(ctx);
    expect(res.status).toBe(400);
  });
});

describe("UNI-30 / PATCH /api/grades/:id — change grade", () => {
  it("writes grade.changed audit row with from/to in metadata", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      method: "PATCH",
      pathname: `/api/grades/${GRADE_HW1_S1}`,
      body: { score: 95 },
    });
    const res = await handleUpdateGrade(ctx, GRADE_HW1_S1);
    expect(res.status).toBe(200);
    const audits = fix.db.inserts("audit_logs");
    const change = audits.find((e) => e.params.includes("grade.changed"));
    expect(change).toBeDefined();
    // metadata_json is the last param (JSON string).
    const meta = JSON.parse(String(change?.params[6])) as {
      changed?: { score?: { from: number; to: number } };
    };
    expect(meta.changed?.score).toEqual({ from: 85, to: 95 });
  });

  it("faculty on different course cannot patch this grade", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyB, fix.db, {
      method: "PATCH",
      pathname: `/api/grades/${GRADE_HW1_S1}`,
      body: { score: 0 },
    });
    const res = await handleUpdateGrade(ctx, GRADE_HW1_S1);
    expect(res.status).toBe(404);
    expect(fix.db.inserts("audit_logs")).toHaveLength(0);
  });
});

describe("UNI-30 / assessments CRUD", () => {
  it("faculty on course can create an assessment with audit row", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      method: "POST",
      pathname: `/api/courses/${COURSE_A1}/assessments`,
      body: { title: "Midterm", weight: 0.4, max_score: 100 },
    });
    const res = await handleCreateAssessment(ctx, COURSE_A1);
    expect(res.status).toBe(201);
    const audits = fix.db.inserts("audit_logs");
    expect(
      audits.some((e) => e.params.includes("assessment.created")),
    ).toBe(true);
  });

  it("teacher cannot create an assessment (faculty only per spec)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.teacherA, fix.db, {
      method: "POST",
      pathname: `/api/courses/${COURSE_A1}/assessments`,
      body: { title: "Midterm" },
    });
    const res = await handleCreateAssessment(ctx, COURSE_A1);
    expect(res.status).toBe(403);
  });

  it("student in course can list assessments (read-only)", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentA1, fix.db, {
      pathname: `/api/courses/${COURSE_A1}/assessments`,
    });
    const res = await handleListAssessments(ctx, COURSE_A1);
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("PATCH on assessment by faculty on the wrong course is 404", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyB, fix.db, {
      method: "PATCH",
      pathname: `/api/assessments/${ASSESSMENT_A1_HW1}`,
      body: { title: "Hijack" },
    });
    const res = await handleUpdateAssessment(ctx, ASSESSMENT_A1_HW1);
    expect(res.status).toBe(404);
  });
});

describe("UNI-30 / GET /api/grade-access-log — admin record-of-disclosure", () => {
  it("super_admin gets 200", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.superAdmin, fix.db, {
      pathname: "/api/grade-access-log",
    });
    const res = await handleListGradeAccessLog(ctx);
    expect(res.status).toBe(200);
  });

  it("university_admin without university returns empty", async () => {
    const fix = seedFixture();
    const stranded = user(
      "00000000-0000-0000-0000-000000000099",
      "university_admin",
      null,
    );
    const ctx = makeCtx(stranded, fix.db, {
      pathname: "/api/grade-access-log",
    });
    const res = await handleListGradeAccessLog(ctx);
    expect(res.status).toBe(200);
    const body = (await asJson(res)) as { data: { items: unknown[] } };
    expect(body.data.items).toEqual([]);
  });

  it("faculty cannot view the FERPA admin log", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.facultyA, fix.db, {
      pathname: "/api/grade-access-log",
    });
    const res = await handleListGradeAccessLog(ctx);
    expect(res.status).toBe(403);
  });

  it("student cannot view the FERPA admin log", async () => {
    const fix = seedFixture();
    const ctx = makeCtx(ACTORS.studentA1, fix.db, {
      pathname: "/api/grade-access-log",
    });
    const res = await handleListGradeAccessLog(ctx);
    expect(res.status).toBe(403);
  });
});
