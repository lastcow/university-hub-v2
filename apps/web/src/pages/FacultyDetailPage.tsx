// /app/faculty/:id — faculty profile (epic UNI-1 §9, UNI-13). Read-only.

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router-dom";

import type { FacultyListItem } from "@university-hub/shared";

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
import { getFaculty } from "@/lib/directories";

interface State {
  status: "loading" | "ok" | "error";
  data?: FacultyListItem;
  error?: string;
}

export function FacultyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getFaculty(id, controller.signal)
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
              : "Could not load faculty member.",
        });
      });
    return () => controller.abort();
  }, [id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/faculty">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Faculty member</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load faculty" description={state.error} />
      ) : state.data ? (
        <Card>
          <CardHeader>
            <CardTitle>{state.data.name}</CardTitle>
            <CardDescription>{state.data.email}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>
              Title:{" "}
              <span className="text-foreground">{state.data.title ?? "—"}</span>
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
