// Unit tests for the per-course scoping helper (UNI-22). Covers the matrix:
// assigned faculty, unassigned faculty, different-course faculty, wrong role
// on the course, nonexistent course; admin bypass; cross-university actor;
// list-side `forCoursesOfActor`; CourseScope branding (compile-time check).

import { describe, expect, it } from "vitest";

import {
  COURSE_SCOPED_ROLES,
  CourseScopeError,
  assertActorOnCourse,
  courseScopeErrorResponse,
  forCourse,
  forCoursesOfActor,
  isCourseScopedRole,
  toActor,
  type Actor,
  type CourseScope,
} from "../../src/db/scoped.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const COURSE_A1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const COURSE_A2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02";
const COURSE_B1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01";
const NONEXISTENT_COURSE = "ffffffff-ffff-ffff-ffff-ffffffffffff";

const SUPER_ADMIN: Actor = {
  user_id: "00000000-0000-0000-0000-000000000001",
  role: "super_admin",
  university_id: null,
};
const UNI_A_ADMIN: Actor = {
  user_id: "00000000-0000-0000-0000-000000000002",
  role: "university_admin",
  university_id: UNI_A,
};
const UNI_B_ADMIN: Actor = {
  user_id: "00000000-0000-0000-0000-000000000003",
  role: "university_admin",
  university_id: UNI_B,
};

const FACULTY_ASSIGNED_A1: Actor = {
  user_id: "00000000-0000-0000-0000-000000000010",
  role: "faculty",
  university_id: UNI_A,
};
const FACULTY_ASSIGNED_A2: Actor = {
  user_id: "00000000-0000-0000-0000-000000000011",
  role: "faculty",
  university_id: UNI_A,
};
const FACULTY_UNASSIGNED: Actor = {
  user_id: "00000000-0000-0000-0000-000000000012",
  role: "faculty",
  university_id: UNI_A,
};
const FACULTY_OF_OTHER_UNI: Actor = {
  user_id: "00000000-0000-0000-0000-000000000013",
  role: "faculty",
  university_id: UNI_B,
};
const TEACHER_ASSIGNED_A1: Actor = {
  user_id: "00000000-0000-0000-0000-000000000014",
  role: "teacher",
  university_id: UNI_A,
};
const TA_ASSIGNED_A1: Actor = {
  user_id: "00000000-0000-0000-0000-000000000015",
  role: "teacher_assistant",
  university_id: UNI_A,
};
const STUDENT_ENROLLED_A1: Actor = {
  user_id: "00000000-0000-0000-0000-000000000016",
  role: "student",
  university_id: UNI_A,
};
const VIEWER_ON_A1: Actor = {
  user_id: "00000000-0000-0000-0000-000000000017",
  role: "viewer",
  university_id: UNI_A,
};

interface SeededAssignment {
  course_id: string;
  user_id: string;
  role: "faculty" | "teacher" | "teacher_assistant" | "student" | "viewer";
}

interface SeededCourse {
  id: string;
  university_id: string;
}

function makeDb(opts: {
  courses?: SeededCourse[];
  assignments?: SeededAssignment[];
} = {}): ProgrammableD1 {
  const courses = opts.courses ?? [
    { id: COURSE_A1, university_id: UNI_A },
    { id: COURSE_A2, university_id: UNI_A },
    { id: COURSE_B1, university_id: UNI_B },
  ];
  const assignments = opts.assignments ?? [
    { course_id: COURSE_A1, user_id: FACULTY_ASSIGNED_A1.user_id, role: "faculty" },
    { course_id: COURSE_A2, user_id: FACULTY_ASSIGNED_A2.user_id, role: "faculty" },
    { course_id: COURSE_A1, user_id: TEACHER_ASSIGNED_A1.user_id, role: "teacher" },
    { course_id: COURSE_A1, user_id: TA_ASSIGNED_A1.user_id, role: "teacher_assistant" },
    { course_id: COURSE_A1, user_id: STUDENT_ENROLLED_A1.user_id, role: "student" },
    { course_id: COURSE_A1, user_id: VIEWER_ON_A1.user_id, role: "viewer" },
  ];

  const db = new ProgrammableD1();

  db.onFirst((sql, params) => {
    const lower = sql.toLowerCase();

    if (lower.startsWith("select id, university_id from courses")) {
      const id = String(params[0]);
      const c = courses.find((x) => x.id === id);
      return c ?? null;
    }

    if (lower.startsWith("select role from course_assignments")) {
      // params: courseId, userId, ...allowedRoles
      const courseId = String(params[0]);
      const userId = String(params[1]);
      const allowed = new Set(params.slice(2).map(String));
      const a = assignments.find(
        (x) => x.course_id === courseId && x.user_id === userId && allowed.has(x.role),
      );
      return a ? { role: a.role } : null;
    }

    return undefined;
  });

  db.onAll((sql, params) => {
    const lower = sql.toLowerCase();
    if (lower.startsWith("select distinct course_id from course_assignments")) {
      // params: userId, ...roles
      const userId = String(params[0]);
      const allowed = new Set(params.slice(1).map(String));
      const ids = new Set<string>();
      for (const a of assignments) {
        if (a.user_id === userId && allowed.has(a.role)) ids.add(a.course_id);
      }
      return Array.from(ids).map((course_id) => ({ course_id }));
    }
    return undefined;
  });

  return db;
}

