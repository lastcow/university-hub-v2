// /app/courses — list view (epic UNI-1 §9, UNI-12).
//
// Filters: search, department, status. Department filter pulls from the same
// /api/departments scope so non-admins only see their own university's
// departments anyway.

import { useEffect, useMemo, useState } from "react";
import { BookOpen, Filter, Plus, RefreshCw, Search } from "lucide-react";
import { Link } from "react-router-dom";

import {
  COURSE_STATUSES,
  type CourseListItem,
  type CourseStatus,
  type DepartmentListItem,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
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
import { listCourses, type CourseListFilters } from "@/lib/courses";
import { listDepartments } from "@/lib/departments";

interface ListState {
  status: "loading" | "ok" | "error";
  data?: CourseListItem[];
  error?: string;
}

export function CoursesPage() {
  const { user } = useAuth();
  const canManage =
    user?.role === "super_admin" || user?.role === "university_admin";

  const [state, setState] = useState<ListState>({ status: "loading" });
  const [departments, setDepartments] = useState<DepartmentListItem[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<CourseStatus | "all">("all");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    listDepartments({}, controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setDepartments(rows);
      })
      .catch(() => {
        // Non-fatal — the filter is optional.
      });
    return () => controller.abort();
  }, []);

  const filters: CourseListFilters = useMemo(() => {
    const f: CourseListFilters = {};
    if (debouncedSearch) f.q = debouncedSearch;
    if (departmentFilter !== "all") f.department = departmentFilter;
    if (statusFilter !== "all") f.status = statusFilter;
    return f;
  }, [debouncedSearch, departmentFilter, statusFilter]);

  function load(signal?: AbortSignal) {
    setState({ status: "loading" });
    listCourses(filters, signal)
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
              : "Could not load courses.",
        });
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Courses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Browse, filter, and manage courses across departments."
              : "Browse the courses available at your university."}
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
              <Link to="/app/courses/new">
                <Plus className="h-4 w-4" />
                New course
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Search &amp; filters</CardTitle>
            <CardDescription>
              Showing {state.data?.length ?? 0}{" "}
              {state.data?.length === 1 ? "course" : "courses"}.
            </CardDescription>
          </div>
          <Filter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or code…"
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
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as CourseStatus | "all")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All statuses</option>
              {COURSE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
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
          <Skeleton className="h-4 w-2/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load courses"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : (state.data ?? []).length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No courses match"
          description="Try clearing the filters or creating a new course."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Assignments</TableHead>
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
                    {row.department_name ?? "Unassigned"}
                  </TableCell>
                  <TableCell>
                    <CourseStatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.assignment_count}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/app/courses/${row.id}`}>View</Link>
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
