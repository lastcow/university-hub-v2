// Faculty course-analytics endpoints (epic UNI-21 / sub-issue UNI-31).
//
//   GET /api/courses/:id/analytics/summary
//     Course-level aggregates: total enrolled, total graded, mean / median /
//     stddev / min / max, pass rate, grade-distribution histogram, plus a
//     per-assessment slice with the same fields.
//
//   GET /api/courses/:id/analytics/assessment/:aid
//     Same shape, scoped to a single assessment.
//
// Both endpoints are gated by `assertActorOnCourse` for `faculty`-only access
// (admins still bypass per the scoping helper convention). Teacher and TA
// roles are intentionally rejected here even when assigned to the course —
// the spec is faculty-only by default. If an institution wants TAs in, they
// flip the allow-list in this one place.
//
// Aggregates are not row-level data, but they can still re-identify students
// in tiny populations. Every aggregate goes through `suppressIf(n < min_n)`
// before reaching the wire — when the underlying graded population is below
// `ANALYTICS_MIN_N` (default 5) the value is replaced with
// `{ suppressed: true, reason: "insufficient_population", n }`. This is
// per-aggregate, so a course with 3 students sees its course-total stats AND
// every assessment slice come back suppressed; an assessment with 4 graded
// students inside a 30-student course only suppresses that slice.
//
// Every successful read writes one `analytics.viewed` audit row with the
// course id, optional assessment id, and the resolved population sizes — so
// the FERPA reviewer can see exactly which faculty pulled which slice and
// when, without having to expand a per-grade-row disclosure log (analytics
// don't disclose individual rows; the audit log is the right surface).

import type {
  AnalyticsAggregate,
  AnalyticsHistogram,
  AnalyticsHistogramBucket,
  AnalyticsSummaryStats,
  AssessmentAnalyticsSummary,
  CourseAnalyticsAssessmentSlice,
  CourseAnalyticsSummary,
} from "@university-hub/shared";
import { ANALYTICS_HISTOGRAM_BUCKETS } from "@university-hub/shared";

import { queryAll, queryFirst, type Row } from "../db/index.js";
import {
  CourseScopeError,
  assertActorOnCourse,
  courseScopeErrorResponse,
  toActor,
} from "../db/scoped.js";
import { requireAuth, type RequestContext } from "../middleware/auth.js";
import { writeAuditLog } from "../services/audit.js";
import type { Env } from "../env.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

// ---------------------------------------------------------------------------
// Env-driven knobs
// ---------------------------------------------------------------------------

const DEFAULT_MIN_N = 5;
const DEFAULT_PASS_THRESHOLD_PCT = 60;

function analyticsMinN(env: Env): number {
  const raw = env.ANALYTICS_MIN_N;
  if (!raw) return DEFAULT_MIN_N;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MIN_N;
  return n;
}

function analyticsPassThresholdPct(env: Env): number {
  const raw = env.ANALYTICS_PASS_THRESHOLD_PCT;
  if (!raw) return DEFAULT_PASS_THRESHOLD_PCT;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_PASS_THRESHOLD_PCT;
  return n;
}

// ---------------------------------------------------------------------------
// DB row shapes
// ---------------------------------------------------------------------------

type CourseRow = Row & {
  id: string;
  name: string | null;
  code: string | null;
  university_id: string | null;
};

type AssessmentRow = Row & {
  id: string;
  course_id: string;
  title: string;
  weight: number;
  max_score: number;
  due_at: string | null;
};

type GradeRow = Row & {
  assessment_id: string;
  student_user_id: string;
  score: number | null;
  status: string;
};

// ---------------------------------------------------------------------------
// Aggregation primitives
// ---------------------------------------------------------------------------

interface ScoredPoint {
  /** Score in absolute terms (0..maxScore for that point's denominator). */
  score: number;
  /** The denominator the score is out of. Carried per-point so a
   *  course-total roll-up can mix assessments with different max_scores. */
  maxScore: number;
}

function pctOfMax(point: ScoredPoint): number {
  if (point.maxScore <= 0) return 0;
  return (point.score / point.maxScore) * 100;
}

/**
 * Statistics over a population of `ScoredPoint`s. Returns `null` when the
 * population is empty (caller maps that to a `total_graded: 0` outcome
 * before suppression — empty and "fewer than N" are different signals).
 */
