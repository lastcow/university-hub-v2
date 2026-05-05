// /app/onboarding/lms — post-MFA "Connect your Learning Management System"
// step (UNI-57; reshaped in UNI-63 to use per-user Personal Access
// Tokens instead of an OAuth callback round-trip).
//
// The page renders three states driven by `GET /api/onboarding/lms-step`:
//
//   1. `loading`      — initial fetch.
//   2. `eligible`     — show=true. List enabled providers with an
//                       inline PAT entry per provider, plus a Skip link.
//   3. `connected`    — local state set after a successful PAT save.
//                       Render the "Connected — sync now or later" copy
//                       with a Continue button that lands on the
//                       integrations page.
//   4. `ineligible`   — show=false. Auto-redirect to the role-default
//                       dashboard.
//
// The Connect form reuses the same `connectCanvasConnection` client
// as the standing /app/integrations page; the connect endpoint stamps
// `users.lms_onboarding_dismissed_at` on success so a refresh after
// connect will route the user out via `getOnboardingLmsStep`.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
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
import { connectCanvasConnection } from "@/lib/lms-connections";
import {
  dismissOnboardingLmsStep,
  getOnboardingLmsStep,
} from "@/lib/onboarding";

type Phase =
  | { kind: "loading" }
  | { kind: "eligible"; providers: LmsEnabledProvider[] }
  | { kind: "connected" }
  | { kind: "ineligible" }
  | { kind: "error"; message: string };

export function OnboardingLmsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [pendingProvider, setPendingProvider] = useState<LmsProviderId | null>(
    null,
  );
  const [skipping, setSkipping] = useState(false);

  useEffect(() => {
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
  }, []);

  const dashboardTarget = useMemo(
    () => (user ? defaultDashboardForRole(user.role) : "/app/dashboard"),
    [user],
  );

  if (phase.kind === "ineligible") {
    return <Navigate to={dashboardTarget} replace />;
  }

  async function handleConnect(
    entry: LmsEnabledProvider,
    personalAccessToken: string,
  ) {
    setPendingProvider(entry.provider_id);
    try {
      await connectCanvasConnection({
        personal_access_token: personalAccessToken,
      });
      toast({
        title: `${entry.display_name} connected`,
        variant: "success",
      });
      setPhase({ kind: "connected" });
    } catch (cause) {
      toast({
        title: `Couldn't save your ${entry.display_name} access token`,
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setPendingProvider(null);
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
          cause instanceof ApiClientError ? cause.message : undefined,
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

      {phase.kind === "connected" ? (
        <ConnectedStep
          onContinue={() => navigate("/app/integrations", { replace: true })}
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
  onConnect: (
    entry: LmsEnabledProvider,
    personalAccessToken: string,
  ) => Promise<void>;
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
          Generate a Personal Access Token in Canvas (Account → Settings →
          "+ New Access Token") and paste it below to bring your courses and
          students into University Hub. You can also skip this and connect
          later from the Integrations page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-3">
          {providers.map((entry) => (
            <li
              key={entry.provider_id}
              className="rounded-md border bg-muted/30 p-4"
            >
              <ProviderConnectForm
                entry={entry}
                busy={pendingProvider === entry.provider_id}
                disabled={skipping || pendingProvider !== null}
                onSubmit={(token) => onConnect(entry, token)}
              />
            </li>
          ))}
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

function ProviderConnectForm({
  entry,
  busy,
  disabled,
  onSubmit,
}: {
  entry: LmsEnabledProvider;
  busy: boolean;
  disabled: boolean;
  onSubmit: (personalAccessToken: string) => Promise<void>;
}) {
  const [pat, setPat] = useState("");
  const tokenSettingsUrl = `${entry.base_url.replace(/\/+$/, "")}/profile/settings#access_tokens`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = pat.trim();
    if (trimmed.length === 0) return;
    await onSubmit(trimmed);
    setPat("");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">{entry.display_name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {entry.base_url}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        Generate a token at{" "}
        <a
          href={tokenSettingsUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline"
        >
          Account → Settings → Approved Integrations
        </a>{" "}
        and paste it here. We store it encrypted at rest.
      </p>
      <input
        type="password"
        autoComplete="off"
        value={pat}
        onChange={(event) => setPat(event.target.value)}
        disabled={disabled || busy}
        required
        placeholder="Paste your Canvas access token"
        className="w-full rounded-md border bg-background p-2 font-mono text-sm"
        aria-label={`${entry.display_name} access token`}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={disabled || busy || pat.trim().length === 0}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Link2 className="mr-2 h-4 w-4" />
          )}
          {busy ? "Validating…" : `Connect ${entry.display_name}`}
        </Button>
      </div>
    </form>
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
