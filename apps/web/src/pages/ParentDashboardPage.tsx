// /parent — read-only parent / guardian dashboard (UNI-32).
//
// Shows the bound student plus their grades, exactly like the student-self
// view but in a separate top-level route that uses the parent cookie. No app
// shell — the parent is not part of the staff/admin nav. Sign-out clears
// the parent cookie.

import { useEffect, useMemo, useState } from "react";
import { ClipboardList, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  GRADE_STATUS_LABELS,
  type ParentMe,
  type StudentGradeEntry,
} from "@university-hub/shared";

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
import {
  fetchParentMe,
  listParentGrades,
  parentSignOut,
} from "@/lib/disclosures";

interface State {
  status: "loading" | "ok" | "error";
  parent?: ParentMe;
  grades?: StudentGradeEntry[];
  error?: string;
}

export function ParentDashboardPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void Promise.all([fetchParentMe(), listParentGrades()])
      .then(([parent, grades]) => {
        if (cancelled) return;
        setState({ status: "ok", parent, grades });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiClientError && cause.status === 401) {
          navigate("/sign-in/parent", { replace: true });
          return;
        }
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load student records.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const groups = useMemo(() => {
    const data = state.grades ?? [];
    const map = new Map<string, { courseName: string; rows: StudentGradeEntry[] }>();
    for (const row of data) {
      const key = row.course_id;
      const courseName = row.course_code
        ? `${row.course_code} · ${row.course_name ?? ""}`
        : row.course_name ?? "Course";
      const existing = map.get(key);
      if (existing) {
        existing.rows.push(row);
      } else {
        map.set(key, { courseName, rows: [row] });
      }
    }
    return Array.from(map.values());
  }, [state.grades]);

  async function onSignOut() {
    try {
      await parentSignOut();
    } finally {
      navigate("/sign-in/parent", { replace: true });
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Parent / guardian dashboard
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only access to your student's records.
          </p>
        </div>
        <Button variant="outline" onClick={onSignOut}>
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </header>

      {state.status === "loading" ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load records" description={state.error} />
      ) : state.parent && state.grades ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{state.parent.student.name}</CardTitle>
              <CardDescription>
                {state.parent.student.email}
                {state.parent.student.university_name
                  ? ` · ${state.parent.student.university_name}`
                  : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">
              Signed in as <strong>{state.parent.parent_email}</strong>. Session
              expires {new Date(state.parent.expires_at).toLocaleString()}.
            </CardContent>
          </Card>

          {groups.length === 0 ? (
            <Card>
              <CardContent className="py-10">
                <EmptyState
                  icon={ClipboardList}
                  title="No grades yet"
                  description="When a teacher records a grade, it will appear here."
                />
              </CardContent>
            </Card>
          ) : (
            groups.map((group) => (
              <Card key={group.courseName}>
                <CardHeader>
                  <CardTitle className="text-base">{group.courseName}</CardTitle>
                  <CardDescription>
                    {group.rows.length} assessment
                    {group.rows.length === 1 ? "" : "s"} on record.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Assessment</TableHead>
                        <TableHead className="text-right">Score</TableHead>
                        <TableHead className="text-right">Letter</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="font-medium">
                            {row.assessment_title}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.status === "excused" ? (
                              <span className="text-muted-foreground">—</span>
                            ) : row.score === null ? (
                              <span className="text-muted-foreground">
                                Pending
                              </span>
                            ) : (
                              <>
                                {row.score}{" "}
                                <span className="text-muted-foreground">
                                  /{row.assessment_max_score}
                                </span>
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.letter_grade ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                row.status === "graded"
                                  ? "success"
                                  : row.status === "excused"
                                    ? "secondary"
                                    : "outline"
                              }
                            >
                              {GRADE_STATUS_LABELS[row.status]}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))
          )}

          <p className="text-center text-xs text-muted-foreground">
            Each view is recorded in the school's FERPA grade access log.
          </p>
        </>
      ) : null}
    </div>
  );
}
