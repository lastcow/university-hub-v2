// /app/universities/:id — view + entry point to edit. Editable by
// super_admin or the university's own admin.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pencil } from "lucide-react";

import type { University } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { UniversityStatusBadge } from "@/components/UserBadges";
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
import { getUniversity } from "@/lib/universities";

interface State {
  status: "loading" | "ok" | "error";
  data?: University;
  error?: string;
}

export function UniversityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getUniversity(id, controller.signal)
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
              : "Could not load university.",
        });
      });
    return () => controller.abort();
  }, [id]);

  const canEdit =
    state.data && user
      ? user.role === "super_admin" ||
        (user.role === "university_admin" && user.university_id === state.data.id)
      : false;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/universities">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">University</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load university" description={state.error} />
      ) : state.data ? (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>{state.data.name}</CardTitle>
              <CardDescription>{state.data.slug ?? "No slug set"}</CardDescription>
            </div>
            {canEdit ? (
              <Button asChild size="sm" variant="outline">
                <Link to={`/app/universities/${state.data.id}/edit`}>
                  <Pencil className="h-4 w-4" />
                  Edit
                </Link>
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Status:</span>
              <UniversityStatusBadge status={state.data.status} />
            </div>
            <div className="text-sm text-muted-foreground">
              Created {new Date(state.data.created_at).toLocaleString()}
            </div>
            <div className="text-sm text-muted-foreground">
              Last updated {new Date(state.data.updated_at).toLocaleString()}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
