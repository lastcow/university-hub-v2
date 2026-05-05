// Reconciliation engine tests (epic UNI-50 / sub-issue UNI-56).
//
// Coverage map back to the issue acceptance criteria:
//
//   * "First sync (all new) — expected creates; no invitation emails
//     sent." → first-sync test asserts the engine never imports the
//     mail module AND that no INSERT INTO email_logs is recorded.
//   * "Re-sync, no changes — expected zero writes (or only
//     last_synced_at updates)." → no-op re-sync test counts the
//     courses / users / disclosure_log inserts and asserts none.
//   * "Re-sync, dropped student — assignment soft-deleted." → drop
//     test asserts `course_assignments.status = 'dropped'`.
//   * "Re-sync, new student matching existing email — links to
//     existing user." → email-match test asserts the existing user is
//     reused and external linkage is backfilled.
//   * "Re-sync, new student with no match — creates pending user (no
//     email)." → covered by the first-sync test for the all-new path.
//   * "Conflict (manual edit on a synced course) — LMS wins, conflict
//     flagged in summary." → conflict-detection test.
//   * "Provider failure mid-sync — partial status, partial data
//     persisted." → partial-failure test asserts status='partial' and
//     summary holds the work that succeeded.
//   * "FERPA disclosure_log rows created for auto-imported students."
//     → disclosure_log inserts asserted on the first-sync path with
//     basis='school_official_exception'.
//   * "Audit log coverage matches the events listed above." → audit
//     test counts the action strings written through writeAuditLog.

import { describe, expect, it, vi } from "vitest";

import {
  runLmsReconciliation,
  type ReconciliationDeps,
  type ReconciliationInput,
} from "../../src/lms/reconcile.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";
import type {
  LmsConnection,
  LmsCourse,
  LmsEnrollment,
  LmsTerm,
} from "@university-hub/shared";
import type { LmsProvider } from "../../src/lms/provider.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const UNI_A = "11111111-1111-1111-1111-111111111111";
const ACTOR_USER_ID = "00000000-0000-0000-0000-00000000aaaa";
const CONN_ID = "33333333-3333-3333-3333-333333333333";

interface CourseSeed {
  id: string;
  university_id: string;
  external_provider: string | null;
  external_id: string | null;
  last_synced_at: string | null;
  updated_at: string;
  source: string;
}

interface UserSeed {
  id: string;
  email: string;
  university_id: string | null;
  external_provider: string | null;
  external_id: string | null;
  role: string;
  status: string;
}

interface AssignmentSeed {
  id: string;
  course_id: string;
  user_id: string;
  role: string;
  source: string;
  external_provider: string | null;
  external_id: string | null;
  status: string;
}

interface FixtureSeed {
  courses?: CourseSeed[];
  users?: UserSeed[];
  assignments?: AssignmentSeed[];
}

interface Fixture {
  db: ProgrammableD1;
  courses: CourseSeed[];
  users: UserSeed[];
  students: Array<{ id: string; user_id: string; university_id: string }>;
  assignments: AssignmentSeed[];
  disclosureLogs: Array<{
    id: string;
    student_user_id: string;
    university_id: string | null;
    consent_id: string | null;
    basis: string;
    released_to: string;
    data_categories: string;
    notes: string | null;
    released_at: string;
    released_by_user_id: string | null;
  }>;
  auditActions: string[];
  emailLogInserts: number;
}

