// /app/users — admin user directory (epic UNI-1 §28).
// Table with search + role/status filters; rows link to the detail page.
// `teacher_assistant` renders as "Teacher Assistant" via ROLE_LABELS.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Filter, RefreshCw, Search, Users as UsersIcon } from "lucide-react";

import {
  ROLES,
  ROLE_LABELS,
  USER_STATUSES,
  displayUserName,
  type Role,
  type UserListItem,
  type UserStatus,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { RoleBadge, UserStatusBadge } from "@/components/UserBadges";
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
import { listUsers, type UserListFilters } from "@/lib/users";

interface ListState {
  status: "loading" | "ok" | "error";
  data?: UserListItem[];
  error?: string;
}

const STATUS_OPTIONS: ReadonlyArray<{ label: string; value: UserStatus | "all" }> = [
  { label: "All statuses", value: "all" },
  ...USER_STATUSES.map((s) => ({ label: s.charAt(0).toUpperCase() + s.slice(1), value: s })),
];

export function UsersPage() {
  const { user } = useAuth();
  const canView = user?.role === "super_admin" || user?.role === "university_admin";

  const [state, setState] = useState<ListState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");
  const [statusFilter, setStatusFilter] = useState<UserStatus | "all">("all");
  // UNI-61: tombstoned users are hidden by default; flipping this on adds
  // `include_deleted=true` to the list query and renders the rows with a
  // strikethrough so they're visually distinct from live accounts.
  const [showRemoved, setShowRemoved] = useState(false);

  // Debounce the search input so we don't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const filters: UserListFilters = useMemo(() => {
    const f: UserListFilters = {};
    if (debouncedSearch) f.q = debouncedSearch;
    if (roleFilter !== "all") f.role = roleFilter;
    if (statusFilter !== "all") f.status = statusFilter;
    if (showRemoved) f.include_deleted = true;
    return f;
  }, [debouncedSearch, roleFilter, statusFilter, showRemoved]);

  function load(signal?: AbortSignal) {
    if (!canView) return;
    setState({ status: "loading" });
    listUsers(filters, signal)
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
              : "Could not load users.",
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
        description="You don't have permission to view the user directory."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage roles and account status for everyone in your scope.
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
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Search &amp; filters</CardTitle>
            <CardDescription>
              Showing {state.data?.length ?? 0} {state.data?.length === 1 ? "user" : "users"}.
            </CardDescription>
          </div>
          <Filter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="relative sm:col-span-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as Role | "all")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="all">All roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as UserStatus | "all")}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showRemoved}
              onChange={(e) => setShowRemoved(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            Show removed users
          </label>
        </CardContent>
      </Card>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load users"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : (state.data ?? []).length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="No users match these filters"
          description="Try clearing the search box or changing the role/status filters."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>University</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data!.map((row) => {
                const removed = row.status === "deleted";
                return (
                  <TableRow
                    key={row.id}
                    className={removed ? "text-muted-foreground line-through" : undefined}
                  >
                    <TableCell className="font-medium">{displayUserName(row)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{row.email}</TableCell>
                    <TableCell>
                      <RoleBadge role={row.role} />
                    </TableCell>
                    <TableCell>
                      <UserStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.university_name ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/app/users/${row.id}`}>Open</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
