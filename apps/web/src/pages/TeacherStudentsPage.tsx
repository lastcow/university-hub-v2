// /app/teacher/students — students enrolled in any of the signed-in teacher's
// courses (epic UNI-1 §9, UNI-13).

import { useEffect, useState } from "react";
import { GraduationCap } from "lucide-react";
import { Link } from "react-router-dom";

import type { StudentListItem } from "@university-hub/shared";

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/data-table";
import { ApiClientError } from "@/lib/api";
import { listMyTeacherStudents } from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: StudentListItem[];
  error?: string;
}

export function TeacherStudentsPage() {
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (user?.role !== "teacher") return;
    const controller = new AbortController();
    setState({ status: "loading" });
    listMyTeacherStudents(controller.signal)
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
              : "Could not load your students.",
        });
      });
    return () => controller.abort();
  }, [user?.role]);

  if (user?.role !== "teacher") {
    return (
      <ErrorState
        title="Teachers only"
        description="This page is only available to teacher accounts."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My students</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Distinct students enrolled in any of your courses.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Students</CardTitle>
          <CardDescription>
            {state.status === "ok"
              ? `Showing ${state.data?.length ?? 0} ${state.data?.length === 1 ? "student" : "students"}.`
              : "Loading…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.status === "loading" ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : state.status === "error" ? (
            <ErrorState
              title="Couldn't load students"
              description={state.error}
            />
          ) : (state.data ?? []).length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title="No students yet"
              description="Once students are added to one of your courses, they'll show up here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Student #</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data!.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.email}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.student_number ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.department_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/app/students/${s.id}`}>View</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
