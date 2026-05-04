// /app/departments — list + create entry point (epic UNI-1 §9, UNI-12).
//
// Everyone in academic/admin nav can read; only super_admin and
// university_admin see the New / Edit / Delete affordances. The backend is
// the source of truth — this page just hides what the actor cannot do.

import { useEffect, useState } from "react";
import { ClipboardList, Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

import type { DepartmentListItem } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
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
import { listDepartments } from "@/lib/departments";

interface ListState {
  status: "loading" | "ok" | "error";
  data?: DepartmentListItem[];
  error?: string;
}

export function DepartmentsPage() {
  const { user } = useAuth();
  const canManage =
    user?.role === "super_admin" || user?.role === "university_admin";

  const [state, setState] = useState<ListState>({ status: "loading" });

  function load(signal?: AbortSignal) {
    setState({ status: "loading" });
    listDepartments({}, signal)
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
              : "Could not load departments.",
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
          <h1 className="text-2xl font-semibold tracking-tight">Departments</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Create and manage academic departments. Each owns its own courses."
              : "Browse the academic departments at your university."}
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
          {canManage ? (
            <Button asChild size="sm">
              <Link to="/app/departments/new">
                <Plus className="h-4 w-4" />
                New department
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
          title="Couldn't load departments"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : (state.data ?? []).length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No departments yet"
          description={
            canManage
              ? "Use the New department button to create your first department."
              : "Your university hasn't published any departments yet."
          }
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>University</TableHead>
                <TableHead className="text-right">Courses</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data!.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.code ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.university_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.course_count}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/app/departments/${row.id}`}>View</Link>
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
