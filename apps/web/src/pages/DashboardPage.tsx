// /app/dashboard — first protected page rendered inside the AppShell.
// Demonstrates the full UX state palette from epic UNI-1 §26:
//
//   loading        — skeleton overview cards while /api/dashboard/summary
//                    resolves.
//   empty          — empty state in the recent activity panel when the
//                    summary returns zeros.
//   error          — ErrorState card when the fetch fails (caught from
//                    ApiClientError).
//   success toast  — fired on the demo "Quick action" button + on sign-out
//                    via UserMenu.
//   validation     — invitation-name dialog form refuses empty input and
//                    surfaces an inline error message + toast.
//   access-denied  — shown when the user attempts the "super_admin only"
//                    action and isn't a super_admin.
//   not-found      — surfaced via the dedicated NotFoundPage route; the
//                    dashboard links to it for QA convenience.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Building2,
  CheckCircle2,
  Mail,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";

import type { DashboardSummary } from "@university-hub/shared";
import { ROLE_LABELS } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { fetchDashboardSummary } from "@/lib/dashboard";

interface SummaryState {
  status: "loading" | "ok" | "error";
  data?: DashboardSummary;
  error?: string;
}

function StatCard({
  label,
  value,
  icon: Icon,
  helper,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  helper?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
        {helper ? (
          <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-8 rounded-md" />
      </CardHeader>
      <CardContent>
        <Skeleton className="mt-1 h-8 w-20" />
        <Skeleton className="mt-2 h-3 w-32" />
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<SummaryState>({ status: "loading" });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setSummary({ status: "loading" });
    fetchDashboardSummary(signal)
      .then((data) => {
        if (signal?.aborted) return;
        setSummary({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (signal?.aborted) return;
        const message =
          cause instanceof ApiClientError
            ? cause.message
            : "Could not load dashboard data.";
        setSummary({ status: "error", error: message });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const isEmpty = useMemo(() => {
    if (summary.status !== "ok" || !summary.data) return false;
    const { universities, users, invitations } = summary.data;
    return universities === 0 && users === 0 && invitations === 0;
  }, [summary]);

  const isSuperAdmin = user?.role === "super_admin";

  function handleQuickAction() {
    toast({
      title: "Quick action triggered",
      description: "This is a demo of the success toast UX state.",
      variant: "success",
    });
  }

  function handleAdminAction() {
    if (!isSuperAdmin) {
      toast({
        title: "Access denied",
        description: "Only super admins can perform this action.",
        variant: "destructive",
      });
      return;
    }
    toast({
      title: "Admin action complete",
      description: "Pretend we did something administrative.",
      variant: "success",
    });
  }

  function submitInvitePreview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = inviteName.trim();
    if (trimmed.length < 2) {
      setInviteError("Please enter a name with at least 2 characters.");
      return;
    }
    setInviteError(null);
    setInviteOpen(false);
    setInviteName("");
    toast({
      title: "Preview only",
      description: `Real invitation flow lands in UNI-9. (Name: ${trimmed})`,
      variant: "default",
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome back, {user?.name.split(" ")[0] ?? "friend"}.
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>Signed in as</span>
            <Badge variant="secondary">
              {user ? ROLE_LABELS[user.role] : "—"}
            </Badge>
            <span className="hidden sm:inline">·</span>
            <span className="font-mono text-xs">{user?.email}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => load()}
            disabled={summary.status === "loading"}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Overview cards (loading + empty + error UX states) */}
      <section aria-label="Overview" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {summary.status === "loading" ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : summary.status === "error" ? (
          <div className="sm:col-span-2 xl:col-span-3">
            <ErrorState
              title="Couldn't load dashboard data"
              description={summary.error}
              action={
                <Button variant="outline" size="sm" onClick={() => load()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : (
          <>
            <StatCard
              label="Universities"
              value={summary.data?.universities ?? 0}
              icon={Building2}
              helper="Active institutions"
            />
            <StatCard
              label="Users"
              value={summary.data?.users ?? 0}
              icon={Users}
              helper="Across all roles"
            />
            <StatCard
              label="Pending invitations"
              value={summary.data?.invitations ?? 0}
              icon={Send}
              helper="Awaiting acceptance"
            />
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent activity panel — empty state when summary is empty */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Recent activity</CardTitle>
              <CardDescription>
                Audit-log snapshot. Real entries land in UNI-15.
              </CardDescription>
            </div>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {summary.status === "loading" ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : isEmpty ? (
              <EmptyState
                icon={Activity}
                title="No activity yet"
                description="When users sign in, accept invitations, or update records, recent events will show up here."
              />
            ) : (
              <ul className="divide-y text-sm">
                <li className="flex items-center justify-between py-2">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    Sign-in succeeded
                  </span>
                  <span className="text-xs text-muted-foreground">
                    just now
                  </span>
                </li>
                <li className="flex items-center justify-between py-2">
                  <span className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    Placeholder activity row
                  </span>
                  <span className="text-xs text-muted-foreground">
                    seed data
                  </span>
                </li>
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Quick actions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick actions</CardTitle>
            <CardDescription>
              Try the UX states wired into this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button
              className="w-full justify-start"
              variant="default"
              onClick={handleQuickAction}
            >
              <Sparkles className="h-4 w-4" />
              Trigger success toast
            </Button>

            <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="w-full justify-start">
                  <Send className="h-4 w-4" />
                  Preview invitation form
                </Button>
              </DialogTrigger>
              <DialogContent>
                <form onSubmit={submitInvitePreview} noValidate>
                  <DialogHeader>
                    <DialogTitle>Invite a teammate</DialogTitle>
                    <DialogDescription>
                      Demo of the validation UX state — no email is actually sent.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-4">
                    <Label htmlFor="invite-name">Recipient name</Label>
                    <Input
                      id="invite-name"
                      autoFocus
                      value={inviteName}
                      onChange={(e) => {
                        setInviteName(e.target.value);
                        if (inviteError) setInviteError(null);
                      }}
                      placeholder="Ada Lovelace"
                      aria-invalid={inviteError ? "true" : "false"}
                      aria-describedby={
                        inviteError ? "invite-name-error" : undefined
                      }
                    />
                    {inviteError ? (
                      <p
                        id="invite-name-error"
                        className="text-xs font-medium text-destructive"
                      >
                        {inviteError}
                      </p>
                    ) : null}
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setInviteOpen(false);
                        setInviteName("");
                        setInviteError(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button type="submit">Send preview</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>

            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={handleAdminAction}
            >
              <ShieldAlert className="h-4 w-4" />
              Super-admin only action
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start"
              asChild
            >
              <Link to="/app/this-page-does-not-exist">
                <Activity className="h-4 w-4" />
                Visit a missing page (404 demo)
              </Link>
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start"
              asChild
            >
              <Link to="/app/ux">
                <Sparkles className="h-4 w-4" />
                Browse all UX states
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Summary placeholders by tab — keeps the page feeling complete */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="academic">Academic</TabsTrigger>
          <TabsTrigger value="invitations">Invitations</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">System health</CardTitle>
              <CardDescription>
                Backend wire-up sanity check.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {summary.status === "loading" ? (
                <Skeleton className="h-4 w-48" />
              ) : summary.status === "error" ? (
                <p className="text-sm text-destructive">
                  Worker is unreachable — see the error card above.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Worker reports{" "}
                  <span className="font-mono text-foreground">
                    /api/dashboard/summary
                  </span>{" "}
                  generated at{" "}
                  <time dateTime={summary.data?.generated_at}>
                    {summary.data?.generated_at}
                  </time>
                  .
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="academic">
          <EmptyState
            title="Manage academic structure"
            description="Departments and courses ship in UNI-12. Student / faculty / teacher / TA directories land in UNI-13."
          />
        </TabsContent>
        <TabsContent value="invitations">
          <EmptyState
            icon={Send}
            title="No pending invitations"
            description="Once invitation flows ship in UNI-9 you'll see status, last-sent date, and resend controls here."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
