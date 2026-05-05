// /app/onboarding/lms — post-MFA "Connect your Learning Management System"
// step (UNI-57).
//
// The page renders three states driven by `GET /api/onboarding/lms-step`
// and the `?connected=canvas` / `?lms_error=...` query params the OAuth
// callback bounces back with:
//
//   1. `loading`      — initial fetch.
//   2. `eligible`     — show=true. List enabled providers + Skip link.
//   3. `connected`    — `?connected=canvas` is present in the URL.
//                       Render the "Connected — sync now or later" copy
//                       with a Continue button that lands on the
//                       integrations page.
//   4. `ineligible`   — show=false. Auto-redirect to the role-default
//                       dashboard (the SignInPage flow already handles
//                       this transparently, but a deep-linked visit
//                       should also bounce out cleanly).
//
// The Connect button reuses the same `startCanvasConnection` client as
// the standing /app/integrations page. The only difference: we pass
// `origin: 'onboarding'` so the OAuth callback redirects back here on
// success, not to /app/integrations.

import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, GraduationCap, Link2, Loader2 } from "lucide-react";

import type {
  LmsEnabledProvider,
  LmsOnboardingStepResponse,
  LmsProviderId,
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
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { defaultDashboardForRole } from "@/lib/default-dashboard";
import { startCanvasConnection } from "@/lib/lms-connections";
import {
  dismissOnboardingLmsStep,
  getOnboardingLmsStep,
} from "@/lib/onboarding";

type Phase =
  | { kind: "loading" }
  | { kind: "eligible"; providers: LmsEnabledProvider[] }
  | { kind: "ineligible" }
  | { kind: "error"; message: string };

export function OnboardingLmsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [pendingProvider, setPendingProvider] = useState<LmsProviderId | null>(
    null,
  );
  const [skipping, setSkipping] = useState(false);

  const connectedFromCallback = searchParams.get("connected") === "canvas";
  const lmsError = searchParams.get("lms_error");
  const errorDetail = searchParams.get("detail");

  // Bounce the lms_error query param to a destructive toast and strip it
  // off the URL so a refresh doesn't re-trigger. Same pattern as
  // /app/integrations — keep behavior identical so the user doesn't see
  // a different shape of failure on the onboarding page.
  useEffect(() => {
    if (!lmsError) return;
    toast({
      title: "Couldn't complete the Canvas connection",
      description: errorDetail
        ? `Canvas reported: ${errorDetail}`
        : "Please try again from /app/integrations.",
      variant: "destructive",
    });
    const next = new URLSearchParams(searchParams);
    next.delete("lms_error");
    next.delete("detail");
    setSearchParams(next, { replace: true });
  }, [lmsError, errorDetail, searchParams, setSearchParams]);

  // The success-side query param is consumed by the connected branch
  // below; we don't strip it eagerly so the SyncNowOrLaterStep can read
  // the same value. Refreshing the page after dismiss / continue will
  // re-run getOnboardingLmsStep (which now returns show=false) and
  // route the user out cleanly.
  useEffect(() => {
    if (connectedFromCallback) {
      // No need to fetch — `lms_onboarding_dismissed_at` is already
      // stamped server-side on the callback path, so a fetch would just
      // return show=false. Stay on the connected step until the user
      // clicks Continue.
      return;
    }
    const controller = new AbortController();
    setPhase({ kind: "loading" });
    getOnboardingLmsStep(controller.signal)
      .then((res: LmsOnboardingStepResponse) => {
        if (controller.signal.aborted) return;
        if (res.show) {
          setPhase({ kind: "eligible", providers: res.providers });
        } else {
          setPhase({ kind: "ineligible" });
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        // Don't trap the user — fail open so a flaky request just sends
        // them to the dashboard. The integrations page is always
        // reachable from the side nav.
        if (cause instanceof ApiClientError && cause.status === 401) {
          // Session went away; let ProtectedRoute re-route to sign-in.
          setPhase({ kind: "ineligible" });
          return;
        }
        setPhase({
          kind: "error",
          message:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not check your onboarding status.",
        });
      });
    return () => controller.abort();
  }, [connectedFromCallback]);

  const dashboardTarget = useMemo(
    () => (user ? defaultDashboardForRole(user.role) : "/app/dashboard"),
    [user],
  );

  if (phase.kind === "ineligible") {
    return <Navigate to={dashboardTarget} replace />;
  }

  async function handleConnect(entry: LmsEnabledProvider) {
    setPendingProvider(entry.provider_id);
    try {
      const res = await startCanvasConnection({
        purpose: `University Hub for ${entry.display_name} sync`,
        origin: "onboarding",
      });
      window.location.href = res.authorize_url;
    } catch (cause) {
      setPendingProvider(null);
      toast({
        title: `Couldn't start the ${entry.display_name} connect flow`,
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    }
  }

  async function handleSkip() {
    setSkipping(true);
    try {
      await dismissOnboardingLmsStep();
      toast({
        title: "You can connect later from Integrations",
        variant: "success",
      });
      navigate(dashboardTarget, { replace: true });
    } catch (cause) {
      setSkipping(false);
      toast({
        title: "Couldn't skip — please try again",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : undefined,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-2 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <GraduationCap className="h-6 w-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to University Hub
        </h1>
        <p className="text-sm text-muted-foreground">
          One quick step before you head to your dashboard.
        </p>
      </header>

      {connectedFromCallback ? (
        <ConnectedStep
          onContinue={() =>
            navigate("/app/integrations", { replace: true })
          }
          onSkipToDashboard={() => navigate(dashboardTarget, { replace: true })}
        />
      ) : phase.kind === "loading" ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-2/3" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : phase.kind === "error" ? (
        <ErrorState
          title="Couldn't load onboarding"
          description={phase.message}
          action={
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(dashboardTarget, { replace: true })}
            >
              Continue to your dashboard
            </Button>
          }
        />
      ) : (
        <ConnectStep
          providers={phase.providers}
          pendingProvider={pendingProvider}
          skipping={skipping}
          onConnect={handleConnect}
          onSkip={handleSkip}
        />
      )}
    </div>
  );
}

function ConnectStep({
  providers,
  pendingProvider,
  skipping,
  onConnect,
  onSkip,
}: {
  providers: LmsEnabledProvider[];
  pendingProvider: LmsProviderId | null;
  skipping: boolean;
  onConnect: (entry: LmsEnabledProvider) => void;
  onSkip: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Connect your Learning Management System</CardTitle>
        </div>
        <CardDescription>
          Bring your courses and students into University Hub by connecting
          your Canvas account. You can also skip this and connect later from
          the Integrations page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-3">
          {providers.map((entry) => {
            const busy = pendingProvider === entry.provider_id;
            return (
              <li
                key={entry.provider_id}
                className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">{entry.display_name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {entry.base_url}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onConnect(entry)}
                  disabled={busy || skipping}
                >
                  {busy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-2 h-4 w-4" />
                  )}
                  {busy ? "Redirecting…" : `Connect ${entry.display_name}`}
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={onSkip}
            disabled={skipping || pendingProvider !== null}
            className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            {skipping ? "Skipping…" : "Skip for now"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnectedStep({
  onContinue,
  onSkipToDashboard,
}: {
  onContinue: () => void;
  onSkipToDashboard: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          <CardTitle>Connected — sync now or later</CardTitle>
        </div>
        <CardDescription>
          Your Canvas account is linked. Head to the Integrations page when
          you're ready to choose a term and import your courses, or skip
          ahead to your dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onContinue}>
            Go to Integrations
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onSkipToDashboard}
          >
            Continue to your dashboard
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