function makeFixture(seed: FixtureSeed = {}): Fixture {
  const db = new ProgrammableD1();
  const courses: CourseSeed[] = (seed.courses ?? []).map((r) => ({ ...r }));
  const users: UserSeed[] = (seed.users ?? []).map((r) => ({ ...r }));
  const assignments: AssignmentSeed[] = (seed.assignments ?? []).map((r) => ({
    ...r,
  }));
  const students: Fixture["students"] = [];
  const disclosureLogs: Fixture["disclosureLogs"] = [];
  const auditActions: string[] = [];
  let emailLogInserts = 0;

  db.onFirst((sql, params) => {
    const s = sql.toLowerCase();
    if (s.startsWith("pragma")) return null;
    if (
      s.startsWith("select id, university_id, external_provider, external_id,") &&
      s.includes("from courses") &&
      s.includes("where university_id = ? and external_provider = ? and external_id = ?")
    ) {
      const [universityId, provider, externalId] = params as [
        string,
        string,
        string,
      ];
      return (
        courses.find(
          (c) =>
            c.university_id === universityId &&
            c.external_provider === provider &&
            c.external_id === externalId,
        ) ?? null
      );
    }
    if (
      s.startsWith("select id, email, university_id, external_provider, external_id, role, status") &&
      s.includes("from users") &&
      s.includes("where university_id = ? and external_provider = ? and external_id = ?")
    ) {
      const [universityId, provider, externalId] = params as [
        string,
        string,
        string,
      ];
      return (
        users.find(
          (u) =>
            u.university_id === universityId &&
            u.external_provider === provider &&
            u.external_id === externalId,
        ) ?? null
      );
    }
    if (
      s.startsWith("select id, email, university_id, external_provider, external_id, role, status") &&
      s.includes("from users") &&
      s.includes("where university_id = ? and lower(email) = ?")
    ) {
      const [universityId, email] = params as [string, string];
      return (
        users.find(
          (u) =>
            u.university_id === universityId &&
            u.email.toLowerCase() === email,
        ) ?? null
      );
    }
    if (
      s.startsWith(
        "select id, course_id, user_id, role, source, external_provider, external_id, status",
      ) &&
      s.includes("where course_id = ? and user_id = ? and role = ?")
    ) {
      const [courseId, userId, role] = params as [string, string, string];
      return (
        assignments.find(
          (a) =>
            a.course_id === courseId &&
            a.user_id === userId &&
            a.role === role,
        ) ?? null
      );
    }
    return undefined;
  });

  db.onAll((sql, params) => {
    const s = sql.toLowerCase();
    if (
      s.startsWith(
        "select id, course_id, user_id, role, source, external_provider, external_id, status",
      ) &&
      s.includes("from course_assignments") &&
      s.includes("where course_id = ? and source = 'lms'")
    ) {
      const [courseId, providerId] = params as [string, string];
      return assignments.filter(
        (a) =>
          a.course_id === courseId &&
          a.source === "lms" &&
          a.external_provider === providerId &&
          a.status === "active",
      );
    }
    return undefined;
  });

  db.onWrite((sql, params) => {
    const s = sql.toLowerCase();
    if (s.startsWith("insert into courses")) {
      const [
        id,
        university_id,
        ,
        ,
        ,
        ,
        external_provider,
        external_id,
        ,
        last_synced_at,
        ,
        updated_at,
      ] = params as readonly (string | null)[];
      courses.push({
        id: String(id),
        university_id: String(university_id),
        external_provider: (external_provider as string) ?? null,
        external_id: (external_id as string) ?? null,
        last_synced_at: (last_synced_at as string) ?? null,
        updated_at: String(updated_at),
        source: "lms",
      });
    } else if (s.startsWith("update courses")) {
      // last param is the id
      const id = String(params[params.length - 1]);
      const c = courses.find((r) => r.id === id);
      if (c) {
        c.last_synced_at = String(params[4]); // last_synced_at is the 5th param
        c.updated_at = String(params[5]);
        c.source = "lms";
      }
    } else if (s.startsWith("insert into users")) {
      const [
        id,
        email,
        ,
        ,
        ,
        ,
        university_id,
        external_provider,
        external_id,
      ] = params as readonly (string | null)[];
      users.push({
        id: String(id),
        email: String(email),
        university_id: (university_id as string) ?? null,
        external_provider: (external_provider as string) ?? null,
        external_id: (external_id as string) ?? null,
        role: "student",
        status: "pending",
      });
    } else if (s.startsWith("update users")) {
      // backfill external linkage
      if (s.includes("set external_provider = ?, external_id = ?")) {
        const [provider, externalId, , id] = params as readonly (string | null)[];
        const u = users.find((r) => r.id === String(id));
        if (u) {
          u.external_provider = (provider as string) ?? null;
          u.external_id = (externalId as string) ?? null;
        }
      }
    } else if (s.startsWith("insert into students")) {
      const [id, user_id, university_id] = params as readonly (string | null)[];
      students.push({
        id: String(id),
        user_id: String(user_id),
        university_id: String(university_id),
      });
    } else if (s.startsWith("insert into course_assignments")) {
      const [
        id,
        course_id,
        user_id,
        role,
        ,
        external_provider,
        external_id,
      ] = params as readonly (string | null)[];
      assignments.push({
        id: String(id),
        course_id: String(course_id),
        user_id: String(user_id),
        role: String(role),
        source: "lms",
        external_provider: (external_provider as string) ?? null,
        external_id: (external_id as string) ?? null,
        status: "active",
      });
    } else if (s.startsWith("update course_assignments")) {
      const id = String(params[params.length - 1]);
      const a = assignments.find((r) => r.id === id);
      if (a) {
        if (s.includes("set status = 'dropped'")) {
          a.status = "dropped";
        } else if (s.includes("set status = 'active'")) {
          // Reactivation / update path. Update external linkage too so
          // dedupe keys flow correctly across re-syncs.
          a.status = "active";
          a.source = "lms";
          a.external_provider = (params[0] as string) ?? a.external_provider;
          a.external_id = (params[1] as string) ?? a.external_id;
        }
      }
    } else if (s.startsWith("insert into disclosure_log")) {
      // The INSERT in reconcile.ts uses literals for `consent_id`
      // (NULL), `basis` (`'school_official_exception'`), and
      // `released_by_user_id` (NULL), so the bound params reduce to:
      //   [id, student_user_id, university_id,
      //    released_to, data_categories, notes, released_at]
      const [
        id,
        student_user_id,
        university_id,
        released_to,
        data_categories,
        notes,
        released_at,
      ] = params as readonly (string | null)[];
      disclosureLogs.push({
        id: String(id),
        student_user_id: String(student_user_id),
        university_id: (university_id as string) ?? null,
        consent_id: null,
        basis: "school_official_exception",
        released_to: String(released_to),
        data_categories: String(data_categories),
        notes: (notes as string) ?? null,
        released_at: String(released_at),
        released_by_user_id: null,
      });
    } else if (s.startsWith("insert into audit_logs")) {
      // params: id, university_id, actor_user_id, action, entity_type, entity_id, metadata_json
      auditActions.push(String(params[3]));
    } else if (s.startsWith("insert into email_logs")) {
      emailLogInserts += 1;
    }
  });

  return {
    db,
    courses,
    users,
    students,
    assignments,
    disclosureLogs,
    auditActions,
    emailLogInserts,
  };
}