const env = (db: ProgrammableD1): D1Database => db as unknown as D1Database;

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

describe("constants & helpers", () => {
  it("COURSE_SCOPED_ROLES covers faculty/teacher/teacher_assistant", () => {
    expect(COURSE_SCOPED_ROLES).toEqual(["faculty", "teacher", "teacher_assistant"]);
  });

  it("isCourseScopedRole identifies the gated roles", () => {
    expect(isCourseScopedRole("faculty")).toBe(true);
    expect(isCourseScopedRole("teacher")).toBe(true);
    expect(isCourseScopedRole("teacher_assistant")).toBe(true);
    expect(isCourseScopedRole("student")).toBe(false);
    expect(isCourseScopedRole("super_admin")).toBe(false);
    expect(isCourseScopedRole("university_admin")).toBe(false);
  });

  it("toActor projects the minimal shape", () => {
    const actor = toActor({
      id: "abc",
      role: "faculty",
      university_id: UNI_A,
      // extra fields are tolerated
      name: "F",
      email: "f@x",
      status: "active",
    } as never);
    expect(actor).toEqual({
      user_id: "abc",
      role: "faculty",
      university_id: UNI_A,
    });
  });
});

// ---------------------------------------------------------------------------
// assertActorOnCourse — the matrix
// ---------------------------------------------------------------------------

describe("assertActorOnCourse — assigned vs unassigned vs wrong-role vs wrong-course", () => {
  it("allows faculty assigned to the course (resolves with assignmentRole=faculty)", async () => {
    const db = makeDb();
    const result = await assertActorOnCourse(env(db), FACULTY_ASSIGNED_A1, COURSE_A1);
    expect(result.assignmentRole).toBe("faculty");
    expect(result.courseId).toBe(COURSE_A1);
    expect(result.universityId).toBe(UNI_A);
  });

  it("allows teacher assigned to the course", async () => {
    const db = makeDb();
    const result = await assertActorOnCourse(env(db), TEACHER_ASSIGNED_A1, COURSE_A1);
    expect(result.assignmentRole).toBe("teacher");
  });

  it("allows teacher_assistant assigned to the course", async () => {
    const db = makeDb();
    const result = await assertActorOnCourse(env(db), TA_ASSIGNED_A1, COURSE_A1);
    expect(result.assignmentRole).toBe("teacher_assistant");
  });

  it("rejects faculty NOT assigned to ANY course (course_access_denied)", async () => {
    const db = makeDb();
    await expect(
      assertActorOnCourse(env(db), FACULTY_UNASSIGNED, COURSE_A1),
    ).rejects.toMatchObject({
      name: "CourseScopeError",
      reason: "course_access_denied",
      courseId: COURSE_A1,
    });
  });

  it("rejects faculty assigned to a DIFFERENT course in the same university", async () => {
    const db = makeDb();
    // FACULTY_ASSIGNED_A2 teaches COURSE_A2; asking about COURSE_A1 must fail.
    await expect(
      assertActorOnCourse(env(db), FACULTY_ASSIGNED_A2, COURSE_A1),
    ).rejects.toMatchObject({
      reason: "course_access_denied",
      courseId: COURSE_A1,
    });
  });

  it("rejects an actor whose course-assignment exists but in a non-allowed course-role (student)", async () => {
    const db = makeDb();
    // STUDENT_ENROLLED_A1 has a course_assignments row in role=student on
    // COURSE_A1, but the default allowed set is faculty/teacher/TA.
    await expect(
      assertActorOnCourse(env(db), STUDENT_ENROLLED_A1, COURSE_A1),
    ).rejects.toMatchObject({ reason: "course_access_denied" });
  });

  it("rejects a viewer-role assignment under the default allow-list", async () => {
    const db = makeDb();
    await expect(
      assertActorOnCourse(env(db), VIEWER_ON_A1, COURSE_A1),
    ).rejects.toMatchObject({ reason: "course_access_denied" });
  });

  it("returns course_not_found (not access_denied) for a nonexistent course id", async () => {
    const db = makeDb();
    await expect(
      assertActorOnCourse(env(db), FACULTY_ASSIGNED_A1, NONEXISTENT_COURSE),
    ).rejects.toMatchObject({
      reason: "course_not_found",
      courseId: NONEXISTENT_COURSE,
    });
  });

  it("rejects faculty whose university_id differs from the course's", async () => {
    const db = makeDb();
    // FACULTY_OF_OTHER_UNI is in UNI_B; even if they had a stale assignment on
    // COURSE_A1 (they don't here), the cross-uni guard short-circuits.
    await expect(
      assertActorOnCourse(env(db), FACULTY_OF_OTHER_UNI, COURSE_A1),
    ).rejects.toMatchObject({ reason: "course_access_denied" });
  });

  it("respects a custom allowed-roles list (teacher only)", async () => {
    const db = makeDb();
    // Faculty assigned to COURSE_A1 in role=faculty must fail when caller
    // restricts to ["teacher"] only.
    await expect(
      assertActorOnCourse(env(db), FACULTY_ASSIGNED_A1, COURSE_A1, ["teacher"]),
    ).rejects.toMatchObject({ reason: "course_access_denied" });

    // …but a teacher with a teacher-row passes.
    const okay = await assertActorOnCourse(
      env(db),
      TEACHER_ASSIGNED_A1,
      COURSE_A1,
      ["teacher"],
    );
    expect(okay.assignmentRole).toBe("teacher");
  });

  it("rejects when the allowed-roles list is empty (no role can satisfy it)", async () => {
    const db = makeDb();
    await expect(
      assertActorOnCourse(env(db), FACULTY_ASSIGNED_A1, COURSE_A1, []),
    ).rejects.toMatchObject({ reason: "course_access_denied" });
  });
});

