// /app/audit-logs/grade-access — FERPA record-of-disclosure admin page
// (epic UNI-21 / sub-issue UNI-30).
//
// Restricted to super_admin / university_admin. Lists every disclosure of
// grade data (course gradebook reads, student-self reads, faculty views of
// student grades, grade mutations) with student / viewer / course / date
// filters.

import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";

import type { GradeAccessLogEntry } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/data-table";
import { ApiClientError } from "@/lib/api";
import { listGradeAccessLog, type GradeAccessLogFilters } from "@/lib/grades";

const VIEWER_ROLES: ReadonlySet<string> = new Set([
  "super_admin",
  "university_admin",
]);

const PAGE_SIZE = 50;

interface State {
  status: "loading" | "ok" | "error";
  items?: GradeAccessLogEntry[];
  total?: number;
  error?: string;
}

const CONTEXT_LABELS: Record<string, string> = {
  course_gradebook: "Course gradebook",
  student_self: "Student self view",
  student_view_by_faculty: "Faculty view of student",
};

export function GradeAccessLogPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<GradeAccessLogFilters>({
    limit: PAGE_SIZE,
    offset: 0,
  });
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!user || !VIEWER_ROLES.has(user.role)) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    listGradeAccessLog(filters, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", items: res.items, total: res.total });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load grade access log.",
        });
      });
    return () => controller.abort();
  }, [filters, user]);

  if (!user || !VIEWER_ROLES.has(user.role)) {
    return (
      <ErrorState
        title="Restricted"
        description="The FERPA grade access log is admin-only."
      />
    );
  }

  function setFilter<K extends keyof GradeAccessLogFilters>(
    key: K,
    value: GradeAccessLogFilters[K],
  ) {
    setFilters((prev) => ({ ...prev, [key]: value, offset: 0 }));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Grade access log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          FERPA record of disclosure. Every read of grade data, by every user,
          is recorded here.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Narrow by student, viewer, course, or date range.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-2">
            <Label htmlFor="f-student">Student user id</Label>
            <Input
              id="f-student"
              value={filters.student_user_id ?? ""}
              onChange={(e) =>
                setFilter("student_user_id", e.target.value || undefined)
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-viewer">Viewer user id</Label>
            <Input
              id="f-viewer"
              value={filters.viewer_user_id ?? ""}
              onChange={(e) =>
                setFilter("viewer_user_id", e.target.value || undefined)
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-course">Course id</Label>
            <Input
              id="f-course"
              value={filters.course_id ?? ""}
              onChange={(e) =>
                setFilter("course_id", e.target.value || undefined)
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-from">From (ISO 8601)</Label>
            <Input
              id="f-from"
              value={filters.from ?? ""}
              placeholder="2026-05-01T00:00:00Z"
              onChange={(e) => setFilter("from", e.target.value || undefined)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-to">To (ISO 8601)</Label>
            <Input
              id="f-to"
              value={filters.to ?? ""}
              placeholder="2026-05-31T23:59:59Z"
              onChange={(e) => setFilter("to", e.target.value || undefined)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Disclosures</CardTitle>
          <CardDescription>
            {state.status === "ok"
              ? `${state.total ?? 0} total · showing ${state.items?.length ?? 0}`
              : "Loading…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.status === "loading" ? (
            <Skeleton className="h-32 w-full" />
          ) : state.status === "error" ? (
            <ErrorState
              title="Couldn't load grade access log"
              description={state.error}
            />
          ) : (state.items ?? []).length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No disclosures match"
              description="Adjust your filters or wait for grade activity."
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Viewer</TableHead>
                    <TableHead>Student</TableHead>
                    <TableHead>Course</TableHead>
                    <TableHead>Context</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(state.items ?? []).map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">
                        {row.accessed_at}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {row.viewer_name ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.viewer_role}
                          {row.viewer_course_role
                            ? ` · ${row.viewer_course_role}`
                            : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {row.viewed_student_name ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.viewed_student_email ?? row.viewed_student_user_id ?? ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">
                          {row.course_name ?? "—"}
                        </div>
                        {row.assessment_title ? (
                          <div className="text-xs text-muted-foreground">
                            {row.assessment_title}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {CONTEXT_LABELS[row.context] ?? row.context}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={(filters.offset ?? 0) === 0}
                  onClick={() =>
                    setFilters((p) => ({
                      ...p,
                      offset: Math.max(0, (p.offset ?? 0) - PAGE_SIZE),
                    }))
                  }
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    (state.items ?? []).length < PAGE_SIZE ||
                    (filters.offset ?? 0) + PAGE_SIZE >=
                      (state.total ?? 0)
                  }
                  onClick={() =>
                    setFilters((p) => ({
                      ...p,
                      offset: (p.offset ?? 0) + PAGE_SIZE,
                    }))
                  }
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
