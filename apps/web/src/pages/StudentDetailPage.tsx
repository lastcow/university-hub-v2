// /app/students/:id — student profile (epic UNI-1 §9, UNI-13).
// Read-only. Backend allows the student themselves OR any directory viewer
// in their university.

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import type { StudentListItem } from "@university-hub/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiClientError } from "@/lib/api";
import { getStudent } from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: StudentListItem;
  error?: string;
}

export function StudentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getStudent(id, controller.signal)
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
              : "Could not load student.",
        });
      });
    return () => controller.abort();
  }, [id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/students">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Student</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load student" description={state.error} />
      ) : state.data ? (
        <Card>
          <CardHeader>
            <CardTitle>{state.data.name}</CardTitle>
            <CardDescription>{state.data.email}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>
              Student number:{" "}
              <span className="font-mono text-foreground">
                {state.data.student_number ?? "—"}
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
            <div className="rounded-md border border-dashed bg-muted/40 p-3 text-xs">
              Course associations land in a future iteration — for now, see the
              student's enrolment via the course detail page.
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