function makeProvider(
  options: {
    courses?: LmsCourse[];
    enrollmentsByCourse?: Record<string, LmsEnrollment[]>;
    listCoursesError?: Error;
    listEnrollmentsErrorFor?: string;
  } = {},
): {
  provider: LmsProvider;
  control: {
    courses: LmsCourse[];
    enrollmentsByCourse: Map<string, LmsEnrollment[]>;
  };
} {
  const control = {
    courses: options.courses ?? [],
    enrollmentsByCourse: new Map(
      Object.entries(options.enrollmentsByCourse ?? {}),
    ),
  };
  const provider: LmsProvider = {
    id: "canvas",
    async authenticate(): Promise<LmsConnection> {
      throw new Error("not used");
    },
    async refreshToken(c: LmsConnection): Promise<LmsConnection> {
      return c;
    },
    async listTerms(): Promise<LmsTerm[]> {
      return [];
    },
    async listMyCourses(): Promise<LmsCourse[]> {
      if (options.listCoursesError) throw options.listCoursesError;
      return control.courses;
    },
    async listEnrollments(_c, courseId): Promise<LmsEnrollment[]> {
      if (options.listEnrollmentsErrorFor === courseId) {
        throw new Error(
          `simulated_listEnrollments_failure for ${courseId}`,
        );
      }
      return control.enrollmentsByCourse.get(courseId) ?? [];
    },
  };
  return { provider, control };
}

function makeConnection(): LmsConnection {
  return {
    id: CONN_ID,
    user_id: ACTOR_USER_ID,
    university_id: UNI_A,
    provider_id: "canvas",
    auth_method: "oauth",
    base_url: "https://canvas.example.edu",
    access_token: "redacted",
    refresh_token: null,
    token_expires_at: null,
    scope: null,
    status: "active",
    last_synced_at: null,
    created_at: "2026-05-01T00:00:00.000Z" as LmsConnection["created_at"],
    updated_at: "2026-05-01T00:00:00.000Z" as LmsConnection["updated_at"],
  };
}

