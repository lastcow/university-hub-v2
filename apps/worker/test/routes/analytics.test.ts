// Route tests for the faculty course-analytics endpoints (UNI-31).
//
// Focus areas:
//   - Faculty-only RBAC: teacher / TA / student / staff are rejected even
//     when assigned to the course.
//   - Per-course scoping (sub-issue UNI-22): faculty assigned to course A
//     can read course-A analytics but not course B.
//   - Small-N suppression: aggregates over fewer than ANALYTICS_MIN_N
//     students return `{ suppressed: true }` envelopes; aggregates above
//     the threshold return numeric stats.
//   - Audit logging: every successful read writes one `analytics.viewed`
//     row with the course id (and assessment id, when applicable) and the
//     resolved population sizes.
//   - Mismatched assessment/course id returns 404, not the wrong slice.

import { describe, expect, it } from "vitest";

import type { Env } from "../../src/env.js";
import type { AuthState, RequestContext } from "../../src/middleware/auth.js";
import type { UserRow } from "../../src/auth/session.js";
import {
  handleAssessmentAnalyticsSummary,
  handleCourseAnalyticsSummary,
} from "../../src/routes/analytics.js";
import { ProgrammableD1 } from "../helpers/programmable-d1.js";

const UNI_A = "11111111-1111-1111-1111-111111111111";
const UNI_B = "22222222-2222-2222-2222-222222222222";

const COURSE_A1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01";
const COURSE_B1 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01";

const SUPER_ADMIN_ID = "55555555-0000-0000-0000-000000000001";
const FACULTY_A_ID = "55555555-0000-0000-0000-000000000010";
const FACULTY_B_ID = "55555555-0000-0000-0000-000000000011";
const TEACHER_A_ID = "55555555-0000-0000-0000-000000000020";
const TA_A_ID = "55555555-0000-0000-0000-000000000030";

const ASSESSMENT_HW = "66666666-aaaa-0000-0000-000000000001";
const ASSESSMENT_MIDTERM = "66666666-aaaa-0000-0000-000000000002";
const ASSESSMENT_OTHER_COURSE = "66666666-bbbb-0000-0000-000000000099";

const TS = "2026-05-04T00:00:00.000Z";

