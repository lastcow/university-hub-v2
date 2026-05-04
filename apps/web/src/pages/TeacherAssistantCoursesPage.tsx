// /app/teacher-assistant/courses — courses the signed-in TA assists
// (epic UNI-1 §9, UNI-13).

import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { Link } from "react-router-dom";

import type { CourseListItem } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { CourseStatusBadge } from "@/components/UserBadges";
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
import { listMyTeacherAssistantCourses } from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: CourseListItem[];
  error?: string;
}

export function TeacherAssistantCoursesPage() {
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (user?.role !== "teacher_assistant") return;
    const controller = new AbortController();
    setState({ status: "loading" });
    listMyTeacherAssistantCourses(controller.signal)
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
              : "Could not load your courses.",
        });
      });
    return () => controller.abort();
  }, [user?.role]);

  if (user?.role !== "teacher_assistant") {
    return (
      <ErrorState
        title="Teacher assistants only"
        description="This page is only available to TA accounts."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My courses</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Courses where you have a `teacher_assistant` assignment.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Assisted courses</CardTitle>
          <CardDescription>
            {state.status === "ok"
              ? `Showing ${state.data?.length ?? 0} ${state.data?.length === 1 ? "course" : "courses"}.`
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
              title="Couldn't load courses"
              description={state.error}
            />
          ) : (state.data ?? []).length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No courses assigned"
              description="Once an admin adds you to a course as a TA, it'll appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.data!.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.code ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.department_name ?? "—"}
                    </TableCell>
                    <TableCell>
                      <CourseStatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/app/courses/${c.id}`}>View</Link>
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
