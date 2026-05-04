// Faculty course-analytics types (epic UNI-21 / sub-issue UNI-31).
//
// Aggregates only — no row-level student data crosses this boundary. When the
// underlying population is below `ANALYTICS_MIN_N` (default 5) the worker
// returns a `SuppressedAggregate` instead of the numeric values. The shape
// is discriminated on the `suppressed` field so the UI can render the
// "not enough students" empty state uniformly.

import type { Id, IsoDateString } from "./common.js";

/**
 * The histogram bucket boundaries used by the worker for grade distributions
 * (percent of max score). Mirrored on the client so the chart axis can be
 * pre-labelled without round-tripping the schema.
 *
 *   0-59 (F) | 60-69 (D) | 70-79 (C) | 80-89 (B) | 90-100 (A)
 *
 * Closed-open on the lower bound, closed on the upper for the last bucket
 * (so a 100% score lands in "A" rather than overflowing). The spec calls for
 * a configurable threshold for the pass-rate calculation (default 60%); the
 * histogram itself is fixed letter-grade buckets so it can be read at a
 * glance without legend lookup.
 */
export const ANALYTICS_HISTOGRAM_BUCKETS = [
  { label: "F", letter: "F", min_pct: 0, max_pct: 60 },
  { label: "D", letter: "D", min_pct: 60, max_pct: 70 },
  { label: "C", letter: "C", min_pct: 70, max_pct: 80 },
  { label: "B", letter: "B", min_pct: 80, max_pct: 90 },
  { label: "A", letter: "A", min_pct: 90, max_pct: 100.0001 },
] as const;

export interface AnalyticsHistogramBucket {
  label: string;
  letter: string;
  min_pct: number;
  max_pct: number;
  count: number;
}

export type AnalyticsSuppressionReason = "insufficient_population";

/**
 * Discriminated value type for any aggregate the worker emits. When `n` is
 * below the configured suppression threshold the worker returns
 * `{ suppressed: true, reason: ..., n }` so the UI can render the
 * "not enough students for a meaningful chart" empty state without having
 * to second-guess a missing field.
 */
export type AnalyticsAggregate<T> =
  | ({ suppressed: false; n: number } & T)
  | { suppressed: true; reason: AnalyticsSuppressionReason; n: number };

export interface AnalyticsSummaryStats {
  /** Mean score (raw, 0..max_score). */
  mean: number;
  /** Median score (raw). */
  median: number;
  /** Population stddev (raw). */
  stddev: number;
  /** Minimum observed score. */
  min: number;
  /** Maximum observed score. */
  max: number;
  /** Mean expressed as a percentage of `max_score` (0..100). */
  mean_pct: number;
  /** Pass rate in [0, 1] using the configured `pass_threshold_pct`. */
  pass_rate: number;
  /** Threshold used for `pass_rate`, expressed as a percentage of max_score. */
  pass_threshold_pct: number;
}

export interface AnalyticsHistogram {
  buckets: AnalyticsHistogramBucket[];
}

export interface CourseAnalyticsContext {
  course_id: Id;
  course_name: string | null;
  course_code: string | null;
  university_id: Id | null;
  /** Total students enrolled in the course (per `course_assignments`). */
  total_enrolled: number;
  /**
   * Total students with a `graded` row across the rollup. For the course
   * summary this is "students with at least one graded assessment"; for an
   * assessment summary this is "students with a graded row on that
   * assessment".
   */
  total_graded: number;
  /** Threshold applied to suppression (echoed for debuggability). */
  min_n: number;
  /** ISO date the snapshot was generated. */
  generated_at: IsoDateString;
}

/**
 * Per-assessment slice — appears inside the course summary so faculty can
 * see distribution shape across all assessments at once. Each slice is
 * independently suppressible.
 */
export interface CourseAnalyticsAssessmentSlice {
  assessment_id: Id;
  title: string;
  weight: number;
  max_score: number;
  due_at: IsoDateString | null;
  stats: AnalyticsAggregate<AnalyticsSummaryStats>;
  histogram: AnalyticsAggregate<AnalyticsHistogram>;
}

export interface CourseAnalyticsSummary extends CourseAnalyticsContext {
  /**
   * Distribution computed over the course total — the weighted sum of
   * `score / max_score` across each student's graded assessments,
   * expressed as a percentage. Suppressed independently of the per-
   * assessment slices so a course with too few students is fully
   * suppressed even if individual assessments aren't.
   */
  course_total_stats: AnalyticsAggregate<AnalyticsSummaryStats>;
  course_total_histogram: AnalyticsAggregate<AnalyticsHistogram>;
  assessments: CourseAnalyticsAssessmentSlice[];
}

/**
 * Per-assessment endpoint response. Same shape as the slice in the course
 * summary plus the course context, so the UI can deep-link into a single
 * assessment view if needed.
 */
export interface AssessmentAnalyticsSummary extends CourseAnalyticsContext {
  assessment_id: Id;
  title: string;
  weight: number;
  max_score: number;
  due_at: IsoDateString | null;
  stats: AnalyticsAggregate<AnalyticsSummaryStats>;
  histogram: AnalyticsAggregate<AnalyticsHistogram>;
}
