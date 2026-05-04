// /app/email-logs — admin email-delivery viewer (epic UNI-1 §9, §16, §17 +
// UNI-14). Restricted to super_admin and university_admin (every other role
// receives 403 from the backend; this page also hides the data and shows the
// access-denied state when reached directly).
//
// Table shows recipient, type, template, Mailgun message ID, status, error
// summary, related entity, and date. Filters mirror the backend.

import { useEffect, useMemo, useState } from "react";
import { Filter, Mail, RefreshCw } from "lucide-react";

import {
  EMAIL_LOG_STATUSES,
  EMAIL_LOG_STATUS_LABELS,
  EMAIL_TYPES,
  EMAIL_TYPE_LABELS,
  type EmailLogListItem,
  type EmailLogStatus,
  type EmailType,
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
  listEmailLogs,
  type EmailLogListFilters,
} from "@/lib/email-logs";

const PAGE_SIZE = 50;

const VIEWER_ROLES: ReadonlySet<string> = new Set([
  "super_admin",
  "university_admin",
]);

const STATUS_VARIANTS: Record<EmailLogStatus, BadgeProps["variant"]> = {
  sent: "success",
  failed: "destructive",
  pending: "warning",
};

function StatusBadge({ status }: { status: EmailLogStatus }) {
  return (
    <Badge variant={STATUS_VARIANTS[status]}>
      {EMAIL_LOG_STATUS_LABELS[status]}
    </Badge>
  );
}

interface RelatedEntityLinkProps {
  type: string | null;
  id: string | null;
}

function RelatedEntityLink({ type, id }: RelatedEntityLinkProps) {
  if (!type || !id) return <span className="text-muted-foreground">—</span>;
  // Map of entity types we know how to deep-link into. Anything else just
  // renders the short id without a link so the row stays useful.
  const path = (() => {
    switch (type) {
      case "invitation":
        // No detail page for an individual invitation yet; deep-link to the
        // list (the row id is shown adjacent for reference).
        return "/app/invitations";
      case "user":
        return `/app/users/${id}`;
      case "contact_message":
        return null;
      default:
        return null;
    }
  })();
  const label = (
    <span>
      {type}
      <span className="ml-1 font-mono text-xs">{id.slice(0, 8)}…</span>
    </span>
  );
  if (!path) return <span className="text-sm text-muted-foreground">{label}</span>;
  return (
    <a
      href={path}
      className="text-sm text-primary underline-offset-2 hover:underline"
    >
      {label}
    </a>
  );
}

interface ListState {
  status: "loading" | "ok" | "error";
  items: EmailLogListItem[];
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

export function EmailLogsPage() {
  const { user } = useAuth();
  const canView = !!user && VIEWER_ROLES.has(user.role);

  const [state, setState] = useState<ListState>(INITIAL_STATE);
  const [typeFilter, setTypeFilter] = useState<EmailType | "all">("all");
  const [statusFilter, setStatusFilter] = useState<EmailLogStatus | "all">(
    "all",
  );
  const [recipientInput, setRecipientInput] = useState("");
  const [debouncedRecipient, setDebouncedRecipient] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedRecipient(recipientInput.trim()), 250);
    return () => clearTimeout(t);
  }, [recipientInput]);

  useEffect(() => {
    setPage(0);
  }, [typeFilter, statusFilter, debouncedRecipient, from, to]);

  const filters: EmailLogListFilters = useMemo(() => {
    const f: EmailLogListFilters = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (typeFilter !== "all") f.email_type = typeFilter;
    if (statusFilter !== "all") f.status = statusFilter;
    if (debouncedRecipient) f.recipient = debouncedRecipient;
    if (from) f.from = new Date(from).toISOString();
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      f.to = end.toISOString();
    }
    return f;
  }, [typeFilter, statusFilter, debouncedRecipient, from, to, page]);

  function load(signal?: AbortSignal) {
    if (!canView) return;
    setState((prev) => ({ ...prev, status: "loading" }));
    listEmailLogs(filters, signal)
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
              : "Could not load email logs.",
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
        description="Email logs are restricted to super admins and university admins."
      />
    );
  }

  const start = state.items.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = page * PAGE_SIZE + state.items.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Email logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Mailgun delivery attempts: invitations, password resets,
            notifications, and account-status emails.
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
              Filter by type, status, recipient, or time window.
            </CardDescription>
          </div>
          <Filter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Type
              </label>
              <select
                value={typeFilter}
                onChange={(e) =>
                  setTypeFilter(e.target.value as EmailType | "all")
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All types</option>
                {EMAIL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EMAIL_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Status
              </label>
              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as EmailLogStatus | "all")
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="all">All statuses</option>
                {EMAIL_LOG_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {EMAIL_LOG_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Recipient
              </label>
              <Input
                placeholder="email contains…"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
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
          title="Couldn't load email logs"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : state.items.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No email logs match these filters"
          description="Try clearing filters or expanding the date range."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Recipient</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Mailgun ID</TableHead>
                <TableHead>Related</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {formatDateTime(row.created_at)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {EMAIL_TYPE_LABELS[row.type]}
                  </TableCell>
                  <TableCell className="text-sm">{row.recipient_email}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {row.template_name ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.mailgun_message_id ? (
                      <span title={row.mailgun_message_id}>
                        {row.mailgun_message_id.slice(0, 16)}
                        {row.mailgun_message_id.length > 16 ? "…" : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <RelatedEntityLink
                      type={row.related_entity_type}
                      id={row.related_entity_id}
                    />
                  </TableCell>
                  <TableCell className="max-w-xs text-sm text-muted-foreground">
                    {row.error ? (
                      <span title={row.error} className="text-destructive">
                        {row.error.length > 80
                          ? row.error.slice(0, 77) + "…"
                          : row.error}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
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
