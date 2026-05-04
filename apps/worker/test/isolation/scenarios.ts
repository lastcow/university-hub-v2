// Route × actor scenarios (UNI-23).
//
// One entry per protected route in `apps/worker/src/routes/`. Each scenario
// declares which actors (from the seed catalog) MUST succeed; every other
// actor is treated as a "wrong actor" and must come back denied (HTTP 403,
// 404, or — for list endpoints that scope server-side — a 200 with no rows).
//
// The cross-actor test (`cross-actor.test.ts`) iterates the cartesian product
// of `SCENARIOS × ALL_ACTORS` and asserts the right outcome for each pair, so
// adding a new protected route here automatically generates 23 test cases
// (one per actor) at zero additional boilerplate.

import {
  handleCreateAssessment,
  handleListAssessments,
} from "../../src/routes/assessments.js";
import { handleListAuditLogs } from "../../src/routes/audit-logs.js";
import { handleListGradeAccessLog } from "../../src/routes/grade-access-log.js";
import {
  handleListCourseGrades,
  handleListStudentGrades,
} from "../../src/routes/grades.js";
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
import { handleDashboardSummary } from "../../src/routes/dashboard.js";
import {
  handleCreateDepartment,
  handleDeleteDepartment,
  handleGetDepartment,
  handleListDepartments,
  handleUpdateDepartment,
} from "../../src/routes/departments.js";
import { handleListEmailLogs } from "../../src/routes/email-logs.js";
import {
  handleGetFaculty,
  handleGetMyFaculty,
  handleListFaculty,
} from "../../src/routes/faculty.js";
import {
  handleCreateInvitation,
  handleGetInvitation,
  handleListInvitations,
  handleResendInvitation,
  handleRevokeInvitation,
} from "../../src/routes/invitations.js";
import {
  handleGetMailgunStatus,
  handleGetSystemStatus,
  handleUpdateAccountSettings,
  handleUpdateUniversitySettings,
} from "../../src/routes/settings.js";
import {
  handleGetMyStudent,
  handleGetStudent,
  handleListMyStudentCourses,
  handleListStudents,
} from "../../src/routes/students.js";
import {
  handleGetMyTeacherAssistant,
  handleGetTeacherAssistant,
  handleListMyTeacherAssistantCourses,
  handleListTeacherAssistantCourses,
  handleListTeacherAssistants,
} from "../../src/routes/teacher-assistants.js";
import {
  handleGetMyTeacher,
  handleGetTeacher,
  handleListMyTeacherCourses,
  handleListMyTeacherStudents,
  handleListTeacherCourses,
  handleListTeacherStudents,
  handleListTeachers,
} from "../../src/routes/teachers.js";
import {
  handleCreateUniversity,
  handleGetUniversity,
  handleListUniversities,
  handleUpdateUniversity,
} from "../../src/routes/universities.js";
import {
  handleGetUser,
  handleListUsers,
  handleUpdateUser,
  handleUpdateUserRole,
  handleUpdateUserStatus,
} from "../../src/routes/users.js";
import type { ProgrammableD1 } from "../helpers/programmable-d1.js";

import type { ActorCatalog, ActorKey } from "./seed.js";
import {
  COURSE_A_A1,
  COURSE_A_B1,
  DEPT_A,
  INVITATION_A,
  PROFILE_FAC_A_A,
  PROFILE_STUD_A1,
  USER_STUDENT_A1,
  PROFILE_TA_A_A,
  PROFILE_TCH_A_A,
  UNI_A,
  USER_FACULTY_B_A,
  USER_GUEST_A,
  USER_STAFF_A,
  makeCtx,
} from "./seed.js";

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

export type Outcome = "success" | "denied" | "empty";

