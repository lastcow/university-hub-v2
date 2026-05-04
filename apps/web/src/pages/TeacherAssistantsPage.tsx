// /app/teacher-assistants — TA directory (epic UNI-1 §9, UNI-13).

import { useEffect, useMemo, useState } from "react";
import { LifeBuoy, RefreshCw, Search } from "lucide-react";
import { Link } from "react-router-dom";

import type {
  DepartmentListItem,
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
import { Input } from "@/components/ui/input";
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
import {
  listTeacherAssistants,
  type DirectoryListFilters,
} from "@/lib/directories";

interface ListState {
  status: "loading" | "ok" | "error";
  data?: TeacherAssistantListItem[];
  error?: string;
}

export function TeacherAssistantsPage() {
  const { user } = useAuth();
  const canView =
    user?.role === "super_admin" ||
    user?.role === "university_admin" ||
    user?.role === "staff" ||
    user?.role === "faculty" ||
    user?.role === "teacher" ||
    user?.role === "teacher_assistant";

  const [state, setState] = useState<ListState>({ status: "loading" });
  const [departments, setDepartments] = useState<DepartmentListItem[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    listDepartments({}, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setDepartments(rows);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [canView]);

  const filters: DirectoryListFilters = useMemo(() => {
    const f: DirectoryListFilters = {};
    if (debouncedSearch) f.q = debouncedSearch;
    if (departmentFilter !== "all") f.department = departmentFilter;
    return f;
  }, [debouncedSearch, departmentFilter]);

  function load(signal?: AbortSignal) {
    if (!canView) return;
    setState({ status: "loading" });
    listTeacherAssistants(filters, signal)
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
              : "Could not load teacher assistants.",
        });
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, canView]);

  if (!canView) {
    return (
      <ErrorState
        title="Access denied"
        description="You don't have permission to view the teacher-assistant directory."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Teacher assistants
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only directory of TAs at your university.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load()}
          disabled={state.status === "loading"}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Search &amp; filters</CardTitle>
          <CardDescription>
            Showing {state.data?.length ?? 0}{" "}
            {state.data?.length === 1 ? "TA" : "TAs"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load teacher assistants"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : (state.data ?? []).length === 0 ? (
        <EmptyState
          icon={LifeBuoy}
          title="No teacher assistants match"
          description="Adjust your search or department filter."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Department</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data!.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.email}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.department_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/app/teacher-assistants/${row.id}`}>Open</Link>
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