describe("assertActorOnCourse — admin bypass", () => {
  it("super_admin passes any course without an assignments lookup", async () => {
    const db = makeDb();
    const result = await assertActorOnCourse(env(db), SUPER_ADMIN, COURSE_B1);
    expect(result.assignmentRole).toBe("admin");
    expect(result.universityId).toBe(UNI_B);
    // No SELECT against course_assignments was needed.
    expect(
      db.executions.some((e) =>
        e.normalizedSql.toLowerCase().startsWith("select role from course_assignments"),
      ),
    ).toBe(false);
  });

  it("university_admin passes a course in their own university", async () => {
    const db = makeDb();
    const result = await assertActorOnCourse(env(db), UNI_A_ADMIN, COURSE_A1);
    expect(result.assignmentRole).toBe("admin");
  });

  it("university_admin from another university is denied", async () => {
    const db = makeDb();
    await expect(
      assertActorOnCourse(env(db), UNI_B_ADMIN, COURSE_A1),
    ).rejects.toMatchObject({ reason: "course_access_denied" });
  });

  it("super_admin still gets course_not_found for a missing course", async () => {
    const db = makeDb();
    await expect(
      assertActorOnCourse(env(db), SUPER_ADMIN, NONEXISTENT_COURSE),
    ).rejects.toMatchObject({ reason: "course_not_found" });
  });
});

// ---------------------------------------------------------------------------
// forCoursesOfActor
// ---------------------------------------------------------------------------

