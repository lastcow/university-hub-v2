// /app/teachers/:id — teacher profile + their assigned courses & students
// (epic UNI-1 §9, §17, UNI-13).

import { useEffect, useState } from "react";
import { ArrowLeft, BookOpen, GraduationCap } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import type {
  CourseListItem,
  StudentListItem,
  TeacherListItem,
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
  getTeacher,
  listTeacherCourses,
  listTeacherStudents,
} from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: TeacherListItem;
  error?: string;
}

export function TeacherDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: "loading" });
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [nestedLoading, setNestedLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    setNestedLoading(true);
    getTeacher(id, controller.signal)
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        const [c, s] = await Promise.all([
          listTeacherCourses(id, controller.signal).catch(() => []),
          listTeacherStudents(id, controller.signal).catch(() => []),
        ]);
        if (controller.signal.aborted) return;
        setCourses(c);
        setStudents(s);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load teacher.",
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setNestedLoading(false);
      });
    return () => controller.abort();
  }, [id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/teachers">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Teacher</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load teacher" description={state.error} />
      ) : state.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{state.data.name}</CardTitle>
              <CardDescription>{state.data.email}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                Title:{" "}
                <span className="text-foreground">
                  {state.data.title ?? "—"}
                </span>
              </div>
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
              <CardTitle className="text-base">Assigned courses</CardTitle>
              <CardDescription>
                Courses where this teacher has the `teacher` role assignment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {nestedLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : courses.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title="No courses assigned"
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

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Students</CardTitle>
              <CardDescription>
                Distinct students enrolled in any of this teacher's courses.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {nestedLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ) : students.length === 0 ? (
                <EmptyState
                  icon={GraduationCap}
                  title="No students assigned"
                  description="When students are added to one of this teacher's courses, they'll appear here."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Student #</TableHead>
                      <TableHead className="text-right">Open</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {students.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {s.email}
                        </TableCell>
                        <TableCell className="text-sm">
                          {s.student_number ?? "—"}
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
        </>
      ) : null}
    </div>
  );
}