function makeInput(termName: string | null = "Fall 2026"): ReconciliationInput {
  return {
    syncRunId: "55555555-5555-5555-5555-555555555555",
    actorUserId: ACTOR_USER_ID,
    connection: makeConnection(),
    termId: "T1",
    termName,
  };
}

async function run(
  fix: Fixture,
  provider: LmsProvider,
  input: ReconciliationInput = makeInput(),
) {
  const deps: ReconciliationDeps = {
    db: fix.db as unknown as D1Database,
    provider,
  };
  return runLmsReconciliation(deps, input);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runLmsReconciliation — first sync (all new)", () => {
  it("creates courses, students, assignments, and disclosure_log rows; no email send", async () => {
    const fix = makeFixture();
    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "Course 1",
          code: "C-101",
          description: null,
        },
      ],
      enrollmentsByCourse: {
        C1: [
          {
            external_id: "E1",
            external_course_id: "C1",
            external_user_id: "lms-user-1",
            email: "Student-1@Example.edu",
            name: "Student One",
            role: "student",
          },
          {
            external_id: "E2",
            external_course_id: "C1",
            external_user_id: "lms-user-2",
            email: "student-2@example.edu",
            name: "Student Two",
            role: "student",
          },
        ],
      },
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("success");
    expect(result.summary).toMatchObject({
      courses_created: 1,
      courses_updated: 0,
      students_created: 2,
      students_matched: 0,
      students_invited: 0,
      enrollments_created: 2,
      enrollments_dropped: 0,
    });
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);

    // Two new students, one new course, two new assignments.
    expect(fix.courses).toHaveLength(1);
    expect(fix.users).toHaveLength(2);
    expect(fix.students).toHaveLength(2);
    expect(fix.assignments).toHaveLength(2);

    // FERPA: a disclosure_log row per imported student, basis school_official_exception.
    expect(fix.disclosureLogs).toHaveLength(2);
    for (const dl of fix.disclosureLogs) {
      expect(dl.basis).toBe("school_official_exception");
      expect(dl.consent_id).toBeNull();
      expect(dl.notes).toContain("sync_run 55555555-5555-5555-5555-555555555555");
    }

    // Email-suppression invariant: the engine does not write to email_logs
    // and does not call the mail module. The mail module isn't imported,
    // so this assertion catches only the by-hand record-of-writes path,
    // but it's explicit.
    expect(fix.emailLogInserts).toBe(0);
  });

  it("does not import the mail module — sendInvitationEmail is unreachable from the engine", async () => {
    // Static guard: importing reconcile.js must not transitively import
    // the mail module. Without a real bundler we use a runtime mock —
    // if reconcile.ts ever adds `from "../mail/index.js"` this will
    // start firing a side-effect counter.
    const sendSpy = vi.fn();
    vi.doMock("../../src/mail/index.js", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        sendInvitationEmail: sendSpy,
      };
    });

    // Force a fresh module load so the mock takes effect.
    vi.resetModules();
    const reconcileMod = await import("../../src/lms/reconcile.js");

    const fix = makeFixture();
    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "C1",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: {
        C1: [
          {
            external_id: "E1",
            external_course_id: "C1",
            external_user_id: "u1",
            email: "x@example.edu",
            name: "X",
            role: "student",
          },
        ],
      },
    });

    await reconcileMod.runLmsReconciliation(
      { db: fix.db as unknown as D1Database, provider },
      makeInput(),
    );

    expect(sendSpy).not.toHaveBeenCalled();
    vi.doUnmock("../../src/mail/index.js");
    vi.resetModules();
  });
});

