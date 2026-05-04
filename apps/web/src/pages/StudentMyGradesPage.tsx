// /app/student/my-grades — student-self view of grades (UNI-30).

import { useEffect, useMemo, useState } from "react";
import { ClipboardList } from "lucide-react";

import {
  GRADE_STATUS_LABELS,
  type StudentGradeEntry,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Badge } from "@/components/ui/badge";
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
import { listStudentGrades } from "@/lib/grades";

interface State {
  status: "loading" | "ok" | "error";
  data?: StudentGradeEntry[];
  error?: string;
}

export function StudentMyGradesPage() {
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!user || user.role !== "student") return;
    const controller = new AbortController();
    setState({ status: "loading" });
    listStudentGrades(user.id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load your grades.",
        });
      });
    return () => controller.abort();
  }, [user]);

  const groups = useMemo(() => {
    const data = state.data ?? [];
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
  }, [state.data]);

  if (user?.role !== "student") {
    return (
      <ErrorState
        title="Students only"
        description="This page is only available to student accounts."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My grades</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your grades across all enrolled courses. Each view is recorded in
          the FERPA grade access log.
        </p>
      </div>

      {state.status === "loading" ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load grades" description={state.error} />
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="py-10">
            <EmptyState
              icon={ClipboardList}
              title="No grades yet"
              description="When a teacher records a grade for you, it'll appear here."
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
                    <TableHead className="text-right">Weight</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">
                        {row.assessment_title}
                        {row.feedback ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.feedback}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.status === "excused" ? (
                          <span className="text-muted-foreground">—</span>
                        ) : row.score === null ? (
                          <span className="text-muted-foreground">Pending</span>
                        ) : (
                          <>
                            {row.score} <span className="text-muted-foreground">/{row.assessment_max_score}</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.letter_grade ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {Math.round(row.assessment_weight * 100)}%
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
    </div>
  );
}
