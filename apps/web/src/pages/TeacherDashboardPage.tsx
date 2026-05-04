// /app/teacher/dashboard — teacher's own dashboard (epic UNI-1 §9, UNI-13).
// Shows the signed-in teacher's profile, their assigned courses, and a count
// of distinct students across those courses.

import { useEffect, useState } from "react";
import { BookOpen, GraduationCap, UserSquare2 } from "lucide-react";
import { Link } from "react-router-dom";

import type {
  CourseListItem,
  StudentListItem,
  TeacherListItem,
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
import {
  getMyTeacher,
  listMyTeacherCourses,
  listMyTeacherStudents,
} from "@/lib/directories";

interface State {
  teacher?: TeacherListItem;
  courses: CourseListItem[];
  students: StudentListItem[];
  status: "loading" | "ok" | "error";
  error?: string;
}

const INITIAL: State = { status: "loading", courses: [], students: [] };

export function TeacherDashboardPage() {
  const { user } = useAuth();
  const [state, setState] = useState<State>(INITIAL);

  useEffect(() => {
    if (user?.role !== "teacher") return;
    const controller = new AbortController();
    setState(INITIAL);
    Promise.all([
      getMyTeacher(controller.signal),
      listMyTeacherCourses(controller.signal),
      listMyTeacherStudents(controller.signal),
    ])
      .then(([teacher, courses, students]) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", teacher, courses, students });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          ...INITIAL,
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load your dashboard.",
        });
      });
    return () => controller.abort();
  }, [user?.role]);

  if (user?.role !== "teacher") {
    return (
      <ErrorState
        title="Teachers only"
        description="This dashboard is only available to teacher accounts."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {user.name.split(" ")[0]}.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your teaching workspace — everything below is scoped to your courses.
        </p>
      </div>

      {state.status === "loading" ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Card className="space-y-3 p-6">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </Card>
          <Card className="space-y-3 p-6">
            <Skeleton className="h-4 w-1/2" />
          </Card>
          <Card className="space-y-3 p-6">
            <Skeleton className="h-4 w-1/2" />
          </Card>
        </div>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load your dashboard"
          description={state.error}
        />
      ) : (
        <>
          <section
            aria-label="Overview"
            className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            <StatCard
              label="My courses"
              value={state.courses.length}
              icon={BookOpen}
              cta={{ label: "View courses", to: "/app/teacher/courses" }}
            />
            <StatCard
              label="My students"
              value={state.students.length}
              icon={GraduationCap}
              cta={{ label: "View students", to: "/app/teacher/students" }}
            />
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Department
                </CardTitle>
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <UserSquare2 className="h-4 w-4" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold">
                  {state.teacher?.department_name ?? "Unassigned"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {state.teacher?.title ?? "—"} ·{" "}
                  {state.teacher?.university_name ?? "—"}
                </p>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent courses</CardTitle>
              <CardDescription>
                Top three of your assigned courses. Open one to see students,
                assignments, and details.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {state.courses.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title="No courses assigned"
                  description="Once an admin adds you to a course as a teacher, it'll show up here."
                />
              ) : (
                <ul className="divide-y">
                  {state.courses.slice(0, 3).map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between py-3"
                    >
                      <div>
                        <p className="font-medium">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.code ?? "No code"} ·{" "}
                          {c.department_name ?? "Unassigned"}
                        </p>
                      </div>
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/app/courses/${c.id}`}>Open</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  cta,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  cta: { label: string; to: string };
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
        <Button asChild variant="link" size="sm" className="mt-1 px-0">
          <Link to={cta.to}>{cta.label}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
