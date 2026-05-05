// /app/users/:id — admin user profile (epic UNI-1 §28).
//
// Shows the user, lets the actor change their role and toggle status with
// confirmation dialogs. Backend re-enforces every privilege; this UI only
// hides options the actor isn't allowed to use.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  KeyRound,
  ShieldOff,
  ShieldCheck,
  Trash2,
  UserCog,
  UserX,
} from "lucide-react";

import {
  ROLE_LABELS,
  canManageTargetUser,
  displayUserName,
  rolesAssignableBy,
  type Role,
  type UpdateUserStatusInput,
  type UserListItem,
} from "@university-hub/shared";

// The PATCH /api/users/:id/status endpoint only accepts active/inactive/
// suspended — admins shouldn't toggle a user back into `pending` (that's
// invitation-flow territory). Mirror the input schema's union here.
type ManageableStatus = UpdateUserStatusInput["status"];

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { deleteUser, getUser, updateUserRole, updateUserStatus } from "@/lib/users";

interface State {
  status: "loading" | "ok" | "error";
  data?: UserListItem;
  error?: string;
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const [state, setState] = useState<State>({ status: "loading" });
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [pendingStatus, setPendingStatus] = useState<ManageableStatus | null>(null);
  // The remove dialog requires the operator to type the user's email so a
  // mistyped url or a fat-finger click on the destructive button doesn't
  // accidentally tombstone the wrong user.
  const [removeEmailConfirm, setRemoveEmailConfirm] = useState("");
  const [removeReason, setRemoveReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function load(signal?: AbortSignal) {
    if (!id) return;
    setState({ status: "loading" });
    getUser(id, signal)
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
              : "Could not load user.",
        });
      });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const target = state.data;

  const allowedRoles = useMemo<readonly Role[]>(() => {
    if (!currentUser || !target) return [];
    if (!canManageTargetUser(currentUser.role, target.role)) return [];
    return rolesAssignableBy(currentUser.role);
  }, [currentUser, target]);

  const canActOnTarget = useMemo(() => {
    if (!currentUser || !target) return false;
    if (currentUser.id === target.id) return false; // no self-management
    return canManageTargetUser(currentUser.role, target.role);
  }, [currentUser, target]);

  async function applyRoleChange(newRole: Role) {
    if (!id || !target) return;
    setSubmitting(true);
    try {
      const updated = await updateUserRole(id, { role: newRole });
      setState({ status: "ok", data: updated });
      toast({
        title: "Role updated",
        description: `${updated.name} is now ${ROLE_LABELS[updated.role]}.`,
        variant: "success",
      });
      setRoleDialogOpen(false);
      setPendingRole(null);
    } catch (cause) {
      toast({
        title: "Role change failed",
        description:
          cause instanceof ApiClientError ? cause.message : "Could not change role.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function applyRemove() {
    if (!id || !target) return;
    setSubmitting(true);
    try {
      const result = await deleteUser(id, removeReason ? { reason: removeReason } : {});
      const tone = result.idempotent ? "default" : "success";
      toast({
        title: result.idempotent ? "User already removed" : "User removed",
        description: result.idempotent
          ? "This account had already been removed; nothing changed."
          : "Their credentials are gone and their record is anonymized.",
        variant: tone,
      });
      setRemoveDialogOpen(false);
      // Navigate back to the directory; the removed user's row stays
      // accessible via "Show removed users" if QA needs to verify the
      // anonymized state.
      navigate("/app/users");
    } catch (cause) {
      toast({
        title: "Could not remove user",
        description:
          cause instanceof ApiClientError ? cause.message : "Removal failed.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function applyStatusChange(newStatus: ManageableStatus) {
    if (!id || !target) return;
    setSubmitting(true);
    try {
      const result = await updateUserStatus(id, { status: newStatus });
      setState({ status: "ok", data: result.user });
      if (result.email_status === "sent") {
        toast({
          title: "Status updated",
          description: `${result.user.name} has been notified by email.`,
          variant: "success",
        });
      } else {
        // Mailgun unconfigured (or otherwise failing) — the user record was
        // updated but the email did not go out. Surface this clearly.
        toast({
          title: "Status updated, email not sent",
          description: result.email_error ?? "Email delivery failed.",
          variant: "default",
        });
      }
      setStatusDialogOpen(false);
      setPendingStatus(null);
    } catch (cause) {
      toast({
        title: "Status change failed",
        description:
          cause instanceof ApiClientError ? cause.message : "Could not change status.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to="/app/users">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">User</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/4" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load user" description={state.error} />
      ) : target ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{displayUserName(target)}</CardTitle>
                  <CardDescription>{target.email}</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <RoleBadge role={target.role} />
                  <UserStatusBadge status={target.status} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                University:{" "}
                <span className="font-medium text-foreground">
                  {target.university_name ?? "—"}
                </span>
              </div>
              <div>
                Last sign-in:{" "}
                {target.last_sign_in_at
                  ? new Date(target.last_sign_in_at).toLocaleString()
                  : "Never"}
              </div>
              <div>Member since {new Date(target.created_at).toLocaleDateString()}</div>
            </CardContent>
          </Card>

          {canActOnTarget ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Actions</CardTitle>
                <CardDescription>
                  Every change is recorded in the audit log.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {allowedRoles.length > 0 ? (
                  <Button variant="outline" onClick={() => setRoleDialogOpen(true)}>
                    <UserCog className="h-4 w-4" />
                    Change role
                  </Button>
                ) : null}
                {target.status !== "active" ? (
                  <Button
                    variant="default"
                    onClick={() => {
                      setPendingStatus("active");
                      setStatusDialogOpen(true);
                    }}
                  >
                    <ShieldCheck className="h-4 w-4" />
                    Activate
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setPendingStatus("inactive");
                      setStatusDialogOpen(true);
                    }}
                  >
                    <ShieldOff className="h-4 w-4" />
                    Deactivate
                  </Button>
                )}
                {target.status !== "suspended" ? (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setPendingStatus("suspended");
                      setStatusDialogOpen(true);
                    }}
                  >
                    <UserX className="h-4 w-4" />
                    Suspend
                  </Button>
                ) : null}
                {target.status !== "deleted" ? (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setRemoveEmailConfirm("");
                      setRemoveReason("");
                      setRemoveDialogOpen(true);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove user
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <KeyRound className="h-4 w-4" />
                You don't have permission to modify this user.
              </CardContent>
            </Card>
          )}

          <Dialog open={roleDialogOpen} onOpenChange={setRoleDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Change role for {target.name}</DialogTitle>
                <DialogDescription>
                  Pick the new role. The user will be notified by email if their
                  permissions change.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="role-select">New role</Label>
                <select
                  id="role-select"
                  value={pendingRole ?? target.role}
                  onChange={(e) => setPendingRole(e.target.value as Role)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  disabled={submitting}
                >
                  {allowedRoles.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setRoleDialogOpen(false);
                    setPendingRole(null);
                  }}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => applyRoleChange(pendingRole ?? target.role)}
                  disabled={submitting || (pendingRole ?? target.role) === target.role}
                >
                  {submitting ? "Saving…" : "Confirm change"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Remove user</DialogTitle>
                <DialogDescription>
                  This is irreversible. The account's credentials will be
                  destroyed and their personal information anonymized
                  (name, email, MFA secrets). Educational records (grades,
                  enrollments, audit log entries, FERPA disclosure log) are
                  preserved per the institution's retention policy.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>Active sessions, MFA secrets, and trusted devices are deleted.</li>
                  <li>Pending invitations addressed to this user are revoked.</li>
                  <li>Active disclosure consents are revoked (logged, not deleted).</li>
                  <li>
                    The user's name will display as <em>Removed User #N</em> across
                    the platform from now on.
                  </li>
                </ul>
                <div>
                  <Label htmlFor="remove-confirm">
                    Type <span className="font-mono">{target.email}</span> to confirm.
                  </Label>
                  <input
                    id="remove-confirm"
                    type="email"
                    autoComplete="off"
                    value={removeEmailConfirm}
                    onChange={(e) => setRemoveEmailConfirm(e.target.value)}
                    className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={submitting}
                  />
                </div>
                <div>
                  <Label htmlFor="remove-reason">Reason (optional)</Label>
                  <textarea
                    id="remove-reason"
                    rows={3}
                    maxLength={500}
                    value={removeReason}
                    onChange={(e) => setRemoveReason(e.target.value)}
                    placeholder="e.g. Off-boarded — contract ended 2026-05-31"
                    className="mt-1 flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={submitting}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recorded in the audit log alongside the actor's identity.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRemoveDialogOpen(false)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={applyRemove}
                  disabled={submitting || removeEmailConfirm.trim() !== target.email}
                >
                  {submitting ? "Removing…" : "Remove"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={statusDialogOpen} onOpenChange={setStatusDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {pendingStatus === "active"
                    ? `Activate ${target.name}?`
                    : pendingStatus === "inactive"
                      ? `Deactivate ${target.name}?`
                      : `Suspend ${target.name}?`}
                </DialogTitle>
                <DialogDescription>
                  {pendingStatus === "active"
                    ? "They'll regain access immediately and receive an email confirmation."
                    : pendingStatus === "inactive"
                      ? "They'll be signed out and lose access until reactivated. We'll email them about the change."
                      : "They'll be locked out and flagged for security review. We'll email them about the change."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setStatusDialogOpen(false);
                    setPendingStatus(null);
                  }}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant={pendingStatus === "suspended" ? "destructive" : "default"}
                  onClick={() => pendingStatus && applyStatusChange(pendingStatus)}
                  disabled={submitting || !pendingStatus}
                >
                  {submitting ? "Saving…" : "Confirm"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}