function computeStats(
  points: ScoredPoint[],
  passThresholdPct: number,
): AnalyticsSummaryStats | null {
  if (points.length === 0) return null;

  const scores = points.map((p) => p.score);
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = scores.reduce((acc, x) => acc + x, 0);
  const mean = sum / scores.length;

  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : sorted[mid] ?? 0;

  const variance =
    scores.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / scores.length;
  const stddev = Math.sqrt(variance);

  // Mean as a percentage of the population's denominator. When points have
  // varying denominators (course total) we average the percentages directly
  // so a 90% on a 10-point quiz weighs the same per row as a 90% on a 100-
  // point exam (the weight system handles "more important assessments").
  const meanPct =
    points.reduce((acc, p) => acc + pctOfMax(p), 0) / points.length;

  // Pass rate: count points whose percentage meets or exceeds the threshold.
  const passing = points.filter((p) => pctOfMax(p) >= passThresholdPct).length;

  return {
    mean: round(mean, 2),
    median: round(median, 2),
    stddev: round(stddev, 2),
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    mean_pct: round(meanPct, 2),
    pass_rate: round(passing / points.length, 4),
    pass_threshold_pct: passThresholdPct,
  };
}

/** Round to `places` decimals to keep the wire payload tidy. */
function round(n: number, places: number): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

/**
 * Bucket the population into the fixed letter-grade ranges. Empty histograms
 * still emit zeroed buckets so the chart axis stays consistent.
 */
function computeHistogram(points: ScoredPoint[]): AnalyticsHistogram {
  const buckets: AnalyticsHistogramBucket[] = ANALYTICS_HISTOGRAM_BUCKETS.map(
    (b) => ({ ...b, count: 0 }),
  );
  for (const point of points) {
    const pct = pctOfMax(point);
    for (const bucket of buckets) {
      if (pct >= bucket.min_pct && pct < bucket.max_pct) {
        bucket.count += 1;
        break;
      }
    }
  }
  return { buckets };
}

/**
 * Wrap a value in a suppression envelope when the underlying population is
 * below `minN`. The shape mirrors what the frontend expects so the type
 * boundary is the only thing it has to discriminate on.
 */
