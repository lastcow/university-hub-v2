// /app/invitations — admin page (epic UNI-1 §27).
//
// Lists invitations with status + last-email-delivery info. Admin actions:
// create (modal), revoke (pending only), resend (pending + not expired).
// RBAC: rendered behind a role check; backend re-enforces every call.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Filter,
  Mail,
  RefreshCw,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";

import {
  INVITATION_ROLE_GROUP_LABELS,
  ROLE_LABELS,
  canInvite,
  invitableRoleGroups,
  type CreateInvitationInput,
  type InvitationListItem,
  type InvitationStatus,
  type Role,
} from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import {
  EmailDeliveryBadge,
  InvitationStatusBadge,
} from "@/components/InvitationStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/data-table";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import {
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from "@/lib/invitations";

interface ListState {
  status: "loading" | "ok" | "error";
  data?: InvitationListItem[];
  error?: string;
}

const STATUS_FILTERS: ReadonlyArray<{ label: string; value: InvitationStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Accepted", value: "accepted" },
  { label: "Expired", value: "expired" },
  { label: "Revoked", value: "revoked" },
];

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

export function InvitationsPage() {
  const { user } = useAuth();
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [statusFilter, setStatusFilter] = useState<InvitationStatus | "all">("all");
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const allowedToInvite = !!user && canInvite(user.role);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setState({ status: "loading" });
      listInvitations(
        statusFilter === "all" ? {} : { status: statusFilter },
        signal,
      )
        .then((data) => {
          if (signal?.aborted) return;
          setState({ status: "ok", data });
        })
        .catch((cause: unknown) => {
          if (signal?.aborted) return;
          const message =
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load invitations.";
          setState({ status: "error", error: message });
        });
    },
    [statusFilter],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onRevoke(item: InvitationListItem) {
    if (!confirm(`Revoke the invitation to ${item.email}?`)) return;
    setPendingActionId(item.id);
    try {
      await revokeInvitation(item.id);
      toast({
        title: "Invitation revoked",
        description: `${item.email} can no longer accept this invitation.`,
        variant: "default",
      });
      load();
    } catch (cause) {
      toast({
        title: "Revoke failed",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Could not revoke the invitation.",
        variant: "destructive",
      });
    } finally {
      setPendingActionId(null);
    }
  }

  async function onResend(item: InvitationListItem) {
    setPendingActionId(item.id);
    try {
      const result = await resendInvitation(item.id);
      if (result.email_status === "sent") {
        toast({
          title: "Invitation resent",
          description: `A new email is on its way to ${item.email}.`,
          variant: "success",
        });
      } else {
        toast({
          title: "Email delivery failed",
          description:
            result.email_error ??
            "The invitation was updated but the email could not be sent.",
          variant: "destructive",
        });
      }
      load();
    } catch (cause) {
      toast({
        title: "Resend failed",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Could not resend the invitation.",
        variant: "destructive",
      });
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invitations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Send invitations, monitor delivery, and manage open invites.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => load()} disabled={state.status === "loading"}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          {allowedToInvite ? (
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Send className="h-4 w-4" />
                  New invitation
                </Button>
              </DialogTrigger>
              <DialogContent>
                <CreateInvitationForm
                  actorRole={user!.role}
                  onCreated={() => {
                    setCreateOpen(false);
                    load();
                  }}
                  onCancel={() => setCreateOpen(false)}
                />
              </DialogContent>
            </Dialog>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Filter by status</CardTitle>
            <CardDescription>
              Showing the most recent {state.data?.length ?? 0} invitations.
            </CardDescription>
          </div>
          <Filter className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1">
            {STATUS_FILTERS.map((filter) => {
              const isActive = statusFilter === filter.value;
              return (
                <Button
                  key={filter.value}
                  type="button"
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {filter.label}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {state.status === "loading" ? (
        <Card>
          <CardContent className="space-y-3 py-6">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </CardContent>
        </Card>
      ) : state.status === "error" ? (
        <ErrorState
          title="Couldn't load invitations"
          description={state.error}
          action={
            <Button size="sm" variant="outline" onClick={() => load()}>
              Try again
            </Button>
          }
        />
      ) : (state.data ?? []).length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No invitations yet"
          description={
            allowedToInvite
              ? "Use the New invitation button to invite someone."
              : "Once an admin sends invitations they'll appear here."
          }
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Email delivery</TableHead>
                <TableHead>Last sent</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.data!.map((row) => {
                const canResend = row.status === "pending";
                const canRevoke = row.status === "pending";
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{row.email}</span>
                        {row.invited_by_name ? (
                          <span className="text-xs text-muted-foreground">
                            Invited by {row.invited_by_name}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{ROLE_LABELS[row.role]}</Badge>
                    </TableCell>
                    <TableCell>
                      <InvitationStatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <EmailDeliveryBadge status={row.last_email_status} />
                        {row.last_email_status === "failed" && row.last_email_error ? (
                          <span className="flex items-start gap-1 text-xs text-destructive">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            <span className="line-clamp-2">{row.last_email_error}</span>
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.last_email_sent_at)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(row.expires_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canResend || pendingActionId === row.id}
                          onClick={() => onResend(row)}
                        >
                          <Send className="h-3.5 w-3.5" />
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!canRevoke || pendingActionId === row.id}
                          onClick={() => onRevoke(row)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      </div>
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

interface CreateInvitationFormProps {
  actorRole: Role;
  onCreated: () => void;
  onCancel: () => void;
}

function CreateInvitationForm({
  actorRole,
  onCreated,
  onCancel,
}: CreateInvitationFormProps) {
  const groups = useMemo(() => invitableRoleGroups(actorRole), [actorRole]);
  const firstRole = groups[0]?.roles[0] ?? null;

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role | null>(firstRole);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    if (!role) {
      setFormError("You don't have permission to invite anyone.");
      return;
    }

    setSubmitting(true);
    try {
      const payload: CreateInvitationInput = { email, role };
      const result = await createInvitation(payload);
      if (result.email_status === "sent") {
        toast({
          title: "Invitation sent",
          description: `${email} will receive an email shortly.`,
          variant: "success",
        });
      } else {
        toast({
          title: "Invitation created",
          description:
            "Email delivery failed — try resending after fixing the email configuration.",
          variant: "default",
        });
      }
      onCreated();
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        const issues = (cause.details?.issues ?? null) as
          | Record<string, string[]>
          | null;
        if (issues) {
          const flat: Record<string, string> = {};
          for (const [k, v] of Object.entries(issues)) {
            if (Array.isArray(v) && v[0]) flat[k] = v[0];
          }
          setFieldErrors(flat);
        }
        setFormError(cause.message);
      } else {
        setFormError("Could not create invitation. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (groups.length === 0) {
    return (
      <div className="space-y-3">
        <DialogHeader>
          <DialogTitle>You can't invite users</DialogTitle>
          <DialogDescription>
            Your role doesn't have permission to send invitations. Ask an
            administrator if this was unexpected.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            <XCircle className="h-4 w-4" />
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <DialogHeader>
        <DialogTitle>Invite someone</DialogTitle>
        <DialogDescription>
          They'll receive an email with a single-use accept link. The link
          expires after seven days.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input
          id="invite-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
          aria-invalid={fieldErrors.email ? "true" : "false"}
        />
        {fieldErrors.email ? (
          <p className="text-xs font-medium text-destructive">
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="invite-role">Role</Label>
        <select
          id="invite-role"
          value={role ?? ""}
          onChange={(e) => setRole(e.target.value as Role)}
          disabled={submitting}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {groups.map((group) => (
            <optgroup
              key={group.group}
              label={INVITATION_ROLE_GROUP_LABELS[group.group]}
            >
              {group.roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {fieldErrors.role ? (
          <p className="text-xs font-medium text-destructive">
            {fieldErrors.role}
          </p>
        ) : null}
      </div>

      {formError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send invitation"}
        </Button>
      </DialogFooter>
    </form>
  );
}
