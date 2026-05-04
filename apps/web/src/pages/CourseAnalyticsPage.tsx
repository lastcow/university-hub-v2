// /app/courses/:id/analytics — faculty course analytics (UNI-31).
//
// Aggregates only — no row-level student data is rendered. The worker handles
// suppression (any aggregate over fewer than ANALYTICS_MIN_N students comes
// back as `{ suppressed: true }`); this page just renders the discriminated
// union: numbers when present, an "insufficient population" empty state when
// not.
//
// The histogram is drawn as a simple SVG bar chart so we don't pull in a
// charting dependency for a single visualization. The buckets are fixed
// letter-grade ranges (F / D / C / B / A) to keep the chart readable without
// a legend.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, BarChart3, ShieldCheck } from "lucide-react";

import type {
  AnalyticsAggregate,
  AnalyticsHistogram,
  AnalyticsSummaryStats,
  CourseAnalyticsAssessmentSlice,
  CourseAnalyticsSummary,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError } from "@/lib/api";
import { getCourseAnalyticsSummary } from "@/lib/analytics";

const FACULTY_ROLES: ReadonlySet<string> = new Set([
  "super_admin",
  "university_admin",
  "faculty",
]);

interface State {
  status: "loading" | "ok" | "error";
  data?: CourseAnalyticsSummary;
  error?: string;
}

export function CourseAnalyticsPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  const role = user?.role;
  const canView = !!role && FACULTY_ROLES.has(role);

  useEffect(() => {
    if (!canView || !id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getCourseAnalyticsSummary(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load analytics.",
        });
      });
    return () => controller.abort();
  }, [canView, id]);

  if (!canView) {
    return (
      <ErrorState
        title="Restricted"
        description="Course analytics are only available to faculty assigned to the course."
      />
    );
  }

  if (state.status === "loading") {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <ErrorState title="Couldn't load analytics" description={state.error} />
    );
  }

  const data = state.data!;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to={`/app/courses/${data.course_id}`}>
            <ArrowLeft className="h-4 w-4" />
            Back to course
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.course_name ?? "Course"} · Analytics
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Course summary</CardTitle>
          <CardDescription>
            Aggregates only. Numbers are suppressed when fewer than{" "}
            {data.min_n} students are in the underlying population to prevent
            re-identification.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-3">
          <Stat label="Enrolled" value={String(data.total_enrolled)} />
          <Stat
            label="Students with grades"
            value={String(data.total_graded)}
          />
          <Stat
            label="Pass threshold"
            value={`${formatPct(passThresholdOf(data.course_total_stats))}%`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Course total</CardTitle>
          <CardDescription>
            Weighted across all assessments. Each student's percentage is
            computed against the assessments they have a graded row on.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <StatsSummary stats={data.course_total_stats} />
          <HistogramChart histogram={data.course_total_histogram} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">By assessment</CardTitle>
          <CardDescription>
            Per-assessment distributions. Each row is suppressed independently
            from the course total above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {data.assessments.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No assessments yet"
              description="Add assessments and grades to see analytics here."
            />
          ) : (
            data.assessments.map((slice) => (
              <AssessmentSlice key={slice.assessment_id} slice={slice} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface StatProps {
  label: string;
  value: string;
}

function Stat({ label, value }: StatProps) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function passThresholdOf(
  stats: AnalyticsAggregate<AnalyticsSummaryStats>,
): number {
  if (stats.suppressed) return 60;
  return stats.pass_threshold_pct;
}

function StatsSummary({
  stats,
}: {
  stats: AnalyticsAggregate<AnalyticsSummaryStats>;
}) {
  if (stats.suppressed) {
    return <SuppressedNotice n={stats.n} />;
  }
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Mean" value={formatPct(stats.mean_pct) + "%"} />
      <Stat label="Median" value={formatPct(stats.median)} />
      <Stat label="Std. dev" value={formatPct(stats.stddev)} />
      <Stat
        label="Pass rate"
        value={`${Math.round(stats.pass_rate * 100)}%`}
      />
    </div>
  );
}

function HistogramChart({
  histogram,
}: {
  histogram: AnalyticsAggregate<AnalyticsHistogram>;
}) {
  if (histogram.suppressed) {
    return <SuppressedNotice n={histogram.n} />;
  }
  const buckets = histogram.buckets;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const totalCount = buckets.reduce((acc, b) => acc + b.count, 0);
  const width = 360;
  const height = 160;
  const padding = 24;
  const barAreaWidth = width - padding * 2;
  const barWidth = (barAreaWidth / buckets.length) - 8;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Grade distribution · {totalCount} student
        {totalCount === 1 ? "" : "s"}
      </p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Grade distribution histogram"
        className="h-40 w-full"
      >
        {buckets.map((bucket, i) => {
          const x = padding + i * (barWidth + 8);
          const barHeight = (bucket.count / maxCount) * (height - padding * 2);
          const y = height - padding - barHeight;
          return (
            <g key={bucket.label}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 1)}
                rx={4}
                className="fill-primary/80"
              />
              <text
                x={x + barWidth / 2}
                y={y - 4}
                textAnchor="middle"
                className="fill-foreground text-[10px] tabular-nums"
              >
                {bucket.count}
              </text>
              <text
                x={x + barWidth / 2}
                y={height - 6}
                textAnchor="middle"
                className="fill-muted-foreground text-[11px]"
              >
                {bucket.label}
              </text>
              <text
                x={x + barWidth / 2}
                y={height - 18}
                textAnchor="middle"
                className="fill-muted-foreground text-[9px]"
              >
                {Math.round(bucket.min_pct)}–
                {bucket.max_pct >= 100
                  ? 100
                  : Math.round(bucket.max_pct - 0.0001)}
                %
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function AssessmentSlice({
  slice,
}: {
  slice: CourseAnalyticsAssessmentSlice;
}) {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{slice.title}</p>
          <p className="text-xs text-muted-foreground">
            Max {slice.max_score} · weight {(slice.weight * 100).toFixed(0)}%
            {slice.due_at
              ? ` · due ${new Date(slice.due_at).toLocaleDateString()}`
              : ""}
          </p>
        </div>
      </div>
      <StatsSummary stats={slice.stats} />
      <HistogramChart histogram={slice.histogram} />
    </div>
  );
}

function SuppressedNotice({ n }: { n: number }) {
  return (
    <EmptyState
      icon={ShieldCheck}
      title="Not enough students for a meaningful chart"
      description={`This aggregate covers ${n} student${n === 1 ? "" : "s"}, which is below the suppression threshold. Numbers are hidden to prevent re-identification.`}
    />
  );
}

function formatPct(value: number): string {
  return value.toFixed(1);
}