describe("runLmsReconciliation — re-sync, no changes", () => {
  it("does not insert new course / user / disclosure_log rows on a second pass", async () => {
    const fix = makeFixture({
      courses: [
        {
          id: "course-1",
          university_id: UNI_A,
          external_provider: "canvas",
          external_id: "C1",
          last_synced_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          source: "lms",
        },
      ],
      users: [
        {
          id: "user-1",
          email: "student-1@example.edu",
          university_id: UNI_A,
          external_provider: "canvas",
          external_id: "lms-user-1",
          role: "student",
          status: "pending",
        },
      ],
      assignments: [
        {
          id: "assign-1",
          course_id: "course-1",
          user_id: "user-1",
          role: "student",
          source: "lms",
          external_provider: "canvas",
          external_id: "E1",
          status: "active",
        },
      ],
    });
    const startCourseCount = fix.courses.length;
    const startUserCount = fix.users.length;

    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "Course 1",
          code: "C-101",
          description: null,
        },
      ],
      enrollmentsByCourse: {
        C1: [
          {
            external_id: "E1",
            external_course_id: "C1",
            external_user_id: "lms-user-1",
            email: "student-1@example.edu",
            name: "Student One",
            role: "student",
          },
        ],
      },
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("success");
    expect(result.summary.courses_created).toBe(0);
    expect(result.summary.students_created).toBe(0);
    expect(result.summary.enrollments_dropped).toBe(0);
    expect(fix.courses).toHaveLength(startCourseCount);
    expect(fix.users).toHaveLength(startUserCount);
    expect(fix.disclosureLogs).toHaveLength(0);
    // The course is updated (last_synced_at bumped).
    expect(result.summary.courses_updated).toBe(1);
  });
});

describe("runLmsReconciliation — re-sync with a dropped student", () => {
  it("soft-deletes the prior assignment that no longer appears in the roster", async () => {
    const fix = makeFixture({
      courses: [
        {
          id: "course-1",
          university_id: UNI_A,
          external_provider: "canvas",
          external_id: "C1",
          last_synced_at: "2026-04-01T00:00:00.000Z",
          updated_at: "2026-04-01T00:00:00.000Z",
          source: "lms",
        },
      ],
      users: [
        {
          id: "user-keep",
          email: "keep@example.edu",
          university_id: UNI_A,
          external_provider: "canvas",
          external_id: "u-keep",
          role: "student",
          status: "pending",
        },
        {
          id: "user-drop",
          email: "drop@example.edu",
          university_id: UNI_A,
          external_provider: "canvas",
          external_id: "u-drop",
          role: "student",
          status: "pending",
        },
      ],
      assignments: [
        {
          id: "assign-keep",
          course_id: "course-1",
          user_id: "user-keep",
          role: "student",
          source: "lms",
          external_provider: "canvas",
          external_id: "E-keep",
          status: "active",
        },
        {
          id: "assign-drop",
          course_id: "course-1",
          user_id: "user-drop",
          role: "student",
          source: "lms",
          external_provider: "canvas",
          external_id: "E-drop",
          status: "active",
        },
      ],
    });

    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "Course 1",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: {
        // Only `keep` is still in the roster; `drop` should be soft-deleted.
        C1: [
          {
            external_id: "E-keep",
            external_course_id: "C1",
            external_user_id: "u-keep",
            email: "keep@example.edu",
            name: "Keep",
            role: "student",
          },
        ],
      },
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("success");
    expect(result.summary.enrollments_dropped).toBe(1);
    const dropped = fix.assignments.find((a) => a.id === "assign-drop");
    expect(dropped?.status).toBe("dropped");
    const kept = fix.assignments.find((a) => a.id === "assign-keep");
    expect(kept?.status).toBe("active");
    expect(fix.auditActions).toContain("lms.sync.enrollment.dropped");
  });
});

describe("runLmsReconciliation — student matched by email", () => {
  it("links the LMS enrollment to the existing Hub user; backfills external_provider/_id", async () => {
    const fix = makeFixture({
      users: [
        {
          id: "user-1",
          email: "Student-1@Example.edu",
          university_id: UNI_A,
          // No external linkage yet — engine must backfill it.
          external_provider: null,
          external_id: null,
          role: "student",
          status: "active",
        },
      ],
    });

    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "Course 1",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: {
        C1: [
          {
            external_id: "E1",
            external_course_id: "C1",
            external_user_id: "lms-user-1",
            email: "student-1@example.edu",
            name: "Student One",
            role: "student",
          },
        ],
      },
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("success");
    expect(result.summary.students_matched).toBe(1);
    expect(result.summary.students_created).toBe(0);
    expect(result.summary.enrollments_created).toBe(1);

    const u = fix.users.find((r) => r.id === "user-1");
    expect(u?.external_provider).toBe("canvas");
    expect(u?.external_id).toBe("lms-user-1");

    expect(fix.disclosureLogs).toHaveLength(0);
    expect(fix.auditActions).toContain("lms.sync.student.matched");
  });
});

