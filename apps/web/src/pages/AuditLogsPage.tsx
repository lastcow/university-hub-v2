// /app/audit-logs — admin audit-log viewer (epic UNI-1 §9, §30 + UNI-14).
//
// Table with filters (action / entity / actor / date range), action badges
// colour-coded by domain, and expandable rows showing pretty-printed
// metadata_json. Empty + error + loading states. RBAC: super_admin sees
// every university; university_admin / staff are scoped server-side to
// their own. Other roles get the access-denied state.

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Filter,
  RefreshCw,
} from "lucide-react";

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_LABELS,
  auditActionCategory,
  type AuditAction,
  type AuditActionCategory,
  type AuditLogListItem,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Badge, type BadgeProps } from "@/components/ui/badge";
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
import {
  listAuditLogs,
  type AuditLogListFilters,
} from "@/lib/audit-logs";

const PAGE_SIZE = 50;

const VIEWER_ROLES: ReadonlySet<string> = new Set([
  "super_admin",
  "university_admin",
]);

const CATEGORY_VARIANTS: Record<AuditActionCategory, BadgeProps["variant"]> = {
  auth: "secondary",
  session: "secondary",
  invitation: "default",
  user: "default",
  university: "default",
  department: "outline",
  course: "outline",
  email: "warning",
  settings: "secondary",
  mfa: "secondary",
};

function ActionBadge({ action }: { action: AuditAction }) {
  const variant = CATEGORY_VARIANTS[auditActionCategory(action)];
  return <Badge variant={variant}>{AUDIT_ACTION_LABELS[action]}</Badge>;
}

interface ListState {
  status: "loading" | "ok" | "error";
  items: AuditLogListItem[];
  total: number;
  hasMore: boolean;
  error?: string;
}

const INITIAL_STATE: ListState = {
  status: "loading",
  items: [],
  total: 0,
  hasMore: false,
};

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function AuditLogsPage() {
  const { user } = useAuth();
  const canView = !!user && VIEWER_ROLES.has(user.role);

  const [state, setState] = useState<ListState>(INITIAL_STATE);
  const [actionFilter, setActionFilter] = useState<AuditAction | "all">("all");
  const [entityTypeInput, setEntityTypeInput] = useState("");
  const [debouncedEntityType, setDebouncedEntityType] = useState("");
  const [actorIdInput, setActorIdInput] = useState("");
  const [debouncedActorId, setDebouncedActorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedEntityType(entityTypeInput.trim());
      setDebouncedActorId(actorIdInput.trim());
    }, 250);
    return () => clearTimeout(t);
  }, [entityTypeInput, actorIdInput]);

  // Reset to first page whenever filters change so we don't end up paging
  // past the new (typically smaller) result set.
  useEffect(() => {
    setPage(0);
  }, [actionFilter, debouncedEntityType, debouncedActorId, from, to]);

  const filters: AuditLogListFilters = useMemo(() => {
    const f: AuditLogListFilters = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (actionFilter !== "all") f.action = actionFilter;
    if (debouncedEntityType) f.entity_type = debouncedEntityType;
    if (debouncedActorId) f.actor_user_id = debouncedActorId;
    if (from) f.from = new Date(from).toISOString();
    if (to) {
      // Treat the `to` date input as end-of-day so the user's "today" filter
      // includes events posted earlier today.
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      f.to = end.toISOString();
    }
    return f;
  }, [actionFilter, debouncedEntityType, debouncedActorId, from, to, page]);

  function load(signal?: AbortSignal) {
    if (!canView) return;
    setState((prev) => ({ ...prev, status: "loading" }));
    listAuditLogs(filters, signal)
      .then((res) => {
        if (signal?.aborted) return;
        setState({
          status: "ok",
          items: res.items,
          total: res.total,
          hasMore: res.has_more,
        });
      })
      .catch((cause: unknown) => {
        if (signal?.aborted) return;
        setState({
          status: "error",
          items: [],
          total: 0,
          hasMore: false,
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load audit logs.",
        });
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, canView]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!canView) {
    return (
      <ErrorState
        title="Access denied"
        description="You don't have permission to view audit logs."
      />
    );
  }

  const start = state.items.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = page * PAGE_SIZE + state.items.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            System actions: invitations, sign-ins, role changes, settings, and
            more.
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
            <CardTitle className="text-base">Filters</CardTitle>
            <CardDescription>
              Narrow the log by action, entity, actor, or time window.
            </CardDescription>
          </div>
          <Filter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="lg:col-span-2">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Action
              </label>
              <select
                value={actionFilter}
                onChange={(e) =>
                  setActionFilter(e.target.value as AuditAction | "all")
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All actions</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {AUDIT_ACTION_LABELS[a]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Entity type
              </label>
              <Input
                placeholder="e.g. invitation"
                value={entityTypeInput}
                onChange={(e) => setEntityTypeInput(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Actor user id
              </label>
              <Input
                placeholder="UUID"
                value={actorIdInput}
                onChange={(e) => setActorIdInput(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                From
              </label>
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                To
              </label>
              <Input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
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
          title="Couldn't load audit logs"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : state.items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No audit log entries match these filters"
          description="Try clearing filters or expanding the date range."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>When</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>University</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.items.map((row) => {
                const isOpen = expanded.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => toggleExpanded(row.id)}
                    >
                      <TableCell>
                        <button
                          type="button"
                          aria-label={isOpen ? "Collapse row" : "Expand row"}
                          aria-expanded={isOpen}
                          className="text-muted-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpanded(row.id);
                          }}
                        >
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell>
                        <ActionBadge action={row.action} />
                      </TableCell>
                      <TableCell>
                        {row.actor_name ? (
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {row.actor_name}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {row.actor_email ?? row.actor_user_id}
                            </span>
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            System
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.entity_type ? (
                          <span>
                            {row.entity_type}
                            {row.entity_id ? (
                              <span className="ml-1 font-mono text-xs">
                                {row.entity_id.slice(0, 8)}…
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.university_name ?? "—"}
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow className="bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={5}>
                          <div className="space-y-2 py-1">
                            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Metadata
                            </div>
                            {row.metadata ? (
                              <pre className="overflow-x-auto rounded-md border bg-background p-3 text-xs">
                                {JSON.stringify(row.metadata, null, 2)}
                              </pre>
                            ) : row.metadata_raw ? (
                              <pre className="overflow-x-auto rounded-md border bg-background p-3 text-xs">
                                {row.metadata_raw}
                              </pre>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                No metadata for this entry.
                              </p>
                            )}
                            <div className="grid grid-cols-1 gap-1 pt-1 text-xs text-muted-foreground sm:grid-cols-2">
                              <span>
                                Entity id:{" "}
                                <span className="font-mono">
                                  {row.entity_id ?? "—"}
                                </span>
                              </span>
                              <span>
                                Audit id:{" "}
                                <span className="font-mono">{row.id}</span>
                              </span>
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-col gap-2 border-t px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground">
              Showing {start}–{end} of {state.total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || state.status !== "ok"}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={!state.hasMore || state.status !== "ok"}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
