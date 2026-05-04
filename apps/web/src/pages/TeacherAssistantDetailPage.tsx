// /app/teacher-assistants/:id — TA profile + assigned courses
// (epic UNI-1 §9, §17, UNI-13).

import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import type {
  CourseListItem,
  TeacherAssistantListItem,
} from "@university-hub/shared";

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
import {
  getTeacherAssistant,
  listTeacherAssistantCourses,
} from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: TeacherAssistantListItem;
  error?: string;
}

export function TeacherAssistantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: "loading" });
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [coursesLoading, setCoursesLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    setCoursesLoading(true);
    getTeacherAssistant(id, controller.signal)
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        const c = await listTeacherAssistantCourses(id, controller.signal).catch(
          () => [],
        );
        if (controller.signal.aborted) return;
        setCourses(c);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load teacher assistant.",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setCoursesLoading(false);
      });
    return () => controller.abort();
  }, [id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/teacher-assistants">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          Teacher assistant
        </h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load teacher assistant"
          description={state.error}
        />
      ) : state.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{state.data.name}</CardTitle>
              <CardDescription>{state.data.email}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                Department:{" "}
                <span className="text-foreground">
                  {state.data.department_name ?? "Unassigned"}
                </span>
              </div>
              <div>
                University:{" "}
                <span className="text-foreground">
                  {state.data.university_name ?? "—"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Assisted courses</CardTitle>
              <CardDescription>
                Courses where this person has the `teacher_assistant` role.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {coursesLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ) : courses.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title="Not assigned to any courses"
                  description="Course assignments are managed from the course detail page."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Course</TableHead>
                      <TableHead>Code</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Open</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {courses.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {c.code ?? "—"}
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
        </>
      ) : null}
    </div>
  );
}
