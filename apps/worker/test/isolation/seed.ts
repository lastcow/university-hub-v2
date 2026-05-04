// Isolation test seed (UNI-23).
//
// One fixture used by every cross-actor test in this directory. Two
// universities, with the full role spread per university and with the
// per-course assignment matrix the issue spells out:
//
//   Faculty A is assigned to courses A1 + A2 (in that university)
//   Faculty B is assigned to courses B1 + B2 (in that university)
//   Same pattern for teachers + teacher_assistants
//
// One seed feeds every test so a route that adds a SELECT we haven't modeled
// yet is the kind of failure we want — it surfaces here, not as a flaky 404
// from the route under test.

import type { Role, UserStatus } from "@university-hub/shared";

import type { UserRow } from "../../src/auth/session.js";
import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

// ---------------------------------------------------------------------------
// Deterministic IDs — every fixture has a fixed UUID so failure messages
// point at a stable id you can grep for.
// ---------------------------------------------------------------------------

export const UNI_A = "11111111-1111-1111-1111-111111111111";
export const UNI_B = "22222222-2222-2222-2222-222222222222";

export const DEPT_A = "33333333-1111-1111-1111-111111111111";
export const DEPT_B = "33333333-2222-2222-2222-222222222222";

// 4 courses per university — A1+A2 are "Faculty A's" courses, B1+B2 are
// "Faculty B's" courses. The cross-course-of-correct-role tests work by
// pointing a Faculty A actor at a B1/B2 course (same uni, wrong assignment).
export const COURSE_A_A1 = "44444444-aaaa-aaaa-aaaa-00000000a1a1";
export const COURSE_A_A2 = "44444444-aaaa-aaaa-aaaa-00000000a2a2";
export const COURSE_A_B1 = "44444444-aaaa-aaaa-aaaa-00000000b1b1";
export const COURSE_A_B2 = "44444444-aaaa-aaaa-aaaa-00000000b2b2";
export const COURSE_B_A1 = "44444444-bbbb-bbbb-bbbb-00000000a1a1";
export const COURSE_B_A2 = "44444444-bbbb-bbbb-bbbb-00000000a2a2";
export const COURSE_B_B1 = "44444444-bbbb-bbbb-bbbb-00000000b1b1";
export const COURSE_B_B2 = "44444444-bbbb-bbbb-bbbb-00000000b2b2";

// User ids — `_a` suffix means in UNI_A, `_b` means in UNI_B. For roles where
// we seed two members per uni the second is suffixed `2`.
export const USER_SUPER_ADMIN = "55555555-0000-0000-0000-000000000001";

export const USER_UNI_A_ADMIN = "55555555-aaaa-0000-0000-000000000001";
export const USER_UNI_B_ADMIN = "55555555-bbbb-0000-0000-000000000001";

export const USER_STAFF_A = "55555555-aaaa-1111-0000-000000000001";
export const USER_STAFF_B = "55555555-bbbb-1111-0000-000000000001";

export const USER_FACULTY_A_A = "55555555-aaaa-2222-0000-000000000001";
export const USER_FACULTY_B_A = "55555555-aaaa-2222-0000-000000000002";
export const USER_FACULTY_A_B = "55555555-bbbb-2222-0000-000000000001";
export const USER_FACULTY_B_B = "55555555-bbbb-2222-0000-000000000002";

export const USER_TEACHER_A_A = "55555555-aaaa-3333-0000-000000000001";
export const USER_TEACHER_B_A = "55555555-aaaa-3333-0000-000000000002";
export const USER_TEACHER_A_B = "55555555-bbbb-3333-0000-000000000001";
export const USER_TEACHER_B_B = "55555555-bbbb-3333-0000-000000000002";

export const USER_TA_A_A = "55555555-aaaa-4444-0000-000000000001";
export const USER_TA_B_A = "55555555-aaaa-4444-0000-000000000002";
export const USER_TA_A_B = "55555555-bbbb-4444-0000-000000000001";
export const USER_TA_B_B = "55555555-bbbb-4444-0000-000000000002";

export const USER_STUDENT_A1 = "55555555-aaaa-5555-0000-000000000001";
export const USER_STUDENT_A2 = "55555555-aaaa-5555-0000-000000000002";
export const USER_STUDENT_B1 = "55555555-bbbb-5555-0000-000000000001";
export const USER_STUDENT_B2 = "55555555-bbbb-5555-0000-000000000002";

export const USER_GUEST_A = "55555555-aaaa-6666-0000-000000000001";
export const USER_GUEST_B = "55555555-bbbb-6666-0000-000000000001";

// Profile-row ids (faculty/teachers/teacher_assistants/students tables).
export const PROFILE_FAC_A_A = "66666666-aaaa-2222-0000-000000000001";
export const PROFILE_FAC_B_A = "66666666-aaaa-2222-0000-000000000002";
export const PROFILE_FAC_A_B = "66666666-bbbb-2222-0000-000000000001";
export const PROFILE_FAC_B_B = "66666666-bbbb-2222-0000-000000000002";
export const PROFILE_TCH_A_A = "66666666-aaaa-3333-0000-000000000001";
export const PROFILE_TCH_B_A = "66666666-aaaa-3333-0000-000000000002";
export const PROFILE_TCH_A_B = "66666666-bbbb-3333-0000-000000000001";
export const PROFILE_TCH_B_B = "66666666-bbbb-3333-0000-000000000002";
export const PROFILE_TA_A_A = "66666666-aaaa-4444-0000-000000000001";
export const PROFILE_TA_B_A = "66666666-aaaa-4444-0000-000000000002";
export const PROFILE_TA_A_B = "66666666-bbbb-4444-0000-000000000001";
export const PROFILE_TA_B_B = "66666666-bbbb-4444-0000-000000000002";
export const PROFILE_STUD_A1 = "66666666-aaaa-5555-0000-000000000001";
export const PROFILE_STUD_A2 = "66666666-aaaa-5555-0000-000000000002";
export const PROFILE_STUD_B1 = "66666666-bbbb-5555-0000-000000000001";
export const PROFILE_STUD_B2 = "66666666-bbbb-5555-0000-000000000002";

// Pending-invitation ids — one per uni, used by the invitation-route tests.
export const INVITATION_A = "77777777-aaaa-0000-0000-000000000001";
export const INVITATION_B = "77777777-bbbb-0000-0000-000000000001";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

const TS = "2026-05-04T00:00:00.000Z";

interface UniversityRow {
  id: string;
  name: string;
  slug: string | null;
  status: "active" | "inactive" | "archived";
  created_at: string;
  updated_at: string;
}

