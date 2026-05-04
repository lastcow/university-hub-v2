// /sign-in/parent — parent / guardian passwordless sign-in (UNI-32).
//
// Two steps:
//
//   1. Request — the parent enters their email; we email them a token. We
//      always show the same generic "if a match exists, a link is on the
//      way" copy so the institution doesn't disclose which under-18 students
//      it knows about.
//
//   2. Verify — the parent enters the token they got by email. On success
//      they're redirected to the parent dashboard.
//
// The link emailed to the parent puts `?parent_email=&token=` on the URL so
// they can hit verify in one click.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { ApiClientError } from "@/lib/api";
import {
  fetchParentMe,
  requestParentSignIn,
  verifyParentSignIn,
} from "@/lib/disclosures";
import { cn } from "@/lib/utils";

type Step = "request" | "verify" | "sent";

export function ParentSignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialEmail = params.get("parent_email") ?? "";
  const initialToken = params.get("token") ?? "";

  const [step, setStep] = useState<Step>(initialToken ? "verify" : "request");
  const [email, setEmail] = useState(initialEmail);
  const [token, setToken] = useState(initialToken);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If a parent session is already live, send them straight to the dashboard.
  useEffect(() => {
    let cancelled = false;
    fetchParentMe()
      .then(() => {
        if (!cancelled) navigate("/parent", { replace: true });
      })
      .catch(() => {
        // 401 is expected; ignore.
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await requestParentSignIn({ parent_email: email });
      setStep("sent");
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : "Could not request a sign-in link. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function onVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await verifyParentSignIn({ parent_email: email, token });
      navigate("/parent", { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : "Could not verify the sign-in link. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Parent / guardian sign-in
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only access to your under-18 student's grades and records.
          </p>
        </div>

        {step === "request" ? (
          <form
            className="space-y-4 rounded-lg border bg-card p-6 shadow-sm"
            onSubmit={onRequest}
            noValidate
          >
            <div className="space-y-2">
              <label htmlFor="parent-email" className="text-sm font-medium">
                Parent / guardian email
              </label>
              <input
                id="parent-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className={cn(
                  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              />
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Sending…" : "Send me a sign-in link"}
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setStep("verify")}
            >
              I already have a token
            </button>
          </form>
        ) : step === "sent" ? (
          <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm text-sm">
            <p>
              If a parent or guardian email matches a student in our records, a
              sign-in link is on the way to <strong>{email}</strong>.
            </p>
            <p className="text-muted-foreground">
              The link is valid for 15 minutes. If you don't see it, check your
              spam folder.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setStep("verify")}
            >
              I have my token
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4 rounded-lg border bg-card p-6 shadow-sm"
            onSubmit={onVerify}
            noValidate
          >
            <div className="space-y-2">
              <label
                htmlFor="parent-email-verify"
                className="text-sm font-medium"
              >
                Parent / guardian email
              </label>
              <input
                id="parent-email-verify"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className={cn(
                  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                )}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="parent-token" className="text-sm font-medium">
                Token from the email
              </label>
              <input
                id="parent-token"
                type="text"
                required
                value={token}
                onChange={(e) => setToken(e.target.value.trim())}
                disabled={submitting}
                className={cn(
                  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm",
                )}
              />
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Verifying…" : "Sign in"}
            </Button>
            <button
              type="button"
              className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setStep("request")}
            >
              Request a new link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