function suppress<T>(
  value: T,
  n: number,
  minN: number,
): AnalyticsAggregate<T> {
  if (n < minN) {
    return { suppressed: true, reason: "insufficient_population", n };
  }
  return { suppressed: false, n, ...value };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function loadCourse(
  db: D1Database,
  courseId: string,
): Promise<CourseRow | null> {
  return queryFirst<CourseRow>(
    db,
    `SELECT id, name, code, university_id FROM courses WHERE id = ? LIMIT 1`,
    [courseId],
  );
}

async function listAssessments(
  db: D1Database,
  courseId: string,
): Promise<AssessmentRow[]> {
  return queryAll<AssessmentRow>(
    db,
    `SELECT id, course_id, title, weight, max_score, due_at
       FROM assessments
       WHERE course_id = ? AND deleted_at IS NULL
       ORDER BY due_at IS NULL, due_at ASC, created_at ASC`,
    [courseId],
  );
}

async function loadAssessment(
  db: D1Database,
  assessmentId: string,
): Promise<(AssessmentRow & { deleted_at: string | null }) | null> {
  return queryFirst<AssessmentRow & { deleted_at: string | null }>(
    db,
    `SELECT id, course_id, title, weight, max_score, due_at, deleted_at
       FROM assessments WHERE id = ? LIMIT 1`,
    [assessmentId],
  );
}

async function listGradedRowsForCourse(
  db: D1Database,
  courseId: string,
): Promise<GradeRow[]> {
  return queryAll<GradeRow>(
    db,
    `SELECT g.assessment_id, g.student_user_id, g.score, g.status
       FROM grades g
       JOIN assessments a ON a.id = g.assessment_id
      WHERE a.course_id = ?
        AND a.deleted_at IS NULL
        AND g.status = 'graded'
        AND g.score IS NOT NULL`,
    [courseId],
  );
}

async function listGradedRowsForAssessment(
  db: D1Database,
  assessmentId: string,
): Promise<GradeRow[]> {
  return queryAll<GradeRow>(
    db,
    `SELECT g.assessment_id, g.student_user_id, g.score, g.status
       FROM grades g
      WHERE g.assessment_id = ?
        AND g.status = 'graded'
        AND g.score IS NOT NULL`,
    [assessmentId],
  );
}

async function countEnrolled(
  db: D1Database,
  courseId: string,
): Promise<number> {
  const row = await queryFirst<{ c: number } & Row>(
    db,
    `SELECT COUNT(1) AS c FROM course_assignments
       WHERE course_id = ? AND role = 'student'`,
    [courseId],
  );
  return Number(row?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

/**
 * Build the per-assessment slice. `n` is "students with a graded row on this
 * assessment" — suppression cuts in below `minN` independently from the
 * course-total roll-up.
 */
function buildAssessmentSlice(
  assessment: AssessmentRow,
  graded: GradeRow[],
  minN: number,
  passThresholdPct: number,
): CourseAnalyticsAssessmentSlice {
  const points: ScoredPoint[] = graded.map((g) => ({
    score: Number(g.score ?? 0),
    maxScore: Number(assessment.max_score),
  }));
  const stats = computeStats(points, passThresholdPct) ?? {
    mean: 0,
    median: 0,
    stddev: 0,
    min: 0,
    max: 0,
    mean_pct: 0,
    pass_rate: 0,
    pass_threshold_pct: passThresholdPct,
  };
  const histogram = computeHistogram(points);
  return {
    assessment_id: assessment.id,
    title: assessment.title,
    weight: Number(assessment.weight),
    max_score: Number(assessment.max_score),
    due_at: assessment.due_at,
    stats: suppress(stats, points.length, minN),
    histogram: suppress(histogram, points.length, minN),
  };
}

/**
 * Compute a "course total" per student: percentage of max across the
 * assessments that student has been graded on. Mixing differently-weighted
 * assessments would normally require carrying the weight column through; for
 * a course-total view weighted by the assessment.weight column we sum
 *   sum(score / max_score * weight) / sum(weight_of_assessments_graded)
 * per student so the result is a 0..1 aggregate that's still meaningful when
 * a student has only completed half the course's assessments.
 */
function buildCoursePoints(
  assessments: AssessmentRow[],
  graded: GradeRow[],
): { points: ScoredPoint[]; nStudents: number } {
  const assessmentById = new Map<string, AssessmentRow>(
    assessments.map((a) => [a.id, a]),
  );
  // Group grades by student.
  const byStudent = new Map<
    string,
    { weightedSum: number; weightTotal: number }
  >();
  for (const g of graded) {
    const a = assessmentById.get(g.assessment_id);
    if (!a) continue;
    const max = Number(a.max_score);
    if (max <= 0) continue;
    const weight = Number(a.weight) || 0;
    // When all assessments have weight 0, fall back to equal weighting so
    // the course-total view still shows a meaningful distribution. Without
    // this, every student's points collapse to NaN.
    const effectiveWeight = weight > 0 ? weight : 1;
    const ratio = Number(g.score ?? 0) / max;
    const cur = byStudent.get(g.student_user_id) ?? {
      weightedSum: 0,
      weightTotal: 0,
    };
    cur.weightedSum += ratio * effectiveWeight;
    cur.weightTotal += effectiveWeight;
    byStudent.set(g.student_user_id, cur);
  }
  const points: ScoredPoint[] = [];
  for (const { weightedSum, weightTotal } of byStudent.values()) {
    if (weightTotal <= 0) continue;
    const pct = (weightedSum / weightTotal) * 100;
    points.push({ score: pct, maxScore: 100 });
  }
  return { points, nStudents: byStudent.size };
}

// ---------------------------------------------------------------------------
// GET /api/courses/:id/analytics/summary
// ---------------------------------------------------------------------------

export async function handleCourseAnalyticsSummary(
  ctx: RequestContext,
  courseId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  // Faculty-only by spec; admins also bypass via the scoping helper.
  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Faculty role required to view course analytics.",
    );
  }

  let universityId: string | null;
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      courseId,
      ["faculty"],
    );
    universityId = result.universityId;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  const minN = analyticsMinN(ctx.env);
  const passThreshold = analyticsPassThresholdPct(ctx.env);

  const [course, assessments, gradedRows, totalEnrolled] = await Promise.all([
    loadCourse(ctx.env.DB, courseId),
    listAssessments(ctx.env.DB, courseId),
    listGradedRowsForCourse(ctx.env.DB, courseId),
    countEnrolled(ctx.env.DB, courseId),
  ]);
  // Course existed (the scoping helper just confirmed it). Defensive null.
  if (!course) {
    return errorResponse(404, "not_found", "Course not found.");
  }

  // Course total — one point per *student*, weighted by assessment.weight.
  const { points: coursePoints, nStudents } = buildCoursePoints(
    assessments,
    gradedRows,
  );
  const courseStats = computeStats(coursePoints, passThreshold) ?? {
    mean: 0,
    median: 0,
    stddev: 0,
    min: 0,
    max: 0,
    mean_pct: 0,
    pass_rate: 0,
    pass_threshold_pct: passThreshold,
  };
  const courseHistogram = computeHistogram(coursePoints);

  // Per-assessment slices.
  const gradedByAssessment = new Map<string, GradeRow[]>();
  for (const g of gradedRows) {
    const list = gradedByAssessment.get(g.assessment_id) ?? [];
    list.push(g);
    gradedByAssessment.set(g.assessment_id, list);
  }
  const slices: CourseAnalyticsAssessmentSlice[] = assessments.map((a) =>
    buildAssessmentSlice(
      a,
      gradedByAssessment.get(a.id) ?? [],
      minN,
      passThreshold,
    ),
  );

  const summary: CourseAnalyticsSummary = {
    course_id: course.id,
    course_name: course.name,
    course_code: course.code,
    university_id: course.university_id,
    total_enrolled: totalEnrolled,
    total_graded: nStudents,
    min_n: minN,
    generated_at: new Date().toISOString(),
    course_total_stats: suppress(courseStats, nStudents, minN),
    course_total_histogram: suppress(courseHistogram, nStudents, minN),
    assessments: slices,
  };

  await writeAuditLog(ctx.env.DB, {
    action: "analytics.viewed",
    actorUserId: actor.id,
    universityId,
    entityType: "course",
    entityId: courseId,
    metadata: {
      scope: "course_summary",
      total_enrolled: totalEnrolled,
      total_graded: nStudents,
      assessments: assessments.length,
      min_n: minN,
      suppressed: nStudents < minN,
    },
  });

  return jsonOk(summary);
}

