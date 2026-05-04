// /accept-invitation?token=… — public landing for an invitation email.
//
// Three phases:
//   1. lookup    — call GET /api/invitations/lookup, branch on result
//   2. valid     — render the account-setup form
//   3. submitted — POST /api/invitations/accept, on success the backend sets
//                  a session cookie so we hydrate AuthContext and redirect to
//                  /app/dashboard. Anything non-2xx maps to a friendly error.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, GraduationCap, MailX, ShieldAlert } from "lucide-react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { ROLE_LABELS, type InvitationLookupResult } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { acceptInvitation, lookupInvitation } from "@/lib/invitations";

type LookupState =
  | { kind: "loading" }
  | { kind: "missing-token" }
  | { kind: "result"; result: InvitationLookupResult };

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const navigate = useNavigate();
  const { status: authStatus, refresh } = useAuth();

  const [lookup, setLookup] = useState<LookupState>(() =>
    token ? { kind: "loading" } : { kind: "missing-token" },
  );

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setLookup({ kind: "loading" });
    lookupInvitation(token, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLookup({ kind: "result", result });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiClientError) {
          setLookup({ kind: "result", result: { status: "invalid" } });
        } else {
          setLookup({ kind: "result", result: { status: "invalid" } });
        }
      });
    return () => controller.abort();
  }, [token]);

  const validResult = useMemo(
    () => (lookup.kind === "result" && lookup.result.status === "valid" ? lookup.result : null),
    [lookup],
  );

  // If the visitor lands here while already signed in, send them to the app.
  if (authStatus === "authenticated" && lookup.kind !== "loading") {
    return <Navigate to="/app/dashboard" replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !validResult) return;
    setFormError(null);
    setFieldErrors({});

    if (password !== confirmPassword) {
      setFieldErrors({ confirmPassword: "Passwords do not match" });
      return;
    }
    setSubmitting(true);
    try {
      await acceptInvitation({
        token,
        email: validResult.email,
        name: name.trim(),
        password,
        confirmPassword,
      });
      // Auto sign-in: backend set the cookie, hydrate AuthContext.
      await refresh();
      toast({
        title: "Welcome aboard",
        description: "Your account is ready.",
        variant: "success",
      });
      navigate("/app/dashboard", { replace: true });
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        // Backend may surface per-field issues from zod; propagate them.
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
        if (cause.code === "already_accepted" || cause.code === "expired" || cause.code === "revoked") {
          // The invitation flipped state between lookup and submit — re-render
          // the appropriate branch instead of leaving the form open.
          setLookup({
            kind: "result",
            result: { status: cause.code === "already_accepted" ? "accepted" : cause.code },
          });
          return;
        }
        setFormError(cause.message);
      } else {
        setFormError("Could not accept the invitation. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <span
              aria-hidden
              className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
            >
              U
            </span>
            University Hub
          </Link>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">
            Accept your invitation
          </h1>
        </div>

        {lookup.kind === "loading" ? (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
            Checking your invitation…
          </div>
        ) : lookup.kind === "missing-token" ? (
          <InvitationMessage
            tone="warning"
            icon={ShieldAlert}
            title="Missing invitation token"
            description="The invitation link looks incomplete. Open the link from your invitation email or ask your administrator to resend it."
          />
        ) : lookup.result.status === "invalid" ? (
          <InvitationMessage
            tone="error"
            icon={MailX}
            title="Invalid invitation"
            description="We couldn't find this invitation. The link may be wrong or no longer valid. Ask your administrator to send a new one."
          />
        ) : lookup.result.status === "expired" ? (
          <InvitationMessage
            tone="warning"
            icon={MailX}
            title="Invitation expired"
            description="This invitation has expired. Ask your administrator to send a new one."
          />
        ) : lookup.result.status === "revoked" ? (
          <InvitationMessage
            tone="error"
            icon={ShieldAlert}
            title="Invitation revoked"
            description="This invitation has been revoked. Ask your administrator if this was unexpected."
          />
        ) : lookup.result.status === "accepted" ? (
          <InvitationMessage
            tone="success"
            icon={CheckCircle2}
            title="Already accepted"
            description="This invitation has already been used. Sign in with your credentials."
            action={
              <Button asChild>
                <Link to="/sign-in">Go to sign in</Link>
              </Button>
            }
          />
        ) : (
          <form
            onSubmit={onSubmit}
            noValidate
            className="space-y-4 rounded-lg border bg-card p-6 shadow-sm"
          >
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <GraduationCap className="h-4 w-4" />
                <span>You've been invited to</span>
              </div>
              <p className="mt-1 font-medium">
                {lookup.result.university_name ?? "University Hub"}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Role: {ROLE_LABELS[lookup.result.role]}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={lookup.result.email}
                readOnly
                aria-readonly
                className="bg-muted/60"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Full name</Label>
              <Input
                id="name"
                type="text"
                value={name}
                autoComplete="name"
                required
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                aria-invalid={fieldErrors.name ? "true" : "false"}
              />
              {fieldErrors.name ? (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                autoComplete="new-password"
                required
                minLength={8}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                aria-invalid={fieldErrors.password ? "true" : "false"}
              />
              {fieldErrors.password ? (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.password}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  At least 8 characters.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                required
                minLength={8}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
                aria-invalid={fieldErrors.confirmPassword ? "true" : "false"}
              />
              {fieldErrors.confirmPassword ? (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.confirmPassword}
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

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Creating account…" : "Create account & sign in"}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              By accepting you agree to your university's terms of use.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

interface InvitationMessageProps {
  tone: "success" | "warning" | "error";
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}

function InvitationMessage({
  tone,
  icon: Icon,
  title,
  description,
  action,
}: InvitationMessageProps) {
  const accent =
    tone === "success"
      ? "text-emerald-600"
      : tone === "warning"
        ? "text-amber-600"
        : "text-destructive";
  return (
    <div className="rounded-lg border bg-card p-6 text-center shadow-sm">
      <div
        className={`mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted ${accent}`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <p className="text-base font-semibold">{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5 flex flex-col items-center gap-2">
        {action ?? null}
        <Button asChild variant="ghost" size="sm">
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </div>
    </div>
  );
}
