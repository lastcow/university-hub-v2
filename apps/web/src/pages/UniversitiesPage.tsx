// /app/universities — list view (epic UNI-1 §9, §28).
//
// super_admin sees every university and can create/edit; university_admin
// sees just their own and can edit it; everyone else who reaches this route
// gets an empty list (the backend scopes the response).

import { useEffect, useState } from "react";
import { Building2, Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

import type { University } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { UniversityStatusBadge } from "@/components/UserBadges";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { listUniversities } from "@/lib/universities";

interface ListState {
  status: "loading" | "ok" | "error";
  data?: University[];
  error?: string;
}

export function UniversitiesPage() {
  const { user } = useAuth();
  const [state, setState] = useState<ListState>({ status: "loading" });

  const canCreate = user?.role === "super_admin";

  function load(signal?: AbortSignal) {
    setState({ status: "loading" });
    listUniversities(signal)
      .then((data) => {
        if (signal?.aborted) return;
        setState({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (signal?.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load universities.",
        });
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Universities</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canCreate
              ? "Manage every university on the platform."
              : "View your university details."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => load()}
            disabled={state.status === "loading"}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          {canCreate ? (
            <Button asChild size="sm">
              <Link to="/app/universities/new">
                <Plus className="h-4 w-4" />
                New university
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load universities"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : (state.data ?? []).length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No universities yet"
          description={
            canCreate
              ? "Use the New university button to create one."
              : "Your account isn't linked to a university yet."
          }
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data!.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.slug ?? "—"}
                  </TableCell>
                  <TableCell>
                    <UniversityStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(row.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/app/universities/${row.id}`}>View</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