// ---------------------------------------------------------------------------
// GET /api/courses/:id/analytics/assessment/:aid
// ---------------------------------------------------------------------------

export async function handleAssessmentAnalyticsSummary(
  ctx: RequestContext,
  courseId: string,
  assessmentId: string,
): Promise<Response> {
  const auth = requireAuth(ctx);
  if (auth instanceof Response) return auth;
  const actor = auth.user;

  if (
    actor.role !== "super_admin" &&
    actor.role !== "university_admin" &&
    actor.role !== "faculty"
  ) {
    return errorResponse(
      403,
      "forbidden",
      "Faculty role required to view course analytics.",
    );
  }

  let universityId: string | null;
  try {
    const result = await assertActorOnCourse(
      ctx.env.DB,
      toActor(actor),
      courseId,
      ["faculty"],
    );
    universityId = result.universityId;
  } catch (err) {
    if (err instanceof CourseScopeError) return courseScopeErrorResponse(err);
    throw err;
  }

  const assessment = await loadAssessment(ctx.env.DB, assessmentId);
  if (!assessment || assessment.deleted_at || assessment.course_id !== courseId) {
    // Mismatched course id is a 404 (not a 400) because the caller should
    // not be able to probe assessment ids belonging to other courses.
    return errorResponse(404, "not_found", "Assessment not found.");
  }

  const minN = analyticsMinN(ctx.env);
  const passThreshold = analyticsPassThresholdPct(ctx.env);

  const [course, gradedRows, totalEnrolled] = await Promise.all([
    loadCourse(ctx.env.DB, courseId),
    listGradedRowsForAssessment(ctx.env.DB, assessmentId),
    countEnrolled(ctx.env.DB, courseId),
  ]);
  if (!course) {
    return errorResponse(404, "not_found", "Course not found.");
  }

  const points: ScoredPoint[] = gradedRows.map((g) => ({
    score: Number(g.score ?? 0),
    maxScore: Number(assessment.max_score),
  }));
  const stats = computeStats(points, passThreshold) ?? {
    mean: 0,
    median: 0,
    stddev: 0,
    min: 0,
    max: 0,
    mean_pct: 0,
    pass_rate: 0,
    pass_threshold_pct: passThreshold,
  };
  const histogram = computeHistogram(points);

  const summary: AssessmentAnalyticsSummary = {
    course_id: course.id,
    course_name: course.name,
    course_code: course.code,
    university_id: course.university_id,
    total_enrolled: totalEnrolled,
    total_graded: points.length,
    min_n: minN,
    generated_at: new Date().toISOString(),
    assessment_id: assessment.id,
    title: assessment.title,
    weight: Number(assessment.weight),
    max_score: Number(assessment.max_score),
    due_at: assessment.due_at,
    stats: suppress(stats, points.length, minN),
    histogram: suppress(histogram, points.length, minN),
  };

  await writeAuditLog(ctx.env.DB, {
    action: "analytics.viewed",
    actorUserId: actor.id,
    universityId,
    entityType: "assessment",
    entityId: assessmentId,
    metadata: {
      scope: "assessment_summary",
      course_id: courseId,
      total_enrolled: totalEnrolled,
      total_graded: points.length,
      min_n: minN,
      suppressed: points.length < minN,
    },
  });

  return jsonOk(summary);
}