describe("runLmsReconciliation — manual-edit conflict", () => {
  it("flags a conflict when course updated_at > last_synced_at, but LMS still wins", async () => {
    const fix = makeFixture({
      courses: [
        {
          id: "course-1",
          university_id: UNI_A,
          external_provider: "canvas",
          external_id: "C1",
          last_synced_at: "2026-04-01T00:00:00.000Z",
          // Manual edit happened *after* the last sync.
          updated_at: "2026-04-02T00:00:00.000Z",
          source: "lms",
        },
      ],
    });

    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "LMS authoritative name",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: { C1: [] },
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("success");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toEqual({
      course_external_id: "C1",
      course_name: "LMS authoritative name",
      reason: "manual_edit_overwritten",
    });
    // LMS wins: the course is updated despite the conflict.
    expect(result.summary.courses_updated).toBe(1);
  });
});

describe("runLmsReconciliation — provider failure mid-sync", () => {
  it("returns 'partial' when one course fails and another succeeds", async () => {
    const fix = makeFixture();
    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C-ok",
          external_term_id: "T1",
          name: "OK Course",
          code: null,
          description: null,
        },
        {
          external_id: "C-bad",
          external_term_id: "T1",
          name: "Bad Course",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: {
        "C-ok": [
          {
            external_id: "E1",
            external_course_id: "C-ok",
            external_user_id: "u1",
            email: "ok@example.edu",
            name: "OK",
            role: "student",
          },
        ],
      },
      // Throws when listing enrollments for C-bad.
      listEnrollmentsErrorFor: "C-bad",
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("partial");
    expect(result.summary.courses_created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      scope: "course",
      external_id: "C-bad",
    });
  });

  it("returns 'failed' when listMyCourses itself blows up", async () => {
    const fix = makeFixture();
    const { provider } = makeProvider({
      listCoursesError: new Error("upstream_5xx"),
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("failed");
    expect(result.errors[0]).toMatchObject({
      scope: "connection",
      message: "upstream_5xx",
    });
    expect(fix.auditActions).toContain("lms.sync.failed");
  });
});

describe("runLmsReconciliation — faculty / TA without a Hub user", () => {
  it("records a per-row error and does not auto-create a faculty account", async () => {
    const fix = makeFixture();
    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "Course 1",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: {
        C1: [
          {
            external_id: "Eteach",
            external_course_id: "C1",
            external_user_id: "u-teach",
            email: "professor@example.edu",
            name: "Professor",
            role: "faculty",
          },
        ],
      },
    });

    const result = await run(fix, provider);

    expect(result.status).toBe("partial");
    // No user / student row should have been created.
    expect(fix.users).toHaveLength(0);
    expect(fix.students).toHaveLength(0);
    expect(result.errors[0]).toMatchObject({ scope: "enrollment" });
    expect(result.errors[0]?.message).toContain("no_hub_user_for_faculty");
  });
});

describe("runLmsReconciliation — audit log coverage", () => {
  it("emits started + course.imported + student.imported + enrollment.imported + completed", async () => {
    const fix = makeFixture();
    const { provider } = makeProvider({
      courses: [
        {
          external_id: "C1",
          external_term_id: "T1",
          name: "Course 1",
          code: null,
          description: null,
        },
      ],
      enrollmentsByCourse: {
        C1: [
          {
            external_id: "E1",
            external_course_id: "C1",
            external_user_id: "u1",
            email: "student@example.edu",
            name: "Student",
            role: "student",
          },
        ],
      },
    });

    await run(fix, provider);

    const expected = [
      "lms.sync.started",
      "lms.sync.course.imported",
      "lms.sync.student.imported",
      "lms.sync.enrollment.imported",
      "lms.sync.completed",
    ];
    for (const action of expected) {
      expect(fix.auditActions).toContain(action);
    }
    // Critical invariant: NO `invitation.sent` or similar email-bearing
    // action shows up. We only check that an `invitation.*` action is
    // not present — the engine never reaches the invitations subsystem.
    expect(
      fix.auditActions.some((a) => a.startsWith("invitation.")),
    ).toBe(false);
  });
});