interface DepartmentRow {
  id: string;
  university_id: string;
  name: string;
  code: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface CourseRow {
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

interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: Role;
  status: UserStatus;
  university_id: string | null;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssignmentRow {
  id: string;
  course_id: string;
  user_id: string;
  role: "faculty" | "teacher" | "teacher_assistant" | "student" | "viewer";
  created_at: string;
  updated_at: string;
}

interface ProfileRow {
  id: string;
  user_id: string;
  university_id: string;
  department_id: string | null;
  title: string | null;
  student_number: string | null;
  created_at: string;
  updated_at: string;
}

interface InvitationRow {
  id: string;
  email: string;
  role: Role;
  status: "pending" | "accepted" | "expired" | "revoked";
  token_hash: string;
  university_id: string | null;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

interface SeedResult {
  store: IsolationStore;
  db: ProgrammableD1;
  /** Convenience map of every actor → its UserRow. */
  actors: ActorCatalog;
}

export interface ActorCatalog {
  superAdmin: UserRecord;
  uniAAdmin: UserRecord;
  uniBAdmin: UserRecord;
  staffA: UserRecord;
  staffB: UserRecord;
  facultyA_inA: UserRecord; // assigned to A1+A2 in UNI_A
  facultyB_inA: UserRecord; // assigned to B1+B2 in UNI_A
  facultyA_inB: UserRecord; // assigned to A1+A2 in UNI_B
  facultyB_inB: UserRecord;
  teacherA_inA: UserRecord;
  teacherB_inA: UserRecord;
  teacherA_inB: UserRecord;
  teacherB_inB: UserRecord;
  taA_inA: UserRecord;
  taB_inA: UserRecord;
  taA_inB: UserRecord;
  taB_inB: UserRecord;
  student1_inA: UserRecord;
  student2_inA: UserRecord;
  student1_inB: UserRecord;
  student2_inB: UserRecord;
  guestA: UserRecord;
  guestB: UserRecord;
}

export type ActorKey = keyof ActorCatalog;

export function seed(): SeedResult {
  const store = new IsolationStore();

  // Universities.
  store.universities.set(UNI_A, {
    id: UNI_A,
    name: "Uni A",
    slug: "uni-a",
    status: "active",
    created_at: TS,
    updated_at: TS,
  });
  store.universities.set(UNI_B, {
    id: UNI_B,
    name: "Uni B",
    slug: "uni-b",
    status: "active",
    created_at: TS,
    updated_at: TS,
  });

  // Departments — one per uni.
  store.departments.set(DEPT_A, {
    id: DEPT_A,
    university_id: UNI_A,
    name: "Dept A",
    code: "DA",
    description: null,
    created_at: TS,
    updated_at: TS,
  });
  store.departments.set(DEPT_B, {
    id: DEPT_B,
    university_id: UNI_B,
    name: "Dept B",
    code: "DB",
    description: null,
    created_at: TS,
    updated_at: TS,
  });

  // Courses — 4 per uni, named A1/A2/B1/B2.
  for (const [id, universityId, code] of [
    [COURSE_A_A1, UNI_A, "A-A1"],
    [COURSE_A_A2, UNI_A, "A-A2"],
    [COURSE_A_B1, UNI_A, "A-B1"],
    [COURSE_A_B2, UNI_A, "A-B2"],
    [COURSE_B_A1, UNI_B, "B-A1"],
    [COURSE_B_A2, UNI_B, "B-A2"],
    [COURSE_B_B1, UNI_B, "B-B1"],
    [COURSE_B_B2, UNI_B, "B-B2"],
  ] as const) {
    const departmentId = universityId === UNI_A ? DEPT_A : DEPT_B;
    store.courses.set(id, {
      id,
      university_id: universityId,
      department_id: departmentId,
      name: `Course ${code}`,
      code,
      description: null,
      status: "active",
      created_at: TS,
      updated_at: TS,
    });
  }

  // Users — every role × every uni (where applicable).
  const mkUser = (
    id: string,
    name: string,
    role: Role,
    universityId: string | null,
  ): UserRecord => ({
    id,
    email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    password_hash: "x",
    name,
    role,
    status: "active",
    university_id: universityId,
    last_sign_in_at: null,
    created_at: TS,
    updated_at: TS,
  });

  const actors: ActorCatalog = {
    superAdmin: mkUser(USER_SUPER_ADMIN, "Super Admin", "super_admin", null),
    uniAAdmin: mkUser(USER_UNI_A_ADMIN, "UniA Admin", "university_admin", UNI_A),
    uniBAdmin: mkUser(USER_UNI_B_ADMIN, "UniB Admin", "university_admin", UNI_B),
    staffA: mkUser(USER_STAFF_A, "StaffA", "staff", UNI_A),
    staffB: mkUser(USER_STAFF_B, "StaffB", "staff", UNI_B),
    facultyA_inA: mkUser(USER_FACULTY_A_A, "FacultyA InA", "faculty", UNI_A),
    facultyB_inA: mkUser(USER_FACULTY_B_A, "FacultyB InA", "faculty", UNI_A),
    facultyA_inB: mkUser(USER_FACULTY_A_B, "FacultyA InB", "faculty", UNI_B),
    facultyB_inB: mkUser(USER_FACULTY_B_B, "FacultyB InB", "faculty", UNI_B),
    teacherA_inA: mkUser(USER_TEACHER_A_A, "TeacherA InA", "teacher", UNI_A),
    teacherB_inA: mkUser(USER_TEACHER_B_A, "TeacherB InA", "teacher", UNI_A),
    teacherA_inB: mkUser(USER_TEACHER_A_B, "TeacherA InB", "teacher", UNI_B),
    teacherB_inB: mkUser(USER_TEACHER_B_B, "TeacherB InB", "teacher", UNI_B),
    taA_inA: mkUser(USER_TA_A_A, "TAA InA", "teacher_assistant", UNI_A),
    taB_inA: mkUser(USER_TA_B_A, "TAB InA", "teacher_assistant", UNI_A),
    taA_inB: mkUser(USER_TA_A_B, "TAA InB", "teacher_assistant", UNI_B),
    taB_inB: mkUser(USER_TA_B_B, "TAB InB", "teacher_assistant", UNI_B),
    student1_inA: mkUser(USER_STUDENT_A1, "Student1 InA", "student", UNI_A),
    student2_inA: mkUser(USER_STUDENT_A2, "Student2 InA", "student", UNI_A),
    student1_inB: mkUser(USER_STUDENT_B1, "Student1 InB", "student", UNI_B),
    student2_inB: mkUser(USER_STUDENT_B2, "Student2 InB", "student", UNI_B),
    guestA: mkUser(USER_GUEST_A, "GuestA", "guest", UNI_A),
    guestB: mkUser(USER_GUEST_B, "GuestB", "guest", UNI_B),
  };
  for (const u of Object.values(actors)) store.users.set(u.id, u);

  // Profile rows — only for roles that have a directory.
  const mkProfile = (
    id: string,
    userId: string,
    universityId: string,
    extras: Partial<ProfileRow> = {},
  ): ProfileRow => ({
    id,
    user_id: userId,
    university_id: universityId,
    department_id: universityId === UNI_A ? DEPT_A : DEPT_B,
    title: null,
    student_number: null,
    created_at: TS,
    updated_at: TS,
    ...extras,
  });

  store.faculty.set(PROFILE_FAC_A_A, mkProfile(PROFILE_FAC_A_A, USER_FACULTY_A_A, UNI_A, { title: "Professor" }));
  store.faculty.set(PROFILE_FAC_B_A, mkProfile(PROFILE_FAC_B_A, USER_FACULTY_B_A, UNI_A, { title: "Professor" }));
  store.faculty.set(PROFILE_FAC_A_B, mkProfile(PROFILE_FAC_A_B, USER_FACULTY_A_B, UNI_B, { title: "Professor" }));
  store.faculty.set(PROFILE_FAC_B_B, mkProfile(PROFILE_FAC_B_B, USER_FACULTY_B_B, UNI_B, { title: "Professor" }));

  store.teachers.set(PROFILE_TCH_A_A, mkProfile(PROFILE_TCH_A_A, USER_TEACHER_A_A, UNI_A, { title: "Lecturer" }));
  store.teachers.set(PROFILE_TCH_B_A, mkProfile(PROFILE_TCH_B_A, USER_TEACHER_B_A, UNI_A, { title: "Lecturer" }));
  store.teachers.set(PROFILE_TCH_A_B, mkProfile(PROFILE_TCH_A_B, USER_TEACHER_A_B, UNI_B, { title: "Lecturer" }));
  store.teachers.set(PROFILE_TCH_B_B, mkProfile(PROFILE_TCH_B_B, USER_TEACHER_B_B, UNI_B, { title: "Lecturer" }));

  store.teacherAssistants.set(PROFILE_TA_A_A, mkProfile(PROFILE_TA_A_A, USER_TA_A_A, UNI_A));
  store.teacherAssistants.set(PROFILE_TA_B_A, mkProfile(PROFILE_TA_B_A, USER_TA_B_A, UNI_A));
  store.teacherAssistants.set(PROFILE_TA_A_B, mkProfile(PROFILE_TA_A_B, USER_TA_A_B, UNI_B));
  store.teacherAssistants.set(PROFILE_TA_B_B, mkProfile(PROFILE_TA_B_B, USER_TA_B_B, UNI_B));

  store.students.set(PROFILE_STUD_A1, mkProfile(PROFILE_STUD_A1, USER_STUDENT_A1, UNI_A, { student_number: "S-A1" }));
  store.students.set(PROFILE_STUD_A2, mkProfile(PROFILE_STUD_A2, USER_STUDENT_A2, UNI_A, { student_number: "S-A2" }));
  store.students.set(PROFILE_STUD_B1, mkProfile(PROFILE_STUD_B1, USER_STUDENT_B1, UNI_B, { student_number: "S-B1" }));
  store.students.set(PROFILE_STUD_B2, mkProfile(PROFILE_STUD_B2, USER_STUDENT_B2, UNI_B, { student_number: "S-B2" }));

  // Course assignments — the actual per-course matrix the issue spells out.
  // Faculty A on courses A1+A2; Faculty B on B1+B2; same for teachers + TAs.
  // Students are enrolled on the matching A1 / B1 course in their uni so the
  // teachers /me/students etc. queries have something non-empty to read.
  let assignmentCounter = 0;
  const assign = (courseId: string, userId: string, role: AssignmentRow["role"]): void => {
    assignmentCounter += 1;
    const id = `aaaaaaaa-0000-0000-0000-${String(assignmentCounter).padStart(12, "0")}`;
    store.courseAssignments.set(id, {
      id,
      course_id: courseId,
      user_id: userId,
      role,
      created_at: TS,
      updated_at: TS,
    });
  };

  // UNI_A — faculty A on A1+A2, faculty B on B1+B2. Same for teacher/TA pairs.
  assign(COURSE_A_A1, USER_FACULTY_A_A, "faculty");
  assign(COURSE_A_A2, USER_FACULTY_A_A, "faculty");
  assign(COURSE_A_B1, USER_FACULTY_B_A, "faculty");
  assign(COURSE_A_B2, USER_FACULTY_B_A, "faculty");
  assign(COURSE_A_A1, USER_TEACHER_A_A, "teacher");
  assign(COURSE_A_A2, USER_TEACHER_A_A, "teacher");
  assign(COURSE_A_B1, USER_TEACHER_B_A, "teacher");
  assign(COURSE_A_B2, USER_TEACHER_B_A, "teacher");
  assign(COURSE_A_A1, USER_TA_A_A, "teacher_assistant");
  assign(COURSE_A_A2, USER_TA_A_A, "teacher_assistant");
  assign(COURSE_A_B1, USER_TA_B_A, "teacher_assistant");
  assign(COURSE_A_B2, USER_TA_B_A, "teacher_assistant");
  assign(COURSE_A_A1, USER_STUDENT_A1, "student");
  assign(COURSE_A_B1, USER_STUDENT_A2, "student");

  // UNI_B — same pattern.
  assign(COURSE_B_A1, USER_FACULTY_A_B, "faculty");
  assign(COURSE_B_A2, USER_FACULTY_A_B, "faculty");
  assign(COURSE_B_B1, USER_FACULTY_B_B, "faculty");
  assign(COURSE_B_B2, USER_FACULTY_B_B, "faculty");
  assign(COURSE_B_A1, USER_TEACHER_A_B, "teacher");
  assign(COURSE_B_A2, USER_TEACHER_A_B, "teacher");
  assign(COURSE_B_B1, USER_TEACHER_B_B, "teacher");
  assign(COURSE_B_B2, USER_TEACHER_B_B, "teacher");
  assign(COURSE_B_A1, USER_TA_A_B, "teacher_assistant");
  assign(COURSE_B_A2, USER_TA_A_B, "teacher_assistant");
  assign(COURSE_B_B1, USER_TA_B_B, "teacher_assistant");
  assign(COURSE_B_B2, USER_TA_B_B, "teacher_assistant");
  assign(COURSE_B_A1, USER_STUDENT_B1, "student");
  assign(COURSE_B_B1, USER_STUDENT_B2, "student");

  // Pending invitations — one per uni so the invitation routes have a row to
  // act on. token_hash never gets exercised here (we don't hit /lookup or
  // /accept), so the value is decorative.
  store.invitations.set(INVITATION_A, {
    id: INVITATION_A,
    email: "newcomer-a@example.com",
    role: "staff",
    status: "pending",
    token_hash: "hash-a",
    university_id: UNI_A,
    invited_by: USER_UNI_A_ADMIN,
    expires_at: "2099-01-01T00:00:00.000Z",
    accepted_at: null,
    created_at: TS,
  });
  store.invitations.set(INVITATION_B, {
    id: INVITATION_B,
    email: "newcomer-b@example.com",
    role: "staff",
    status: "pending",
    token_hash: "hash-b",
    university_id: UNI_B,
    invited_by: USER_UNI_B_ADMIN,
    expires_at: "2099-01-01T00:00:00.000Z",
    accepted_at: null,
    created_at: TS,
  });

  return { store, db: store.toD1(), actors };
}

// ---------------------------------------------------------------------------
// IsolationStore — in-memory tables + a ProgrammableD1 wrapper. Keeping the
// data in real Maps lets writes from the routes update the same fixture the
// reads see, which matches actual D1 semantics and keeps the tests honest.
// ---------------------------------------------------------------------------

export class IsolationStore {
  readonly universities = new Map<string, UniversityRow>();
  readonly users = new Map<string, UserRecord>();
  readonly departments = new Map<string, DepartmentRow>();
  readonly courses = new Map<string, CourseRow>();
  readonly courseAssignments = new Map<string, AssignmentRow>();
  readonly faculty = new Map<string, ProfileRow>();
  readonly teachers = new Map<string, ProfileRow>();
  readonly teacherAssistants = new Map<string, ProfileRow>();
  readonly students = new Map<string, ProfileRow>();
  readonly invitations = new Map<string, InvitationRow>();
  /** Assessments seeded or inserted during a run (UNI-30). */
  readonly assessments = new Map<
    string,
    {
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
  >();
  /** Inserted email_logs rows — `recent resends in window` reads this list. */
  readonly emailLogs: Array<{
    id: string;
    related_entity_type: string | null;
    related_entity_id: string | null;
    type: string;
    created_at: string;
  }> = [];

  toD1(): ProgrammableD1 {
    const db = new ProgrammableD1();
    wireResolvers(db, this);
    return db;
  }

  uniName(id: string | null): string | null {
    return id === null ? null : this.universities.get(id)?.name ?? null;
  }

  deptName(id: string | null): string | null {
    return id === null ? null : this.departments.get(id)?.name ?? null;
  }

  /** All courses a user has any assignment to in `roles`. */
  coursesForUserInRoles(userId: string, roles: ReadonlySet<string>): CourseRow[] {
    const courseIds = new Set<string>();
    for (const a of this.courseAssignments.values()) {
      if (a.user_id === userId && roles.has(a.role)) courseIds.add(a.course_id);
    }
    const out: CourseRow[] = [];
    for (const id of courseIds) {
      const c = this.courses.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  studentsTaughtBy(teacherUserId: string, teacherRole: AssignmentRow["role"]): ProfileRow[] {
    // Students whose user_id appears as `student` on any course where
    // `teacherUserId` appears as `teacherRole`.
    const courseIds = new Set<string>();
    for (const a of this.courseAssignments.values()) {
      if (a.user_id === teacherUserId && a.role === teacherRole) {
        courseIds.add(a.course_id);
      }
    }
    const studentUserIds = new Set<string>();
    for (const a of this.courseAssignments.values()) {
      if (a.role === "student" && courseIds.has(a.course_id)) {
        studentUserIds.add(a.user_id);
      }
    }
    const out: ProfileRow[] = [];
    for (const s of this.students.values()) {
      if (studentUserIds.has(s.user_id)) out.push(s);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// SQL resolver wiring. Each `onFirst`/`onAll` block matches one prepared
// statement used by a route handler. Order matters when patterns overlap, so
// keep more specific WHERE matchers above broader ones.
// ---------------------------------------------------------------------------

function wireResolvers(db: ProgrammableD1, store: IsolationStore): void {
  const lc = (s: string): string => s.toLowerCase();

  // -------------------------------------------------------------------------
  // first()
  // -------------------------------------------------------------------------
  db.onFirst((sql, params) => {
    const s = lc(sql);

    // universities -----------------------------------------------------------
    if (s.startsWith("select id from universities where id = ?")) {
      const u = store.universities.get(String(params[0]));
      return u ? { id: u.id } : null;
    }
    if (s.startsWith("select id from universities where slug = ?")) {
      for (const u of store.universities.values()) {
        if (u.slug === params[0]) return { id: u.id };
      }
      return null;
    }
    if (s.startsWith("select name from universities where id = ?")) {
      const u = store.universities.get(String(params[0]));
      return u ? { name: u.name } : null;
    }
    if (
      s.startsWith("select id, name, slug, status, created_at, updated_at from universities") &&
      s.includes("where id = ?")
    ) {
      return store.universities.get(String(params[0])) ?? null;
    }

    // departments ------------------------------------------------------------
    if (s.startsWith("select id, university_id, name, code, description, created_at, updated_at from departments")) {
      return store.departments.get(String(params[0])) ?? null;
    }
    if (s.startsWith("select university_id from departments where id = ?")) {
      const d = store.departments.get(String(params[0]));
      return d ? { university_id: d.university_id } : null;
    }
    if (
      s.startsWith("select id from departments") &&
      s.includes("where university_id = ? and code = ?")
    ) {
      const universityId = String(params[0]);
      const code = String(params[1]);
      const excludeId = params[2] !== undefined ? String(params[2]) : null;
      for (const d of store.departments.values()) {
        if (
          d.university_id === universityId &&
          d.code === code &&
          (excludeId === null || d.id !== excludeId)
        ) {
          return { id: d.id };
        }
      }
      return null;
    }
    if (s.startsWith("select count(1) as count from courses where department_id = ?")) {
      let count = 0;
      for (const c of store.courses.values()) {
        if (c.department_id === params[0]) count++;
      }
      return { count };
    }
    if (
      s.startsWith("select d.id, d.university_id, d.name, d.code, d.description") &&
      s.includes("from departments d") &&
      s.includes("where d.id = ?")
    ) {
      const d = store.departments.get(String(params[0]));
      if (!d) return null;
      let courseCount = 0;
      for (const c of store.courses.values()) if (c.department_id === d.id) courseCount++;
      return {
        ...d,
        university_name: store.uniName(d.university_id),
        course_count: courseCount,
      };
    }

    // courses ---------------------------------------------------------------
    if (
      s.startsWith("select id, university_id, department_id, name, code, description, status") &&
      s.includes("from courses") &&
      s.includes("where id = ?")
    ) {
      return store.courses.get(String(params[0])) ?? null;
    }
    if (s.startsWith("select id, university_id from courses where id = ?")) {
      const c = store.courses.get(String(params[0]));
      return c ? { id: c.id, university_id: c.university_id } : null;
    }
    if (
      s.startsWith("select c.id, c.university_id, c.department_id") &&
      s.includes("from courses c") &&
      s.includes("where c.id = ?")
    ) {
      const c = store.courses.get(String(params[0]));
      if (!c) return null;
      return enrichCourse(c, store);
    }

    // course_assignments ----------------------------------------------------
    if (
      s.startsWith("select role from course_assignments") &&
      s.includes("where course_id = ? and user_id = ? and role in")
    ) {
      const courseId = String(params[0]);
      const userId = String(params[1]);
      const allowed = new Set(params.slice(2).map(String));
      for (const a of store.courseAssignments.values()) {
        if (a.course_id === courseId && a.user_id === userId && allowed.has(a.role)) {
          return { role: a.role };
        }
      }
      return null;
    }
    if (
      s.startsWith("select id from course_assignments") &&
      s.includes("where course_id = ? and user_id = ? and role = ?")
    ) {
      for (const a of store.courseAssignments.values()) {
        if (
          a.course_id === params[0] &&
          a.user_id === params[1] &&
          a.role === params[2]
        ) {
          return { id: a.id };
        }
      }
      return null;
    }
    if (
      s.startsWith("select user_id, role from course_assignments") &&
      s.includes("where id = ? and course_id = ?")
    ) {
      const a = store.courseAssignments.get(String(params[0]));
      if (a && a.course_id === params[1]) {
        return { user_id: a.user_id, role: a.role };
      }
      return null;
    }
    if (
      s.startsWith("select ca.id, ca.course_id, ca.user_id, ca.role") &&
      s.includes("from course_assignments ca") &&
      s.includes("where ca.id = ?")
    ) {
      const a = store.courseAssignments.get(String(params[0]));
      if (!a) return null;
      const u = store.users.get(a.user_id);
      if (!u) return null;
      return {
        ...a,
        user_name: u.name,
        user_email: u.email,
        user_role: u.role,
      };
    }

    // users -----------------------------------------------------------------
    if (s.startsWith("select id, university_id from users where id = ?")) {
      const u = store.users.get(String(params[0]));
      return u ? { id: u.id, university_id: u.university_id } : null;
    }
    if (
      s.startsWith("select u.id, u.email, u.name, u.role, u.status") &&
      s.includes("from users u") &&
      s.includes("where u.id = ?")
    ) {
      const u = store.users.get(String(params[0]));
      if (!u) return null;
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        university_id: u.university_id,
        last_sign_in_at: u.last_sign_in_at,
        created_at: u.created_at,
        updated_at: u.updated_at,
        university_name: store.uniName(u.university_id),
      };
    }
    if (s.startsWith("select id from users where email = ?")) {
      for (const u of store.users.values()) {
        if (u.email === params[0]) return { id: u.id };
      }
      return null;
    }

    // invitations ------------------------------------------------------------
    if (
      s.startsWith("select id, email, role, status, token_hash, university_id, invited_by") &&
      s.includes("where id = ?")
    ) {
      return store.invitations.get(String(params[0])) ?? null;
    }
    if (
      s.startsWith("select id, expires_at, status") &&
      s.includes("from invitations") &&
      s.includes("where email = ? and status = 'pending'")
    ) {
      for (const i of store.invitations.values()) {
        if (i.email === params[0] && i.status === "pending") return i;
      }
      return null;
    }
    if (
      s.startsWith("select i.id, i.email, i.role, i.status, i.token_hash") &&
      s.includes("where i.id = ?")
    ) {
      const i = store.invitations.get(String(params[0]));
      if (!i) return null;
      return enrichInvitation(i, store);
    }

    // email_logs (resend rate-limit) ----------------------------------------
    if (
      s.startsWith("select count(*) as c from email_logs") &&
      s.includes("related_entity_type = 'invitation'") &&
      s.includes("type                = 'invitation_resend'")
    ) {
      const id = String(params[0]);
      const since = String(params[1]);
      let c = 0;
      for (const e of store.emailLogs) {
        if (
          e.related_entity_type === "invitation" &&
          e.related_entity_id === id &&
          e.type === "invitation_resend" &&
          e.created_at > since
        ) {
          c++;
        }
      }
      return { c };
    }

    // audit_logs / email_logs counts ----------------------------------------
    if (s.startsWith("select count(1) as c from audit_logs a")) {
      // We don't model audit_logs reads; tests assert on inserts via
      // db.inserts("audit_logs"). Returning 0 is fine for the count branch.
      return { c: 0 };
    }
    if (s.startsWith("select count(1) as c from email_logs e")) {
      return { c: 0 };
    }

    // dashboard counts ------------------------------------------------------
    if (s.startsWith("select count(*) as c from universities")) {
      return { c: store.universities.size };
    }
    if (s.startsWith("select count(*) as c from users")) {
      return { c: store.users.size };
    }
    if (s.startsWith("select count(*) as c from invitations")) {
      let c = 0;
      for (const i of store.invitations.values()) if (i.status === "pending") c++;
      return { c };
    }

    // settings system-status DB ping
    if (s.startsWith("select 1 as ok")) return { ok: 1 };

    // students/faculty/teachers/teacher_assistants — single-row lookups -----
    if (s.includes("from students s")) {
      if (s.includes("where s.id = ?")) {
        const r = store.students.get(String(params[0]));
        return r ? enrichStudent(r, store) : null;
      }
      if (s.includes("where s.user_id = ?")) {
        for (const r of store.students.values()) {
          if (r.user_id === params[0]) return enrichStudent(r, store);
        }
        return null;
      }
    }
    if (s.includes("from faculty f")) {
      if (s.includes("where f.id = ?")) {
        const r = store.faculty.get(String(params[0]));
        return r ? enrichFaculty(r, store) : null;
      }
      if (s.includes("where f.user_id = ?")) {
        for (const r of store.faculty.values()) {
          if (r.user_id === params[0]) return enrichFaculty(r, store);
        }
        return null;
      }
    }
    if (s.includes("from teachers t")) {
      if (s.includes("where t.id = ?")) {
        const r = store.teachers.get(String(params[0]));
        return r ? enrichTeacher(r, store) : null;
      }
      if (s.includes("where t.user_id = ?")) {
        for (const r of store.teachers.values()) {
          if (r.user_id === params[0]) return enrichTeacher(r, store);
        }
        return null;
      }
    }
    if (s.includes("from teacher_assistants ta")) {
      if (s.includes("where ta.id = ?")) {
        const r = store.teacherAssistants.get(String(params[0]));
        return r ? enrichTa(r, store) : null;
      }
      if (s.includes("where ta.user_id = ?")) {
        for (const r of store.teacherAssistants.values()) {
          if (r.user_id === params[0]) return enrichTa(r, store);
        }
        return null;
      }
    }

    // UNI-30 — admin / staff path on assessments + grades endpoints loads
    // the course by university to confirm the actor shares the course's uni.
    if (
      s.startsWith("select university_id from courses where id = ?")
    ) {
      const c = store.courses.get(String(params[0]));
      return c ? { university_id: c.university_id } : null;
    }
    // UNI-30 — student-grades endpoint reads the target student's
    // role/university to gate cross-uni and non-student lookups.
    if (
      s.startsWith("select id, role, university_id from users where id = ?")
    ) {
      const u = store.users.get(String(params[0]));
      return u
        ? { id: u.id, role: u.role, university_id: u.university_id }
        : null;
    }

    // assessments (UNI-30) -------------------------------------------------
    if (s.startsWith("select a.id, a.course_id, a.deleted_at,")) {
      const a = store.assessments.get(String(params[0]));
      if (!a) return null;
      const c = store.courses.get(a.course_id);
      return {
        id: a.id,
        course_id: a.course_id,
        deleted_at: a.deleted_at,
        course_university_id: c?.university_id ?? null,
      };
    }
    if (
      s.startsWith("select a.id, a.course_id, a.title, a.description,") &&
      s.includes("where a.id = ?")
    ) {
      const a = store.assessments.get(String(params[0]));
      if (!a) return null;
      const c = store.courses.get(a.course_id);
      return {
        ...a,
        course_name: c ? "Course" : null,
        course_code: c?.code ?? null,
        course_university_id: c?.university_id ?? null,
      };
    }

    // grades (UNI-30) ------------------------------------------------------
    if (
      s.startsWith("select g.id, g.assessment_id, g.student_user_id,") &&
      s.includes("where g.id = ?")
    ) {
      // No grades seeded in this fixture; fall through.
      return null;
    }

    // grade_access_log count (UNI-30) -------------------------------------
    if (s.startsWith("select count(1) as c from grade_access_log")) {
      return { c: 0 };
    }

    return undefined;
  });

  // -------------------------------------------------------------------------
  // all()
  // -------------------------------------------------------------------------
  db.onAll((sql, params) => {
    const s = lc(sql);

    // universities list -----------------------------------------------------
    if (
      s.startsWith("select id, name, slug, status, created_at, updated_at from universities") &&
      !s.includes("where")
    ) {
      return Array.from(store.universities.values());
    }
    if (
      s.startsWith("select id, name, slug, status, created_at, updated_at from universities") &&
      s.includes("where id = ?")
    ) {
      const u = store.universities.get(String(params[0]));
      return u ? [u] : [];
    }

    // users list -----------------------------------------------------------
    if (s.startsWith("select u.id, u.email, u.name, u.role, u.status") && s.includes("from users u")) {
      let list = Array.from(store.users.values());
      // Best-effort param filtering; many params can be present per the
      // dynamic WHERE, but for our matrix tests only `university_id = ?` on
      // the first parameter slot matters (uni scoping is what we verify).
      const uniParam = params.find(
        (p) => typeof p === "string" && store.universities.has(p),
      ) as string | undefined;
      if (uniParam) list = list.filter((u) => u.university_id === uniParam);
      // role / status filters
      if (s.includes("u.role = ?")) {
        const i = params.findIndex((p) => typeof p === "string" && p.length < 36);
        if (i >= 0) list = list.filter((u) => u.role === params[i]);
      }
      return list.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        university_id: u.university_id,
        last_sign_in_at: u.last_sign_in_at,
        created_at: u.created_at,
        updated_at: u.updated_at,
        university_name: store.uniName(u.university_id),
      }));
    }

    // departments list ------------------------------------------------------
    if (s.startsWith("select d.id, d.university_id, d.name, d.code, d.description")) {
      let list = Array.from(store.departments.values());
      if (s.includes("d.university_id = ?")) {
        list = list.filter((d) => d.university_id === params[0]);
      }
      return list.map((d) => {
        let courseCount = 0;
        for (const c of store.courses.values()) if (c.department_id === d.id) courseCount++;
        return { ...d, university_name: store.uniName(d.university_id), course_count: courseCount };
      });
    }

    // teacher / TA / student me/courses query — must come before the generic
    // course-list matcher since both start with `SELECT c.id ...`.
    if (
      s.startsWith("select c.id, c.university_id, c.department_id") &&
      s.includes("from courses c") &&
      s.includes("join course_assignments ca on ca.course_id = c.id")
    ) {
      const userId = String(params[0]);
      let role: AssignmentRow["role"];
      if (s.includes("'teacher_assistant'")) role = "teacher_assistant";
      else if (s.includes("'teacher'")) role = "teacher";
      else role = "student";
      const courses = store.coursesForUserInRoles(userId, new Set([role]));
      return courses.map((c) => enrichCourse(c, store));
    }

    // courses list (generic) -----------------------------------------------
    if (s.startsWith("select c.id, c.university_id, c.department_id") && s.includes("from courses c")) {
      let list = Array.from(store.courses.values());
      // Filter by any param that matches a known uni or department id.
      for (const p of params) {
        if (typeof p !== "string") continue;
        if (store.universities.has(p)) list = list.filter((c) => c.university_id === p);
        if (store.departments.has(p)) list = list.filter((c) => c.department_id === p);
      }
      // Status filter
      if (s.includes("c.status = ?")) {
        const status = params.find((p) => p === "active" || p === "inactive" || p === "archived");
        if (status) list = list.filter((c) => c.status === status);
      }
      return list.map((c) => enrichCourse(c, store));
    }

    // course_assignments list (per-course)
    if (s.startsWith("select ca.id, ca.course_id, ca.user_id, ca.role") && s.includes("from course_assignments ca")) {
      let list = Array.from(store.courseAssignments.values());
      const courseId = params.find((p) => typeof p === "string" && store.courses.has(p)) as
        | string
        | undefined;
      if (courseId) list = list.filter((a) => a.course_id === courseId);
      // Optional role filter
      const roleFilter = params.find(
        (p) =>
          p === "faculty" ||
          p === "teacher" ||
          p === "teacher_assistant" ||
          p === "student" ||
          p === "viewer",
      );
      if (s.includes("ca.role = ?") && roleFilter) {
        list = list.filter((a) => a.role === roleFilter);
      }
      return list.map((a) => {
        const u = store.users.get(a.user_id);
        return {
          ...a,
          user_name: u?.name ?? "",
          user_email: u?.email ?? "",
          user_role: u?.role ?? "viewer",
        };
      });
    }

    // teacher's nested students query (`SELECT DISTINCT s.id, ...`) — must
    // come before the generic students list since both touch `from students s`.
    if (
      s.startsWith("select distinct s.id, s.user_id") &&
      s.includes("from students s")
    ) {
      const userId = String(params[0]);
      const role: AssignmentRow["role"] =
        s.includes("ca_teacher.role = 'teacher_assistant'")
          ? "teacher_assistant"
          : "teacher";
      const students = store.studentsTaughtBy(userId, role);
      return students.map((r) => enrichStudent(r, store));
    }

    // students list
    if (s.includes("from students s") && s.includes("order by u.name")) {
      let list = Array.from(store.students.values());
      if (s.includes("s.university_id = ?")) {
        list = list.filter((r) => r.university_id === params[0]);
      }
      return list.map((r) => enrichStudent(r, store));
    }
    // faculty list
    if (s.includes("from faculty f") && s.includes("order by u.name")) {
      let list = Array.from(store.faculty.values());
      if (s.includes("f.university_id = ?")) {
        list = list.filter((r) => r.university_id === params[0]);
      }
      return list.map((r) => enrichFaculty(r, store));
    }
    // teachers list
    if (s.includes("from teachers t") && s.includes("order by u.name")) {
      let list = Array.from(store.teachers.values());
      if (s.includes("t.university_id = ?")) {
        list = list.filter((r) => r.university_id === params[0]);
      }
      return list.map((r) => enrichTeacher(r, store));
    }
    // TAs list
    if (s.includes("from teacher_assistants ta") && s.includes("order by u.name")) {
      let list = Array.from(store.teacherAssistants.values());
      if (s.includes("ta.university_id = ?")) {
        list = list.filter((r) => r.university_id === params[0]);
      }
      return list.map((r) => enrichTa(r, store));
    }

    // course_assignments DISTINCT course_id with parameterized role list.
    // The "role IN (...)" form (course_assignments helper) is what binds
    // here; the UNI-30 "role = 'student'" inlined form is handled below.
    if (
      s.startsWith("select distinct course_id from course_assignments") &&
      s.includes("role in")
    ) {
      const userId = String(params[0]);
      const allowed = new Set(params.slice(1).map(String));
      const ids = new Set<string>();
      for (const a of store.courseAssignments.values()) {
        if (a.user_id === userId && allowed.has(a.role)) ids.add(a.course_id);
      }
      return Array.from(ids).map((id) => ({ course_id: id }));
    }

    // invitations list ------------------------------------------------------
    if (s.startsWith("select i.id, i.email, i.role, i.status, i.token_hash")) {
      let list = Array.from(store.invitations.values());
      if (s.includes("i.university_id = ?") && params[0]) {
        list = list.filter((i) => i.university_id === params[0]);
      }
      return list.map((i) => enrichInvitation(i, store));
    }

    // audit_logs / email_logs — return [] since we don't emulate reads.
    if (s.startsWith("select a.id, a.university_id, a.actor_user_id")) return [];
    if (s.startsWith("select e.id, e.university_id, e.recipient_email")) return [];

    // assessments / grades / grade_access_log lists (UNI-30) — empty.
    // The matrix doesn't seed any rows; tests assert on access *gating*, not
    // on returned content.
    if (
      s.startsWith("select a.id, a.course_id, a.title, a.description,") &&
      s.includes("where a.course_id = ?")
    ) {
      return [];
    }
    if (
      s.startsWith("select g.id, g.assessment_id, g.student_user_id,") &&
      s.includes("from grades g")
    ) {
      return [];
    }
    if (s.startsWith("select al.id, al.viewer_user_id,")) {
      return [];
    }
    // Student-grades course-tuple lookups (UNI-30).
    if (
      s.startsWith("select distinct course_id from course_assignments") &&
      s.includes("role = 'student'")
    ) {
      const userId = String(params[0]);
      const out = new Set<string>();
      for (const a of store.courseAssignments.values()) {
        if (a.user_id === userId && a.role === "student") out.add(a.course_id);
      }
      return Array.from(out).map((course_id) => ({ course_id }));
    }
    if (
      s.startsWith("select distinct ca.course_id from course_assignments ca")
    ) {
      const userId = String(params[0]);
      // params[1] is actor.role string; params[2] is actor.university_id ?? "".
      const out = new Set<string>();
      for (const a of store.courseAssignments.values()) {
        if (a.user_id === userId && a.role === "student") out.add(a.course_id);
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
      const studentCourses = new Set<string>();
      for (const a of store.courseAssignments.values()) {
        if (a.user_id === studentId && a.role === "student") {
          studentCourses.add(a.course_id);
        }
      }
      const out: { course_id: string; role: string }[] = [];
      for (const a of store.courseAssignments.values()) {
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

    return undefined;
  });

  // Mirror writes back into the in-memory tables so subsequent reads see them.
  db.onWrite((sql, params) => {
    const s = lc(sql);
    if (s.startsWith("insert into universities")) {
      store.universities.set(String(params[0]), {
        id: String(params[0]),
        name: String(params[1]),
        slug: params[2] === null ? null : String(params[2]),
        status: String(params[3]) as UniversityRow["status"],
        created_at: String(params[4]),
        updated_at: String(params[5]),
      });
    }
    if (s.startsWith("insert into departments")) {
      store.departments.set(String(params[0]), {
        id: String(params[0]),
        university_id: String(params[1]),
        name: String(params[2]),
        code: params[3] === null ? null : String(params[3]),
        description: params[4] === null ? null : String(params[4]),
        created_at: String(params[5]),
        updated_at: String(params[6]),
      });
    }
    if (s.startsWith("insert into courses")) {
      store.courses.set(String(params[0]), {
        id: String(params[0]),
        university_id: String(params[1]),
        department_id: params[2] === null ? null : String(params[2]),
        name: String(params[3]),
        code: params[4] === null ? null : String(params[4]),
        description: params[5] === null ? null : String(params[5]),
        status: String(params[6]) as CourseRow["status"],
        created_at: String(params[7]),
        updated_at: String(params[8]),
      });
    }
    if (s.startsWith("insert into course_assignments")) {
      store.courseAssignments.set(String(params[0]), {
        id: String(params[0]),
        course_id: String(params[1]),
        user_id: String(params[2]),
        role: String(params[3]) as AssignmentRow["role"],
        created_at: String(params[4]),
        updated_at: String(params[5]),
      });
    }
    if (s.startsWith("insert into assessments")) {
      // INSERT INTO assessments
      //   (id, course_id, title, description, weight, max_score, due_at,
      //    created_by, created_at, updated_at) VALUES (?...?)
      store.assessments.set(String(params[0]), {
        id: String(params[0]),
        course_id: String(params[1]),
        title: String(params[2]),
        description: params[3] === null ? null : String(params[3]),
        weight: Number(params[4]),
        max_score: Number(params[5]),
        due_at: params[6] === null ? null : String(params[6]),
        created_by: params[7] === null ? null : String(params[7]),
        deleted_at: null,
        created_at: String(params[8]),
        updated_at: String(params[9]),
      });
    }
    if (s.startsWith("delete from course_assignments")) {
      const id = String(params[0]);
      store.courseAssignments.delete(id);
    }
    if (s.startsWith("delete from courses where id = ?")) {
      store.courses.delete(String(params[0]));
    }
    if (s.startsWith("delete from departments where id = ?")) {
      store.departments.delete(String(params[0]));
    }
    if (s.startsWith("insert into invitations")) {
      const id = String(params[0]);
      store.invitations.set(id, {
        id,
        email: String(params[1]),
        role: String(params[2]) as Role,
        status: "pending",
        token_hash: String(params[3]),
        university_id: params[4] === null ? null : String(params[4]),
        invited_by: params[5] === null ? null : String(params[5]),
        expires_at: String(params[6]),
        accepted_at: null,
        created_at: TS,
      });
    }
    if (s.startsWith("update invitations set status = 'revoked'")) {
      const i = store.invitations.get(String(params[0]));
      if (i) store.invitations.set(i.id, { ...i, status: "revoked" });
    }
    if (s.startsWith("insert into email_logs")) {
      // 10-param shape from mail/email-logs.ts:
      //   id, university_id, recipient_email, type, template_name, status,
      //   mailgun_message_id, error, related_entity_type, related_entity_id.
      // We only need the resend rate-limit query, so stash just the fields it
      // reads (related_entity_type/id, type) plus a timestamp.
      store.emailLogs.push({
        id: String(params[0]),
        type: String(params[3]),
        related_entity_type:
          params[8] === null || params[8] === undefined ? null : String(params[8]),
        related_entity_id:
          params[9] === null || params[9] === undefined ? null : String(params[9]),
        created_at: new Date().toISOString(),
      });
    }
    if (s.startsWith("update users set name = ?, updated_at = ? where id = ?")) {
      const id = String(params[2]);
      const u = store.users.get(id);
      if (u) store.users.set(id, { ...u, name: String(params[0]), updated_at: String(params[1]) });
    }
    if (s.startsWith("update users set role = ?, updated_at = ? where id = ?")) {
      const id = String(params[2]);
      const u = store.users.get(id);
      if (u) store.users.set(id, { ...u, role: String(params[0]) as Role });
    }
    if (s.startsWith("update users set status = ?, updated_at = ? where id = ?")) {
      const id = String(params[2]);
      const u = store.users.get(id);
      if (u) store.users.set(id, { ...u, status: String(params[0]) as UserStatus });
    }
  });
}

function enrichCourse(c: { id: string; university_id: string; department_id: string | null } & Record<string, unknown>, store: IsolationStore) {
  let assignmentCount = 0;
  for (const a of store.courseAssignments.values()) {
    if (a.course_id === c.id) assignmentCount++;
  }
  return {
    ...c,
    university_name: store.uniName(c.university_id),
    department_name: store.deptName(c.department_id),
    assignment_count: assignmentCount,
  };
}

function enrichStudent(r: ProfileRow, store: IsolationStore) {
  const u = store.users.get(r.user_id);
  return {
    id: r.id,
    user_id: r.user_id,
    university_id: r.university_id,
    department_id: r.department_id,
    student_number: r.student_number,
    created_at: r.created_at,
    updated_at: r.updated_at,
    name: u?.name ?? "",
    email: u?.email ?? "",
    university_name: store.uniName(r.university_id),
    department_name: store.deptName(r.department_id),
  };
}

function enrichFaculty(r: ProfileRow, store: IsolationStore) {
  const u = store.users.get(r.user_id);
  return {
    id: r.id,
    user_id: r.user_id,
    university_id: r.university_id,
    department_id: r.department_id,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
    name: u?.name ?? "",
    email: u?.email ?? "",
    university_name: store.uniName(r.university_id),
    department_name: store.deptName(r.department_id),
  };
}

function enrichTeacher(r: ProfileRow, store: IsolationStore) {
  return enrichFaculty(r, store);
}

function enrichTa(r: ProfileRow, store: IsolationStore) {
  const u = store.users.get(r.user_id);
  return {
    id: r.id,
    user_id: r.user_id,
    university_id: r.university_id,
    department_id: r.department_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    name: u?.name ?? "",
    email: u?.email ?? "",
    university_name: store.uniName(r.university_id),
    department_name: store.deptName(r.department_id),
  };
}

function enrichInvitation(i: InvitationRow, store: IsolationStore) {
  return {
    ...i,
    inviter_name: i.invited_by ? store.users.get(i.invited_by)?.name ?? null : null,
    university_name: i.university_id ? store.uniName(i.university_id) : null,
    last_email_status: null,
    last_email_sent_at: null,
    last_email_error: null,
  };
}

// ---------------------------------------------------------------------------
// RequestContext factory
// ---------------------------------------------------------------------------

export interface MakeCtxInit {
  method?: string;
  pathname?: string;
  query?: Record<string, string>;
  body?: unknown;
}

export function makeCtx(
  actor: UserRecord,
  db: ProgrammableD1,
  init: MakeCtxInit = {},
): RequestContext {
  const url = new URL(`https://hub.example.com${init.pathname ?? "/api/test"}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }
  const requestInit: RequestInit = {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  const env: Env = {
    DB: db as unknown as D1Database,
    APP_NAME: "University Hub",
    APP_BASE_URL: "https://hub.example.com",
    SESSION_COOKIE_NAME: "university_hub_session",
    // `replace-with-...` placeholders short-circuit Mailgun to a
    // `mailgun_not_configured` failure (see mail/mailgun.ts), so no real
    // HTTP call ever fires from these tests — and no stderr from a fake 401.
    MAILGUN_API_KEY: "replace-with-mailgun-api-key",
    MAILGUN_DOMAIN: "replace-with-mailgun-domain",
    MAILGUN_FROM_EMAIL: "replace-with-from@example.com",
    MAILGUN_FROM_NAME: "replace-with-from-name",
    SUPPORT_EMAIL: "support@example.com",
  };
  const auth: AuthState = {
    user: actor as unknown as UserRow,
    session: {
      id: "test-session",
      user_id: actor.id,
      token_hash: "h",
      ip_address: null,
      user_agent: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: TS,
      last_activity_at: TS,
    },
  };
  return { request: new Request(url, requestInit), env, url, cookies: {}, auth };
}