describe("forCoursesOfActor", () => {
  it("returns the courses an actor is assigned to in a single role", async () => {
    const db = makeDb();
    const ids = await forCoursesOfActor(env(db), FACULTY_ASSIGNED_A1, "faculty");
    expect(ids).toEqual([COURSE_A1]);
  });

  it("accepts an array of course-roles (union)", async () => {
    const db = makeDb();
    const ids = await forCoursesOfActor(env(db), FACULTY_ASSIGNED_A1, [
      "faculty",
      "teacher",
    ]);
    expect(ids).toEqual([COURSE_A1]);
  });

  it("returns [] when the actor has no assignment in the requested role", async () => {
    const db = makeDb();
    const ids = await forCoursesOfActor(env(db), FACULTY_UNASSIGNED, "faculty");
    expect(ids).toEqual([]);
  });

  it("does not blend course-roles: asking for 'teacher' on a faculty actor returns []", async () => {
    const db = makeDb();
    const ids = await forCoursesOfActor(env(db), FACULTY_ASSIGNED_A1, "teacher");
    expect(ids).toEqual([]);
  });

  it("an empty role array short-circuits to []", async () => {
    const db = makeDb();
    const ids = await forCoursesOfActor(env(db), FACULTY_ASSIGNED_A1, []);
    expect(ids).toEqual([]);
    expect(db.executions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// forCourse — branded scope
// ---------------------------------------------------------------------------

describe("forCourse", () => {
  it("returns a CourseScope carrying the resolved course + assignment role", async () => {
    const db = makeDb();
    const scope = await forCourse(env(db), COURSE_A1, FACULTY_ASSIGNED_A1);
    expect(scope.courseId).toBe(COURSE_A1);
    expect(scope.universityId).toBe(UNI_A);
    expect(scope.assignmentRole).toBe("faculty");
    expect(scope.actor).toEqual(FACULTY_ASSIGNED_A1);
  });

  it("the scope's queryAll/queryFirst/execute proxy to the underlying DB", async () => {
    const db = makeDb();
    db.onAll((sql) =>
      sql.toLowerCase().startsWith("select 1 as a") ? [{ a: 1 }] : undefined,
    );
    db.onFirst((sql) =>
      sql.toLowerCase().startsWith("select 2 as b") ? { b: 2 } : undefined,
    );

    const scope = await forCourse(env(db), COURSE_A1, FACULTY_ASSIGNED_A1);
    const all = await scope.queryAll<{ a: number }>("SELECT 1 AS a");
    const first = await scope.queryFirst<{ b: number }>("SELECT 2 AS b");
    await scope.execute(
      "INSERT INTO grade_access_log (id, viewer_user_id) VALUES (?, ?)",
      ["log-1", FACULTY_ASSIGNED_A1.user_id],
    );

    expect(all).toEqual([{ a: 1 }]);
    expect(first).toEqual({ b: 2 });
    expect(
      db.executions.some(
        (e) => e.normalizedSql.toLowerCase().startsWith("insert into grade_access_log"),
      ),
    ).toBe(true);
  });

  it("propagates CourseScopeError when the actor isn't assigned", async () => {
    const db = makeDb();
    await expect(
      forCourse(env(db), COURSE_A1, FACULTY_UNASSIGNED),
    ).rejects.toBeInstanceOf(CourseScopeError);
  });

  it("propagates CourseScopeError(course_not_found) for an unknown course id", async () => {
    const db = makeDb();
    await expect(
      forCourse(env(db), NONEXISTENT_COURSE, FACULTY_ASSIGNED_A1),
    ).rejects.toMatchObject({ reason: "course_not_found" });
  });
});

// ---------------------------------------------------------------------------
// courseScopeErrorResponse
// ---------------------------------------------------------------------------

describe("courseScopeErrorResponse", () => {
  it("returns 404 by default for course_access_denied (probe-resistant)", async () => {
    const err = new CourseScopeError("course_access_denied", COURSE_A1, "u");
    const res = courseScopeErrorResponse(err);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns 404 for course_not_found regardless of opts", async () => {
    const err = new CourseScopeError("course_not_found", COURSE_A1, "u");
    const res404 = courseScopeErrorResponse(err);
    const resOpt = courseScopeErrorResponse(err, { as: "forbidden" });
    expect(res404.status).toBe(404);
    expect(resOpt.status).toBe(404);
  });

  it("returns 403 when explicitly asked, only for access_denied", async () => {
    const err = new CourseScopeError("course_access_denied", COURSE_A1, "u");
    const res = courseScopeErrorResponse(err, { as: "forbidden" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// Type-level checks (compile-time)
// ---------------------------------------------------------------------------

// Sanity: the helpers REQUIRE an Actor — passing nothing must be a type error.
// We can't write a runtime test for "fails to compile", but we encode the
// expectation as a `// @ts-expect-error` so a regression that loosens the
// signature would cause this file to fail typecheck.
describe("type-level: Actor is required", () => {
  it("has assertions enforced by the compiler (smoke)", async () => {
    const db = makeDb();
    // Positive: passes with an Actor.
    await assertActorOnCourse(env(db), FACULTY_ASSIGNED_A1, COURSE_A1);

    // Negative: omitting the Actor must be a compile error. We can't check
    // this at runtime, but the @ts-expect-error directive makes a regression
    // (e.g. accidentally making `actor` optional) a type-check failure.
    // @ts-expect-error — Actor argument is intentionally required.
    void (() => assertActorOnCourse(env(db), undefined as never, COURSE_A1));

    // Negative: a CourseScope must come from forCourse() — it cannot be
    // fabricated by handlers. The brand symbol is `unique`, so a plain
    // object literal cannot satisfy CourseScope.
    // @ts-expect-error — CourseScope brand cannot be forged by callers.
    const _bogus: CourseScope = {
      courseId: COURSE_A1,
      universityId: UNI_A,
      actor: FACULTY_ASSIGNED_A1,
      assignmentRole: "faculty",
      queryAll: async () => [],
      queryFirst: async () => null,
      execute: async () => ({ changes: 0, lastRowId: null }),
    };
    void _bogus;
  });
});