interface Assessment {
  id: string;
  course_id: string;
  title: string;
  weight: number;
  max_score: number;
  due_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface Grade {
  id: string;
  assessment_id: string;
  student_user_id: string;
  score: number | null;
  status: "graded" | "pending" | "excused";
}

function user(
  id: string,
  role: UserRow["role"],
  university_id: string | null,
): UserRow {
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
  facultyA: user(FACULTY_A_ID, "faculty", UNI_A),
  facultyB: user(FACULTY_B_ID, "faculty", UNI_A), // same uni, different course
  teacherA: user(TEACHER_A_ID, "teacher", UNI_A),
  taA: user(TA_A_ID, "teacher_assistant", UNI_A),
};

interface FixtureOptions {
  /** Override `ANALYTICS_MIN_N` (default 5). */
  minN?: string;
  /** Override `ANALYTICS_PASS_THRESHOLD_PCT` (default 60). */
  passThresholdPct?: string;
  /** Pre-seeded assessments. */
  assessments?: readonly Assessment[];
  /** Pre-seeded grades. */
  grades?: readonly Grade[];
  /** Pre-seeded enrollment count. */
  enrolled?: number;
}

function seedFixture(opts: FixtureOptions = {}) {
  const db = new ProgrammableD1();
  const courses = new Map([
    [COURSE_A1, { id: COURSE_A1, university_id: UNI_A, name: "Course A1", code: "A1" }],
    [COURSE_B1, { id: COURSE_B1, university_id: UNI_B, name: "Course B1", code: "B1" }],
  ]);
  const assessments = new Map<string, Assessment>(
    (opts.assessments ?? []).map((a) => [a.id, a]),
  );
  const grades = opts.grades ?? [];
  const enrolled = opts.enrolled ?? 0;
  const assignments = new Map<
    string,
    { course_id: string; user_id: string; role: string }
  >([
    ["a1", { course_id: COURSE_A1, user_id: FACULTY_A_ID, role: "faculty" }],
    ["a2", { course_id: COURSE_A1, user_id: TEACHER_A_ID, role: "teacher" }],
    ["a3", { course_id: COURSE_A1, user_id: TA_A_ID, role: "teacher_assistant" }],
    ["a4", { course_id: COURSE_B1, user_id: FACULTY_B_ID, role: "faculty" }],
  ]);

  db.onFirst((sql, params) => {
    const s = sql.toLowerCase();
    if (s.startsWith("select id, university_id from courses where id = ?")) {
      const c = courses.get(String(params[0]));
      return c ? { id: c.id, university_id: c.university_id } : null;
    }
    if (s.startsWith("select id, name, code, university_id from courses where id = ?")) {
      return courses.get(String(params[0])) ?? null;
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
      s.startsWith("select id, course_id, title, weight, max_score, due_at, deleted_at from assessments where id = ?")
    ) {
      return assessments.get(String(params[0])) ?? null;
    }
    if (s.startsWith("select count(1) as c from course_assignments")) {
      return { c: enrolled };
    }
    return undefined;
  });

  db.onAll((sql, params) => {
    const s = sql.toLowerCase();
    if (
      s.startsWith("select id, course_id, title, weight, max_score, due_at from assessments")
    ) {
      const courseId = String(params[0]);
      return Array.from(assessments.values())
        .filter((a) => a.course_id === courseId && !a.deleted_at);
    }
    if (
      s.startsWith("select g.assessment_id, g.student_user_id, g.score, g.status from grades g join assessments a")
    ) {
      const courseId = String(params[0]);
      return grades.filter((g) => {
        if (g.status !== "graded" || g.score === null) return false;
        const a = assessments.get(g.assessment_id);
        return a !== undefined && a.course_id === courseId && !a.deleted_at;
      });
    }
    if (
      s.startsWith("select g.assessment_id, g.student_user_id, g.score, g.status from grades g where g.assessment_id = ?")
    ) {
      const assessmentId = String(params[0]);
      return grades.filter(
        (g) => g.assessment_id === assessmentId && g.status === "graded" && g.score !== null,
      );
    }
    return undefined;
  });

  function makeCtx(
    actor: UserRow,
    init: { method?: string; pathname?: string } = {},
  ): RequestContext {
    const url = new URL(`https://hub.example.com${init.pathname ?? "/api/test"}`);
    const env: Env = {
      DB: db as unknown as D1Database,
      APP_NAME: "University Hub",
      APP_BASE_URL: "https://hub.example.com",
      SESSION_COOKIE_NAME: "university_hub_session",
      ANALYTICS_MIN_N: opts.minN,
      ANALYTICS_PASS_THRESHOLD_PCT: opts.passThresholdPct,
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
    return {
      request: new Request(url, { method: init.method ?? "GET" }),
      env,
      url,
      cookies: {},
      auth,
    };
  }

  return { db, makeCtx };
}

async function asJson(res: Response): Promise<{ data: any }> {
  return (await res.clone().json()) as { data: any };
}

// ---------------------------------------------------------------------------
// Course summary
// ---------------------------------------------------------------------------

describe("UNI-31 / GET /api/courses/:id/analytics/summary — RBAC + scoping", () => {
  it("faculty assigned to course succeeds and writes analytics.viewed audit row", async () => {
    const fix = seedFixture({
      enrolled: 6,
      assessments: [hw1()],
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 80),
        graded("g2", ASSESSMENT_HW, "stud-2", 90),
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
        graded("g4", ASSESSMENT_HW, "stud-4", 100),
        graded("g5", ASSESSMENT_HW, "stud-5", 50),
        graded("g6", ASSESSMENT_HW, "stud-6", 65),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.data.total_enrolled).toBe(6);
    expect(body.data.total_graded).toBe(6);
    expect(body.data.course_total_stats.suppressed).toBe(false);

    const audits = fix.db.inserts("audit_logs");
    const row = audits.find((e) => e.params.includes("analytics.viewed"));
    expect(row).toBeDefined();
    const meta = JSON.parse(String(row?.params[6] ?? "{}")) as {
      scope?: string;
      total_graded?: number;
      suppressed?: boolean;
    };
    expect(meta.scope).toBe("course_summary");
    expect(meta.total_graded).toBe(6);
    expect(meta.suppressed).toBe(false);
  });

  it("faculty NOT assigned to course gets 404 (per-course scoping helper)", async () => {
    const fix = seedFixture({ enrolled: 6, assessments: [hw1()] });
    const ctx = fix.makeCtx(ACTORS.facultyB, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    expect(res.status).toBe(404);
    expect(fix.db.inserts("audit_logs")).toHaveLength(0);
  });

  it("teacher assigned to course is rejected (faculty-only by spec)", async () => {
    const fix = seedFixture({ enrolled: 6, assessments: [hw1()] });
    const ctx = fix.makeCtx(ACTORS.teacherA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    expect(res.status).toBe(403);
    expect(fix.db.inserts("audit_logs")).toHaveLength(0);
  });

  it("teacher_assistant assigned to course is rejected (faculty-only by spec)", async () => {
    const fix = seedFixture({ enrolled: 6, assessments: [hw1()] });
    const ctx = fix.makeCtx(ACTORS.taA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    expect(res.status).toBe(403);
  });

  it("super_admin bypasses the helper and succeeds", async () => {
    const fix = seedFixture({ enrolled: 0, assessments: [] });
    const ctx = fix.makeCtx(ACTORS.superAdmin, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    expect(res.status).toBe(200);
  });
});

describe("UNI-31 / small-N suppression", () => {
  it("course-total aggregate over <5 students comes back suppressed", async () => {
    const fix = seedFixture({
      enrolled: 4,
      assessments: [hw1()],
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 80),
        graded("g2", ASSESSMENT_HW, "stud-2", 90),
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
        graded("g4", ASSESSMENT_HW, "stud-4", 100),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    expect(res.status).toBe(200);
    const body = await asJson(res);

    expect(body.data.total_graded).toBe(4);
    expect(body.data.course_total_stats).toEqual({
      suppressed: true,
      reason: "insufficient_population",
      n: 4,
    });
    expect(body.data.course_total_histogram).toEqual({
      suppressed: true,
      reason: "insufficient_population",
      n: 4,
    });
    // The audit row should record that this view was suppressed.
    const audits = fix.db.inserts("audit_logs");
    const meta = JSON.parse(String(audits[0]?.params[6] ?? "{}")) as {
      suppressed?: boolean;
    };
    expect(meta.suppressed).toBe(true);
  });

  it("ANALYTICS_MIN_N override loosens suppression to N=3", async () => {
    const fix = seedFixture({
      minN: "3",
      enrolled: 4,
      assessments: [hw1()],
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 80),
        graded("g2", ASSESSMENT_HW, "stud-2", 90),
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    const body = await asJson(res);
    expect(body.data.min_n).toBe(3);
    expect(body.data.course_total_stats.suppressed).toBe(false);
    expect(body.data.course_total_stats.n).toBe(3);
  });

  it("per-assessment slice is suppressed independently of course total", async () => {
    const fix = seedFixture({
      enrolled: 8,
      assessments: [hw1(), midterm()],
      grades: [
        // 7 students graded on HW1 → above threshold
        graded("g1", ASSESSMENT_HW, "stud-1", 80),
        graded("g2", ASSESSMENT_HW, "stud-2", 90),
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
        graded("g4", ASSESSMENT_HW, "stud-4", 100),
        graded("g5", ASSESSMENT_HW, "stud-5", 50),
        graded("g6", ASSESSMENT_HW, "stud-6", 65),
        graded("g7", ASSESSMENT_HW, "stud-7", 85),
        // Only 2 students have a graded midterm row → below threshold
        graded("g8", ASSESSMENT_MIDTERM, "stud-1", 95),
        graded("g9", ASSESSMENT_MIDTERM, "stud-2", 88),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    const body = await asJson(res);
    const hw = body.data.assessments.find(
      (a: { assessment_id: string }) => a.assessment_id === ASSESSMENT_HW,
    );
    const mid = body.data.assessments.find(
      (a: { assessment_id: string }) => a.assessment_id === ASSESSMENT_MIDTERM,
    );
    expect(hw.stats.suppressed).toBe(false);
    expect(hw.stats.n).toBe(7);
    expect(mid.stats.suppressed).toBe(true);
    expect(mid.stats.n).toBe(2);
  });
});

describe("UNI-31 / aggregate correctness", () => {
  it("computes mean / median / stddev / pass-rate over the population", async () => {
    const fix = seedFixture({
      enrolled: 6,
      assessments: [hw1()], // max_score 100
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 50), // 50% — fails
        graded("g2", ASSESSMENT_HW, "stud-2", 60), // 60% — passes
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
        graded("g4", ASSESSMENT_HW, "stud-4", 80),
        graded("g5", ASSESSMENT_HW, "stud-5", 90),
        graded("g6", ASSESSMENT_HW, "stud-6", 100),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    const body = await asJson(res);
    const hw = body.data.assessments[0];
    expect(hw.stats.suppressed).toBe(false);
    expect(hw.stats.mean).toBeCloseTo(75, 1); // (50+60+70+80+90+100)/6
    expect(hw.stats.median).toBeCloseTo(75, 1);
    expect(hw.stats.min).toBe(50);
    expect(hw.stats.max).toBe(100);
    expect(hw.stats.pass_rate).toBeCloseTo(5 / 6, 3); // 5 of 6 ≥ 60%
    expect(hw.stats.pass_threshold_pct).toBe(60);

    const totals = hw.histogram.buckets.reduce(
      (acc: number, b: { count: number }) => acc + b.count,
      0,
    );
    expect(totals).toBe(6);
    // Bucket sanity: 50 lands in F (0-60), 60-69 in D, 70-79 in C, 80-89 in
    // B, 90-100 in A — both 90 and 100 land in A so the A bucket has 2.
    const f = hw.histogram.buckets.find((b: { letter: string }) => b.letter === "F");
    const d = hw.histogram.buckets.find((b: { letter: string }) => b.letter === "D");
    const a = hw.histogram.buckets.find((b: { letter: string }) => b.letter === "A");
    expect(f.count).toBe(1);
    expect(d.count).toBe(1);
    expect(a.count).toBe(2);
  });

  it("ANALYTICS_PASS_THRESHOLD_PCT override changes the pass-rate boundary", async () => {
    const fix = seedFixture({
      passThresholdPct: "70",
      enrolled: 6,
      assessments: [hw1()],
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 50),
        graded("g2", ASSESSMENT_HW, "stud-2", 60),
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
        graded("g4", ASSESSMENT_HW, "stud-4", 80),
        graded("g5", ASSESSMENT_HW, "stud-5", 90),
        graded("g6", ASSESSMENT_HW, "stud-6", 100),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/summary`,
    });
    const res = await handleCourseAnalyticsSummary(ctx, COURSE_A1);
    const body = await asJson(res);
    const hw = body.data.assessments[0];
    expect(hw.stats.pass_threshold_pct).toBe(70);
    expect(hw.stats.pass_rate).toBeCloseTo(4 / 6, 3); // 70/80/90/100 pass
  });
});

// ---------------------------------------------------------------------------
// Per-assessment endpoint
// ---------------------------------------------------------------------------

describe("UNI-31 / GET /api/courses/:id/analytics/assessment/:aid", () => {
  it("faculty on course can read per-assessment analytics", async () => {
    const fix = seedFixture({
      enrolled: 6,
      assessments: [hw1()],
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 80),
        graded("g2", ASSESSMENT_HW, "stud-2", 90),
        graded("g3", ASSESSMENT_HW, "stud-3", 70),
        graded("g4", ASSESSMENT_HW, "stud-4", 100),
        graded("g5", ASSESSMENT_HW, "stud-5", 50),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/assessment/${ASSESSMENT_HW}`,
    });
    const res = await handleAssessmentAnalyticsSummary(
      ctx,
      COURSE_A1,
      ASSESSMENT_HW,
    );
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.data.assessment_id).toBe(ASSESSMENT_HW);
    expect(body.data.total_graded).toBe(5);
    expect(body.data.stats.suppressed).toBe(false);

    const audits = fix.db.inserts("audit_logs");
    const meta = JSON.parse(String(audits[0]?.params[6] ?? "{}")) as {
      scope?: string;
      course_id?: string;
    };
    expect(meta.scope).toBe("assessment_summary");
    expect(meta.course_id).toBe(COURSE_A1);
  });

  it("returns 404 when the assessment belongs to a different course", async () => {
    const fix = seedFixture({
      enrolled: 6,
      assessments: [
        // Same id, course mismatch — analytics handler must refuse to slice
        // a foreign assessment under this course.
        {
          ...hw1(),
          id: ASSESSMENT_OTHER_COURSE,
          course_id: COURSE_B1,
        },
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/assessment/${ASSESSMENT_OTHER_COURSE}`,
    });
    const res = await handleAssessmentAnalyticsSummary(
      ctx,
      COURSE_A1,
      ASSESSMENT_OTHER_COURSE,
    );
    expect(res.status).toBe(404);
    expect(fix.db.inserts("audit_logs")).toHaveLength(0);
  });

  it("teacher on the course is rejected (faculty-only)", async () => {
    const fix = seedFixture({
      enrolled: 6,
      assessments: [hw1()],
      grades: [graded("g1", ASSESSMENT_HW, "stud-1", 80)],
    });
    const ctx = fix.makeCtx(ACTORS.teacherA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/assessment/${ASSESSMENT_HW}`,
    });
    const res = await handleAssessmentAnalyticsSummary(
      ctx,
      COURSE_A1,
      ASSESSMENT_HW,
    );
    expect(res.status).toBe(403);
  });

  it("suppresses when the per-assessment graded population is below ANALYTICS_MIN_N", async () => {
    const fix = seedFixture({
      enrolled: 10,
      assessments: [hw1()],
      grades: [
        graded("g1", ASSESSMENT_HW, "stud-1", 80),
        graded("g2", ASSESSMENT_HW, "stud-2", 90),
      ],
    });
    const ctx = fix.makeCtx(ACTORS.facultyA, {
      pathname: `/api/courses/${COURSE_A1}/analytics/assessment/${ASSESSMENT_HW}`,
    });
    const res = await handleAssessmentAnalyticsSummary(
      ctx,
      COURSE_A1,
      ASSESSMENT_HW,
    );
    expect(res.status).toBe(200);
    const body = await asJson(res);
    expect(body.data.stats).toEqual({
      suppressed: true,
      reason: "insufficient_population",
      n: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hw1(): Assessment {
  return {
    id: ASSESSMENT_HW,
    course_id: COURSE_A1,
    title: "Homework 1",
    weight: 0.1,
    max_score: 100,
    due_at: null,
    deleted_at: null,
    created_at: TS,
  };
}

function midterm(): Assessment {
  return {
    id: ASSESSMENT_MIDTERM,
    course_id: COURSE_A1,
    title: "Midterm",
    weight: 0.4,
    max_score: 100,
    due_at: null,
    deleted_at: null,
    created_at: TS,
  };
}

function graded(
  id: string,
  assessmentId: string,
  studentUserId: string,
  score: number,
): Grade {
  return {
    id,
    assessment_id: assessmentId,
    student_user_id: studentUserId,
    score,
    status: "graded",
  };
}
