// /app/student/my-profile — read-only profile for the signed-in student
// (epic UNI-1 §9, UNI-13).

import { useEffect, useState } from "react";

import type { StudentListItem } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
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
import { getMyStudent } from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: StudentListItem;
  error?: string;
}

export function StudentMyProfilePage() {
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (user?.role !== "student") return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getMyStudent(controller.signal)
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
              : "Could not load your profile.",
        });
      });
    return () => controller.abort();
  }, [user?.role]);

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
        <h1 className="text-2xl font-semibold tracking-tight">My profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only — contact your university admin to request a change.
        </p>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load profile" description={state.error} />
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
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