export interface Scenario {
  /** Human label — shows up in test names. */
  id: string;
  /** Invokes the route handler with the right ctx. */
  invoke: (
    actor: ActorCatalog[ActorKey],
    db: ProgrammableD1,
  ) => Promise<Response>;
  /**
   * Actors expected to succeed. Every other actor is expected to be denied
   * (403 / 404), or — when `emptyForOthers` is true — to receive 200 with an
   * empty `data` array (the canonical pattern for list endpoints that scope
   * server-side rather than 403'ing).
   */
  successActors: ActorKey[];
  /**
   * If true, "wrong actor" outcomes can be either denied OR a 200 with no
   * rows. Use this for list endpoints whose university scoping yields an
   * empty list rather than a forbidden status.
   */
  emptyForOthers?: boolean;
  /**
   * If true, "wrong actor" outcomes must specifically be HTTP 403 (not 404,
   * not empty). Use sparingly — most surfaces prefer 404 for probe-resistance.
   */
  strictForbidden?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get(pathname: string, query?: Record<string, string>) {
  return { method: "GET", pathname, query };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  // -------------------------------------------------------------------------
  // dashboard / settings — auth-required surfaces with no per-tenant scope.
  // Listed so any "we accidentally let unauth through" regression surfaces in
  // the same suite, but successActors include every actor since they only
  // require authentication.
  // -------------------------------------------------------------------------
  {
    id: "GET /api/dashboard/summary",
    invoke: (actor, db) => handleDashboardSummary(makeCtx(actor, db, get("/api/dashboard/summary"))),
    successActors: allActorKeys(),
  },
  {
    id: "GET /api/settings/system-status",
    invoke: async (actor, db) =>
      Promise.resolve(handleGetSystemStatus(makeCtx(actor, db, get("/api/settings/system-status")))),
    successActors: allActorKeys(),
  },
  {
    id: "GET /api/settings/mailgun-status",
    invoke: async (actor, db) =>
      Promise.resolve(handleGetMailgunStatus(makeCtx(actor, db, get("/api/settings/mailgun-status")))),
    successActors: allActorKeys(),
  },
  // PATCH /api/settings/account is "edit your own account" — every signed-in
  // actor is allowed to edit their own row, the route does no scoping.
  {
    id: "PATCH /api/settings/account",
    invoke: (actor, db) =>
      handleUpdateAccountSettings(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: "/api/settings/account",
          body: { name: actor.name },
        }),
      ),
    successActors: allActorKeys(),
  },
  // PATCH /api/settings/university — only super_admin or that uni's admin can
  // edit UNI_A's settings.
  {
    id: "PATCH /api/settings/university (UNI_A)",
    invoke: (actor, db) =>
      handleUpdateUniversitySettings(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: "/api/settings/university",
          query: { university_id: UNI_A },
          body: { name: "Uni A renamed" },
        }),
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },

  // -------------------------------------------------------------------------
  // audit-logs / email-logs — admin only.
  // -------------------------------------------------------------------------
  {
    id: "GET /api/audit-logs",
    invoke: (actor, db) => handleListAuditLogs(makeCtx(actor, db, get("/api/audit-logs"))),
    successActors: ["superAdmin", "uniAAdmin", "uniBAdmin"],
  },
  {
    id: "GET /api/email-logs",
    invoke: (actor, db) => handleListEmailLogs(makeCtx(actor, db, get("/api/email-logs"))),
    successActors: ["superAdmin", "uniAAdmin", "uniBAdmin"],
  },

  // -------------------------------------------------------------------------
  // invitations
  // -------------------------------------------------------------------------
  {
    id: "GET /api/invitations",
    invoke: (actor, db) => handleListInvitations(makeCtx(actor, db, get("/api/invitations"))),
    successActors: ["superAdmin", "uniAAdmin", "uniBAdmin"],
  },
  {
    id: "POST /api/invitations (UNI_A)",
    invoke: (actor, db) =>
      handleCreateInvitation(
        makeCtx(actor, db, {
          method: "POST",
          pathname: "/api/invitations",
          body: {
            email: `freshly-invited-${actor.id.slice(0, 8)}@example.com`,
            role: "staff",
            university_id: UNI_A,
          },
        }),
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "GET /api/invitations/:id (invitation in UNI_A)",
    invoke: (actor, db) =>
      handleGetInvitation(
        makeCtx(actor, db, get(`/api/invitations/${INVITATION_A}`)),
        INVITATION_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "POST /api/invitations/:id/revoke (UNI_A)",
    invoke: (actor, db) =>
      handleRevokeInvitation(
        makeCtx(actor, db, {
          method: "POST",
          pathname: `/api/invitations/${INVITATION_A}/revoke`,
        }),
        INVITATION_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "POST /api/invitations/:id/resend (UNI_A)",
    invoke: (actor, db) =>
      handleResendInvitation(
        makeCtx(actor, db, {
          method: "POST",
          pathname: `/api/invitations/${INVITATION_A}/resend`,
        }),
        INVITATION_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },

  // -------------------------------------------------------------------------
  // universities
  // -------------------------------------------------------------------------
  {
    id: "GET /api/universities",
    invoke: (actor, db) => handleListUniversities(makeCtx(actor, db, get("/api/universities"))),
    // Every signed-in actor with a uni gets at least their own back; the
    // unaffiliated case (no actor here is unaffiliated) would return [].
    // Cross-uni denial is verified by the GET-by-id scenario below.
    successActors: allActorKeys(),
  },
  {
    id: "POST /api/universities",
    invoke: (actor, db) =>
      handleCreateUniversity(
        makeCtx(actor, db, {
          method: "POST",
          pathname: "/api/universities",
          body: { name: "Brand New U", slug: `brand-new-${actor.id.slice(0, 6)}` },
        }),
      ),
    successActors: ["superAdmin"],
    strictForbidden: true,
  },
  {
    id: "GET /api/universities/:id (UNI_A)",
    invoke: (actor, db) =>
      handleGetUniversity(makeCtx(actor, db, get(`/api/universities/${UNI_A}`)), UNI_A),
    // Anyone in UNI_A can read UNI_A; others get 404. Note: super_admin
    // sees everything, uniAAdmin/staffA/all UNI_A roles see UNI_A. UNI_B
    // members get 404.
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
      "student1_inA",
      "student2_inA",
      "guestA",
    ],
  },
  {
    id: "PATCH /api/universities/:id (UNI_A)",
    invoke: (actor, db) =>
      handleUpdateUniversity(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: `/api/universities/${UNI_A}`,
          body: { name: "Uni A renamed" },
        }),
        UNI_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },

  // -------------------------------------------------------------------------
  // users — admin only; cross-uni admin must not reach UNI_A's users.
  // -------------------------------------------------------------------------
  {
    id: "GET /api/users",
    invoke: (actor, db) => handleListUsers(makeCtx(actor, db, get("/api/users"))),
    successActors: ["superAdmin", "uniAAdmin", "uniBAdmin"],
  },
  {
    id: "GET /api/users/:id (staffA in UNI_A)",
    invoke: (actor, db) =>
      handleGetUser(makeCtx(actor, db, get(`/api/users/${USER_STAFF_A}`)), USER_STAFF_A),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "PATCH /api/users/:id (staffA in UNI_A)",
    invoke: (actor, db) =>
      handleUpdateUser(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: `/api/users/${USER_STAFF_A}`,
          body: { name: "Renamed" },
        }),
        USER_STAFF_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "PATCH /api/users/:id/role (guestA → viewer)",
    invoke: (actor, db) =>
      handleUpdateUserRole(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: `/api/users/${USER_GUEST_A}/role`,
          body: { role: "viewer" },
        }),
        USER_GUEST_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "PATCH /api/users/:id/status (guestA → inactive)",
    invoke: (actor, db) =>
      handleUpdateUserStatus(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: `/api/users/${USER_GUEST_A}/status`,
          body: { status: "inactive" },
        }),
        USER_GUEST_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },

  // -------------------------------------------------------------------------
  // departments
  // -------------------------------------------------------------------------
  {
    id: "GET /api/departments",
    invoke: (actor, db) => handleListDepartments(makeCtx(actor, db, get("/api/departments"))),
    // List is open to any signed-in user; UNI scoping handled by handler.
    successActors: allActorKeys(),
  },
  {
    id: "POST /api/departments (UNI_A)",
    invoke: (actor, db) =>
      handleCreateDepartment(
        makeCtx(actor, db, {
          method: "POST",
          pathname: "/api/departments",
          body: {
            name: `New Dept ${actor.id.slice(0, 6)}`,
            university_id: UNI_A,
            code: `NEW-${actor.id.slice(0, 6)}`,
          },
        }),
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "GET /api/departments/:id (DEPT_A)",
    invoke: (actor, db) =>
      handleGetDepartment(makeCtx(actor, db, get(`/api/departments/${DEPT_A}`)), DEPT_A),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
      "student1_inA",
      "student2_inA",
      "guestA",
    ],
  },
  {
    id: "PATCH /api/departments/:id (DEPT_A)",
    invoke: (actor, db) =>
      handleUpdateDepartment(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: `/api/departments/${DEPT_A}`,
          body: { name: "Renamed Dept" },
        }),
        DEPT_A,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  // Note: DELETE /api/departments/:id requires the dept to have no
  // referencing courses. DEPT_A has 4 courses → 409. We don't try the
  // wrong-actor path on this one because the success path requires fixture
  // mutation; the same auth code is exercised via the PATCH scenario above.

  // -------------------------------------------------------------------------
  // courses
  // -------------------------------------------------------------------------
  {
    id: "GET /api/courses",
    invoke: (actor, db) => handleListCourses(makeCtx(actor, db, get("/api/courses"))),
    successActors: allActorKeys(),
  },
  {
    id: "POST /api/courses (UNI_A)",
    invoke: (actor, db) =>
      handleCreateCourse(
        makeCtx(actor, db, {
          method: "POST",
          pathname: "/api/courses",
          body: {
            name: `New Course ${actor.id.slice(0, 6)}`,
            university_id: UNI_A,
          },
        }),
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "GET /api/courses/:id (COURSE_A_A1, faculty A on it)",
    invoke: (actor, db) =>
      handleGetCourse(makeCtx(actor, db, get(`/api/courses/${COURSE_A_A1}`)), COURSE_A_A1),
    // For UNI_A: super_admin + uniAAdmin bypass; staff/student/guest fall
    // through canRead (every UNI_A user). Faculty/Teacher/TA require an
    // assignment — facultyA_inA / teacherA_inA / taA_inA pass; the *_B_inA
    // variants don't (assigned to B-courses). All UNI_B actors get 404.
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "teacherA_inA",
      "taA_inA",
      "student1_inA",
      "student2_inA",
      "guestA",
    ],
  },
  {
    id: "GET /api/courses/:id (COURSE_A_B1, faculty B on it)",
    invoke: (actor, db) =>
      handleGetCourse(makeCtx(actor, db, get(`/api/courses/${COURSE_A_B1}`)), COURSE_A_B1),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyB_inA",
      "teacherB_inA",
      "taB_inA",
      "student1_inA",
      "student2_inA",
      "guestA",
    ],
  },
  {
    id: "PATCH /api/courses/:id (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleUpdateCourse(
        makeCtx(actor, db, {
          method: "PATCH",
          pathname: `/api/courses/${COURSE_A_A1}`,
          body: { name: "Renamed Course" },
        }),
        COURSE_A_A1,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "DELETE /api/courses/:id (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleDeleteCourse(
        makeCtx(actor, db, {
          method: "DELETE",
          pathname: `/api/courses/${COURSE_A_A1}`,
        }),
        COURSE_A_A1,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  {
    id: "GET /api/courses/:id/assignments (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleListCourseAssignments(
        makeCtx(actor, db, get(`/api/courses/${COURSE_A_A1}/assignments`)),
        COURSE_A_A1,
      ),
    // Same canRead pattern as GET course: every UNI_A actor passes load,
    // UNI_B is 404. (Course-scope is NOT enforced on the assignments list —
    // it's a directory affordance, not grades.)
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
      "student1_inA",
      "student2_inA",
      "guestA",
    ],
  },
  {
    id: "POST /api/courses/:id/assignments (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleCreateCourseAssignment(
        makeCtx(actor, db, {
          method: "POST",
          pathname: `/api/courses/${COURSE_A_A1}/assignments`,
          body: { user_id: USER_FACULTY_B_A, role: "viewer" },
        }),
        COURSE_A_A1,
      ),
    successActors: ["superAdmin", "uniAAdmin"],
  },
  // DELETE assignment is exercised at unit-test level in courses.test.ts;
  // covering it here would require mutating the fixture per actor and
  // leaving the seed clean again, which would just hide regressions in the
  // other scenarios. The auth code path is the same as POST above.

  // -------------------------------------------------------------------------
  // assessments + grades + FERPA grade-access-log (UNI-30)
  //
  // Reads are scoped through the same per-course helper UNI-22 introduced;
  // the fixture has zero seeded assessments / grades, so every read returns
  // an empty list when the actor is allowed and 404 / 403 when not. POST and
  // PATCH paths are exercised at unit-test level in routes/grades.test.ts —
  // they need fixture mutation that doesn't fit the matrix's "every actor on
  // a fresh seed" model.
  // -------------------------------------------------------------------------
  {
    id: "GET /api/courses/:id/assessments (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleListAssessments(
        makeCtx(actor, db, get(`/api/courses/${COURSE_A_A1}/assessments`)),
        COURSE_A_A1,
      ),
    // Faculty/teacher/TA assigned to A1 + students enrolled in A1 + admins
    // and same-uni staff. Faculty B / Teacher B / TA B (assigned to UNI_A's
    // B-courses, not A1) get 404 via the scoping helper.
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "teacherA_inA",
      "taA_inA",
      "student1_inA",
    ],
  },
  {
    id: "POST /api/courses/:id/assessments (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleCreateAssessment(
        makeCtx(actor, db, {
          method: "POST",
          pathname: `/api/courses/${COURSE_A_A1}/assessments`,
          body: { title: "Matrix exam", weight: 0.2, max_score: 100 },
        }),
        COURSE_A_A1,
      ),
    // Faculty assigned to course + admins. Teacher / TA / student / staff
    // / cross-course faculty all denied (scoping helper restricts to faculty
    // role, admins bypass).
    successActors: ["superAdmin", "uniAAdmin", "facultyA_inA"],
  },
  {
    id: "GET /api/courses/:id/grades (COURSE_A_A1)",
    invoke: (actor, db) =>
      handleListCourseGrades(
        makeCtx(actor, db, get(`/api/courses/${COURSE_A_A1}/grades`)),
        COURSE_A_A1,
      ),
    // Course gradebook: faculty/teacher/TA on the course + admins. Students
    // (even enrolled) see this page through their own self view, not the
    // gradebook. Staff doesn't pass either (admin or course-assigned only).
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "facultyA_inA",
      "teacherA_inA",
      "taA_inA",
    ],
  },
  {
    id: "GET /api/students/:id/grades (student1_inA = USER_STUDENT_A1)",
    invoke: (actor, db) =>
      handleListStudentGrades(
        makeCtx(actor, db, get(`/api/students/${USER_STUDENT_A1}/grades`)),
        USER_STUDENT_A1,
      ),
    // student1_inA self; super_admin + same-uni admin; faculty/teacher/TA
    // assigned to A1 (where student1_inA is enrolled). Faculty/teacher/TA
    // assigned to other UNI_A courses (B1/B2) are denied because they
    // aren't on any course this student is enrolled in. Other students,
    // staff, guests, viewers, cross-uni actors → 404.
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "student1_inA",
      "facultyA_inA",
      "teacherA_inA",
      "taA_inA",
    ],
  },
  {
    id: "GET /api/grade-access-log",
    invoke: (actor, db) =>
      handleListGradeAccessLog(makeCtx(actor, db, get("/api/grade-access-log"))),
    // FERPA admin record-of-disclosure surface — admins only. Even faculty,
    // who can read individual students' grades, cannot see the aggregated
    // disclosure log.
    successActors: ["superAdmin", "uniAAdmin", "uniBAdmin"],
  },

  // -------------------------------------------------------------------------
  // students directory
  // -------------------------------------------------------------------------
  {
    id: "GET /api/students",
    invoke: (actor, db) => handleListStudents(makeCtx(actor, db, get("/api/students"))),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "uniBAdmin",
      "staffA",
      "staffB",
      "facultyA_inA",
      "facultyB_inA",
      "facultyA_inB",
      "facultyB_inB",
      "teacherA_inA",
      "teacherB_inA",
      "teacherA_inB",
      "teacherB_inB",
      "taA_inA",
      "taB_inA",
      "taA_inB",
      "taB_inB",
    ],
  },
  {
    id: "GET /api/students/me (only students get their profile)",
    invoke: (actor, db) => handleGetMyStudent(makeCtx(actor, db, get("/api/students/me"))),
    // /me returns 200 only if the actor has a row in `students`. Students
    // do; everyone else returns 404 — that counts as "denied" for this
    // route's isolation property.
    successActors: ["student1_inA", "student2_inA", "student1_inB", "student2_inB"],
  },
  {
    id: "GET /api/students/me/courses",
    invoke: (actor, db) =>
      handleListMyStudentCourses(makeCtx(actor, db, get("/api/students/me/courses"))),
    // Auth-only: returns the (possibly empty) list of courses the actor is
    // enrolled in as `student`. Only seeded students will see anything; the
    // test treats non-student successes as `empty`.
    successActors: ["student1_inA", "student2_inA", "student1_inB", "student2_inB"],
    emptyForOthers: true,
  },
  {
    id: "GET /api/students/:id (PROFILE_STUD_A1, owner = student1_inA)",
    invoke: (actor, db) =>
      handleGetStudent(makeCtx(actor, db, get(`/api/students/${PROFILE_STUD_A1}`)), PROFILE_STUD_A1),
    // Owner passes; everyone in UNI_A who can view directory passes.
    // UNI_B members and same-uni non-directory roles (guestA, student2_inA)
    // get 404.
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
      "student1_inA",
    ],
  },

  // -------------------------------------------------------------------------
  // faculty directory
  // -------------------------------------------------------------------------
  {
    id: "GET /api/faculty",
    invoke: (actor, db) => handleListFaculty(makeCtx(actor, db, get("/api/faculty"))),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "uniBAdmin",
      "staffA",
      "staffB",
      "facultyA_inA",
      "facultyB_inA",
      "facultyA_inB",
      "facultyB_inB",
      "teacherA_inA",
      "teacherB_inA",
      "teacherA_inB",
      "teacherB_inB",
      "taA_inA",
      "taB_inA",
      "taA_inB",
      "taB_inB",
    ],
  },
  {
    id: "GET /api/faculty/me",
    invoke: (actor, db) => handleGetMyFaculty(makeCtx(actor, db, get("/api/faculty/me"))),
    successActors: ["facultyA_inA", "facultyB_inA", "facultyA_inB", "facultyB_inB"],
  },
  {
    id: "GET /api/faculty/:id (PROFILE_FAC_A_A)",
    invoke: (actor, db) =>
      handleGetFaculty(makeCtx(actor, db, get(`/api/faculty/${PROFILE_FAC_A_A}`)), PROFILE_FAC_A_A),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
    ],
  },

  // -------------------------------------------------------------------------
  // teachers directory
  // -------------------------------------------------------------------------
  {
    id: "GET /api/teachers",
    invoke: (actor, db) => handleListTeachers(makeCtx(actor, db, get("/api/teachers"))),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "uniBAdmin",
      "staffA",
      "staffB",
      "facultyA_inA",
      "facultyB_inA",
      "facultyA_inB",
      "facultyB_inB",
      "teacherA_inA",
      "teacherB_inA",
      "teacherA_inB",
      "teacherB_inB",
      "taA_inA",
      "taB_inA",
      "taA_inB",
      "taB_inB",
    ],
  },
  {
    id: "GET /api/teachers/me",
    invoke: (actor, db) => handleGetMyTeacher(makeCtx(actor, db, get("/api/teachers/me"))),
    successActors: ["teacherA_inA", "teacherB_inA", "teacherA_inB", "teacherB_inB"],
  },
  {
    id: "GET /api/teachers/me/courses",
    invoke: (actor, db) =>
      handleListMyTeacherCourses(makeCtx(actor, db, get("/api/teachers/me/courses"))),
    successActors: ["teacherA_inA", "teacherB_inA", "teacherA_inB", "teacherB_inB"],
    emptyForOthers: true,
  },
  {
    id: "GET /api/teachers/me/students",
    invoke: (actor, db) =>
      handleListMyTeacherStudents(makeCtx(actor, db, get("/api/teachers/me/students"))),
    successActors: ["teacherA_inA", "teacherB_inA", "teacherA_inB", "teacherB_inB"],
    emptyForOthers: true,
  },
  {
    id: "GET /api/teachers/:id (PROFILE_TCH_A_A)",
    invoke: (actor, db) =>
      handleGetTeacher(makeCtx(actor, db, get(`/api/teachers/${PROFILE_TCH_A_A}`)), PROFILE_TCH_A_A),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
    ],
  },
  {
    id: "GET /api/teachers/:id/courses (PROFILE_TCH_A_A)",
    invoke: (actor, db) =>
      handleListTeacherCourses(
        makeCtx(actor, db, get(`/api/teachers/${PROFILE_TCH_A_A}/courses`)),
        PROFILE_TCH_A_A,
      ),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
    ],
  },
  {
    id: "GET /api/teachers/:id/students (PROFILE_TCH_A_A)",
    invoke: (actor, db) =>
      handleListTeacherStudents(
        makeCtx(actor, db, get(`/api/teachers/${PROFILE_TCH_A_A}/students`)),
        PROFILE_TCH_A_A,
      ),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
    ],
  },

  // -------------------------------------------------------------------------
  // teacher_assistants directory
  // -------------------------------------------------------------------------
  {
    id: "GET /api/teacher-assistants",
    invoke: (actor, db) =>
      handleListTeacherAssistants(makeCtx(actor, db, get("/api/teacher-assistants"))),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "uniBAdmin",
      "staffA",
      "staffB",
      "facultyA_inA",
      "facultyB_inA",
      "facultyA_inB",
      "facultyB_inB",
      "teacherA_inA",
      "teacherB_inA",
      "teacherA_inB",
      "teacherB_inB",
      "taA_inA",
      "taB_inA",
      "taA_inB",
      "taB_inB",
    ],
  },
  {
    id: "GET /api/teacher-assistants/me",
    invoke: (actor, db) =>
      handleGetMyTeacherAssistant(makeCtx(actor, db, get("/api/teacher-assistants/me"))),
    successActors: ["taA_inA", "taB_inA", "taA_inB", "taB_inB"],
  },
  {
    id: "GET /api/teacher-assistants/me/courses",
    invoke: (actor, db) =>
      handleListMyTeacherAssistantCourses(
        makeCtx(actor, db, get("/api/teacher-assistants/me/courses")),
      ),
    successActors: ["taA_inA", "taB_inA", "taA_inB", "taB_inB"],
    emptyForOthers: true,
  },
  {
    id: "GET /api/teacher-assistants/:id (PROFILE_TA_A_A)",
    invoke: (actor, db) =>
      handleGetTeacherAssistant(
        makeCtx(actor, db, get(`/api/teacher-assistants/${PROFILE_TA_A_A}`)),
        PROFILE_TA_A_A,
      ),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
    ],
  },
  {
    id: "GET /api/teacher-assistants/:id/courses (PROFILE_TA_A_A)",
    invoke: (actor, db) =>
      handleListTeacherAssistantCourses(
        makeCtx(actor, db, get(`/api/teacher-assistants/${PROFILE_TA_A_A}/courses`)),
        PROFILE_TA_A_A,
      ),
    successActors: [
      "superAdmin",
      "uniAAdmin",
      "staffA",
      "facultyA_inA",
      "facultyB_inA",
      "teacherA_inA",
      "teacherB_inA",
      "taA_inA",
      "taB_inA",
    ],
  },
];

export const ALL_ACTOR_KEYS: ActorKey[] = allActorKeys();

function allActorKeys(): ActorKey[] {
  return [
    "superAdmin",
    "uniAAdmin",
    "uniBAdmin",
    "staffA",
    "staffB",
    "facultyA_inA",
    "facultyB_inA",
    "facultyA_inB",
    "facultyB_inB",
    "teacherA_inA",
    "teacherB_inA",
    "teacherA_inB",
    "teacherB_inB",
    "taA_inA",
    "taB_inA",
    "taA_inB",
    "taB_inB",
    "student1_inA",
    "student2_inA",
    "student1_inB",
    "student2_inB",
    "guestA",
    "guestB",
  ];
}

