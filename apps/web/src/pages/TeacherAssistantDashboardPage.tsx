// /app/teacher-assistant/dashboard — TA's own dashboard (epic UNI-1 §9, UNI-13).

import { useEffect, useState } from "react";
import { BookOpen, UserSquare2 } from "lucide-react";
import { Link } from "react-router-dom";

import type {
  CourseListItem,
  TeacherAssistantListItem,
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
  getMyTeacherAssistant,
  listMyTeacherAssistantCourses,
} from "@/lib/directories";

interface State {
  ta?: TeacherAssistantListItem;
  courses: CourseListItem[];
  status: "loading" | "ok" | "error";
  error?: string;
}

const INITIAL: State = { status: "loading", courses: [] };

export function TeacherAssistantDashboardPage() {
  const { user } = useAuth();
  const [state, setState] = useState<State>(INITIAL);

  useEffect(() => {
    if (user?.role !== "teacher_assistant") return;
    const controller = new AbortController();
    setState(INITIAL);
    Promise.all([
      getMyTeacherAssistant(controller.signal),
      listMyTeacherAssistantCourses(controller.signal),
    ])
      .then(([ta, courses]) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", ta, courses });
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

  if (user?.role !== "teacher_assistant") {
    return (
      <ErrorState
        title="Teacher assistants only"
        description="This dashboard is only available to teacher-assistant accounts."
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
          Your TA workspace — everything below is scoped to courses you assist.
        </p>
      </div>

      {state.status === "loading" ? (
        <div className="grid gap-4 sm:grid-cols-2">
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
            className="grid gap-4 sm:grid-cols-2"
          >
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Assisted courses
                </CardTitle>
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <BookOpen className="h-4 w-4" />
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tracking-tight">
                  {state.courses.length}
                </p>
                <Button asChild variant="link" size="sm" className="mt-1 px-0">
                  <Link to="/app/teacher-assistant/courses">View courses</Link>
                </Button>
              </CardContent>
            </Card>
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
                  {state.ta?.department_name ?? "Unassigned"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {state.ta?.university_name ?? "—"}
                </p>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent assignments</CardTitle>
              <CardDescription>
                Top three courses where you assist.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {state.courses.length === 0 ? (
                <EmptyState
                  icon={BookOpen}
                  title="No courses assigned yet"
                  description="Once an admin adds you as a TA on a course, it'll show up here."
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
