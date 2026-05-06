// SignInPage — three states:
//
//   "credentials":  email + password form (the original UI).
//   "mfa-enroll":   first-time MFA enrollment (QR + secret + recovery codes
//                   + verify code). Shown when sign-in succeeded but the
//                   role requires MFA and `mfa_enrolled === false`.
//   "mfa-challenge": existing-enrollment challenge (TOTP / recovery code).
//
// Transitions are driven by /api/auth/sign-in's `SignInResponse` (UNI-24);
// when `status === "ok"` we go straight to `<Navigate />`. When MFA is
// required, the MFA challenge cookie is already set on the browser so the
// follow-up POSTs to /api/auth/mfa/* "just work".
//
// UNI-60: invitation acceptance also lands here. The accept endpoint sets
// the MFA challenge cookie on the response and `AcceptInvitationPage`
// navigates here with `state.mfaEnrollPending === true`; we render the
// `mfa-enroll` step directly so the user does not have to type their
// password a second time.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { KeyRound, ShieldCheck } from "lucide-react";

import type { MfaEnrollResponse } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { ApiClientError, setStoredSessionToken } from "@/lib/api";
import { defaultDashboardForRole } from "@/lib/default-dashboard";
import {
  startMfaEnrollment,
  submitMfaChallenge,
  verifyMfaEnrollment,
} from "@/lib/mfa";
import { getOnboardingLmsStep } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

/**
 * Location state recognized by `SignInPage`. All fields are optional;
 * the page degrades gracefully when nothing is passed.
 *
 * - `from`: where to send the user after a successful sign-in. Set by
 *   `ProtectedRoute` when bouncing an unauthenticated visitor away from
 *   a deep link.
 * - `mfaEnrollPending` (UNI-60): set by `AcceptInvitationPage` after a
 *   successful invitation accept. Tells `SignInPage` to skip the
 *   credentials prompt and render `MfaEnrollStep` directly.
 * - `trustedDeviceEligible` (UNI-60): forwarded from the accept
 *   response so the post-enrollment surface stays consistent with the
 *   regular sign-in flow.
 * - `invitedEmail` (UNI-60): the address the invitation was sent to.
 *   Surfaced as a small reassurance line above the QR code so the user
 *   knows which account they are enrolling.
 * - `mfaChallengeToken` (UNI-68): pending-MFA challenge token threaded
 *   from the invitation-accept response. Echoed back on
 *   `/api/auth/mfa/{enroll,verify-enroll}` via the
 *   `X-Mfa-Challenge-Token` header so the flow works in browsers that
 *   block the cross-site cookie on the Pages → Worker hop.
 */
export interface SignInLocationState {
  from?: string;
  mfaEnrollPending?: boolean;
  trustedDeviceEligible?: boolean;
  invitedEmail?: string;
  mfaChallengeToken?: string;
}

type Step = "credentials" | "mfa-enroll" | "mfa-challenge";

export function SignInPage() {
  const { status, user, signIn, setSessionUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state as SignInLocationState | null) ?? null;

  const [step, setStep] = useState<Step>(() =>
    locationState?.mfaEnrollPending ? "mfa-enroll" : "credentials",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Surfaced from the sign-in response. UNI-47 (university_admin) and
  // UNI-49 (every non-super_admin role) both drive the checkbox via this
  // flag; super_admin is always-MFA and always false. UNI-60 also seeds
  // it from the invitation-accept response when the user lands here via
  // the invitation flow.
  const [trustedDeviceEligible, setTrustedDeviceEligible] = useState(
    locationState?.trustedDeviceEligible ?? false,
  );
  // UNI-68: pending-MFA challenge token. Captured from the sign-in
  // response (`mfa_required` branch) or threaded in via location state
  // from the invitation-accept flow. Passed back as the
  // `X-Mfa-Challenge-Token` header on every /api/auth/mfa/* call so the
  // verify step works without depending on a cross-site cookie that the
  // browser may have dropped.
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(
    locationState?.mfaChallengeToken ?? null,
  );

  const fromState = locationState?.from;
  const fallback = user ? defaultDashboardForRole(user.role) : "/app/dashboard";
  const redirectTo =
    fromState && fromState.startsWith("/app/") ? fromState : fallback;

  if (status === "authenticated") {
    return <Navigate to={redirectTo} replace />;
  }

  // After every successful auth (credentials-only path, MFA enroll
  // verify, MFA challenge verify) we ask the worker whether the user
  // is owed a one-time post-MFA onboarding step (UNI-57). The endpoint
  // evaluates the four gates server-side; a `true` response routes the
  // user to /app/onboarding/lms, a `false` (or any error) lets the
  // existing role-default dashboard redirect run. We honor an explicit
  // `from` location only when it isn't itself the onboarding page —
  // a deep-link to /app/onboarding/lms is fine, but a re-entry through
  // `from` shouldn't suppress a freshly-eligible step on first sign-in.
  const goAfterSignIn = async (role: string) => {
    const fallbackTarget =
      fromState && fromState.startsWith("/app/")
        ? fromState
        : defaultDashboardForRole(
            role as Parameters<typeof defaultDashboardForRole>[0],
          );
    try {
      const onboarding = await getOnboardingLmsStep();
      if (onboarding.show) {
        navigate("/app/onboarding/lms", { replace: true });
        return;
      }
    } catch {
      // Fail open: any error here just falls through to the dashboard.
      // The integrations page is always reachable from the side nav.
    }
    navigate(fallbackTarget, { replace: true });
  };

  async function onCredentialsSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const next = await signIn({ email, password });
      if (next.status === "ok") {
        await goAfterSignIn(next.user.role);
        return;
      }
      // MFA gate: server returned the pending-MFA challenge token (UNI-68)
      // and ALSO set an HttpOnly cookie. We always use the token via
      // `X-Mfa-Challenge-Token` — the cookie is defense in depth for
      // browsers that allow cross-site cookies on the Pages → Worker hop.
      // The user object is not in `next` until MFA is verified — we
      // don't know their role yet, but goAfterSignIn will be called from
      // the MFA step using the SessionUser returned there.
      setTrustedDeviceEligible(next.trusted_device_eligible);
      setMfaChallengeToken(next.mfa_challenge_token);
      setStep(next.mfa_enrolled ? "mfa-challenge" : "mfa-enroll");
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setError(cause.message);
      } else {
        setError("Could not sign in. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const arrivedFromInvitation =
    locationState?.mfaEnrollPending === true && step === "mfa-enroll";

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">University Hub</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {step === "credentials"
              ? "Sign in to your account"
              : step === "mfa-enroll"
                ? arrivedFromInvitation
                  ? "Welcome — let's finish setting up your account"
                  : "Set up two-factor authentication"
                : "Enter your verification code"}
          </p>
          {arrivedFromInvitation && locationState?.invitedEmail ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Enrolling{" "}
              <span className="font-medium text-foreground">
                {locationState.invitedEmail}
              </span>
            </p>
          ) : null}
        </div>

        {step === "credentials" ? (
          <CredentialsForm
            email={email}
            password={password}
            error={error}
            submitting={submitting}
            onChangeEmail={setEmail}
            onChangePassword={setPassword}
            onSubmit={onCredentialsSubmit}
          />
        ) : step === "mfa-enroll" ? (
          <MfaEnrollStep
            challengeToken={mfaChallengeToken}
            onVerified={(role) => {
              void goAfterSignIn(role);
            }}
            onBack={() => {
              setStep("credentials");
              setError(null);
            }}
            setSessionUser={setSessionUser}
          />
        ) : (
          <MfaChallengeStep
            challengeToken={mfaChallengeToken}
            onVerified={(role) => {
              void goAfterSignIn(role);
            }}
            onBack={() => {
              setStep("credentials");
              setError(null);
            }}
            setSessionUser={setSessionUser}
            trustedDeviceEligible={trustedDeviceEligible}
          />
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Access is invitation-only. Contact your administrator if you need an
          account.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — credentials
// ---------------------------------------------------------------------------

function CredentialsForm({
  email,
  password,
  error,
  submitting,
  onChangeEmail,
  onChangePassword,
  onSubmit,
}: {
  email: string;
  password: string;
  error: string | null;
  submitting: boolean;
  onChangeEmail: (v: string) => void;
  onChangePassword: (v: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      className="space-y-4 rounded-lg border bg-card p-6 shadow-sm"
      onSubmit={onSubmit}
      noValidate
    >
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => onChangeEmail(e.target.value)}
          disabled={submitting}
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
            "placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => onChangePassword(e.target.value)}
          disabled={submitting}
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
            "placeholder:text-muted-foreground",
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
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2a — first-time MFA enrollment
// ---------------------------------------------------------------------------

function MfaEnrollStep({
  challengeToken,
  onVerified,
  onBack,
  setSessionUser,
}: {
  challengeToken: string | null;
  onVerified: (role: string) => void;
  onBack: () => void;
  setSessionUser: ReturnType<typeof useAuth>["setSessionUser"];
}) {
  const [enrollment, setEnrollment] = useState<MfaEnrollResponse | null>(null);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [acknowledgedCodes, setAcknowledgedCodes] = useState(false);

  // Kick off the secret/recovery-code generation as soon as we land here.
  useEffect(() => {
    let cancelled = false;
    startMfaEnrollment(challengeToken)
      .then((res) => {
        if (!cancelled) setEnrollment(res);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiClientError) {
          setEnrollError(cause.message);
        } else {
          setEnrollError("Could not start MFA enrollment. Please try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [challengeToken]);

  const qrUrl = useMemo(() => {
    if (!enrollment?.otpauth_url) return null;
    // Free, no-tracking QR proxy. The otpauth URL is a low-sensitivity
    // string already shown to the user; it's fine for a short lifetime
    // alongside a copyable plaintext fallback.
    const encoded = encodeURIComponent(enrollment.otpauth_url);
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encoded}`;
  }, [enrollment?.otpauth_url]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerifyError(null);
    setSubmitting(true);
    try {
      const verified = await verifyMfaEnrollment(code, challengeToken);
      // UNI-70: persist the bearer token before flipping auth state so
      // the immediate post-MFA fetches (`/api/auth/me`, dashboard
      // summary, onboarding step) carry it. Browsers that block the
      // cross-site session cookie would otherwise land the user on the
      // dashboard and 401 every protected request.
      setStoredSessionToken(verified.session_token);
      setSessionUser(verified.user);
      onVerified(verified.user.role);
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setVerifyError(cause.message);
      } else {
        setVerifyError("Could not verify the code. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (enrollError) {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Couldn't start enrollment</p>
            <p className="mt-1 text-sm text-muted-foreground">{enrollError}</p>
          </div>
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    );
  }

  if (!enrollment) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground shadow-sm">
        Generating your authenticator secret…
      </div>
    );
  }

  return (
    <form
      className="space-y-5 rounded-lg border bg-card p-6 shadow-sm"
      onSubmit={onSubmit}
      noValidate
    >
      <div className="rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">1. Scan the QR code</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Use Google Authenticator, 1Password, Authy, or any TOTP-compatible
          app.
        </p>
        <div className="mt-3 flex justify-center">
          {qrUrl ? (
            <img
              src={qrUrl}
              alt="QR code for your TOTP secret"
              width={180}
              height={180}
              className="rounded-md border border-border bg-white p-2"
            />
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Can't scan? Enter this secret manually:
        </p>
        <code
          className="mt-1 block break-all rounded bg-background px-2 py-1 font-mono text-xs"
          aria-label="TOTP secret"
        >
          {enrollment.secret}
        </code>
      </div>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
        <p className="text-sm font-medium">
          2. Save your recovery codes
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Each code works once if you lose access to your authenticator. We
          will not show them again — store them somewhere safe before
          continuing.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-xs">
          {enrollment.recovery_codes.map((code) => (
            <li
              key={code}
              className="rounded bg-background px-2 py-1 text-center"
            >
              {code}
            </li>
          ))}
        </ul>
        <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={acknowledgedCodes}
            onChange={(e) => setAcknowledgedCodes(e.target.checked)}
            className="mt-0.5"
          />
          <span>I have saved my recovery codes somewhere safe.</span>
        </label>
      </div>

      <div className="space-y-2">
        <label htmlFor="mfa-enroll-code" className="text-sm font-medium">
          3. Enter the 6-digit code from your authenticator
        </label>
        <input
          id="mfa-enroll-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D+/g, ""))}
          disabled={submitting}
          className={cn(
            "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-center font-mono text-base tracking-[0.4em]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      {verifyError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {verifyError}
        </div>
      ) : null}

      <Button
        type="submit"
        className="w-full"
        disabled={submitting || code.length !== 6 || !acknowledgedCodes}
      >
        {submitting ? "Verifying…" : "Verify and sign in"}
      </Button>
      <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
        Back to sign in
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2b — challenge for an already-enrolled user
// ---------------------------------------------------------------------------

function MfaChallengeStep({
  challengeToken,
  onVerified,
  onBack,
  setSessionUser,
  trustedDeviceEligible,
}: {
  challengeToken: string | null;
  onVerified: (role: string) => void;
  onBack: () => void;
  setSessionUser: ReturnType<typeof useAuth>["setSessionUser"];
  trustedDeviceEligible: boolean;
}) {
  const [code, setCode] = useState("");
  const [usingRecovery, setUsingRecovery] = useState(false);
  // "Trust this device" checkbox. UNI-47 mints a signed cookie for
  // university_admin; UNI-49 records a server-side fingerprint for every
  // non-admin role. Default unchecked per the issue — the user has to
  // opt in. Hidden for super_admin (always-MFA).
  const [rememberDevice, setRememberDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Recovery codes are intentionally NOT eligible to grant trust on
      // the backend — they are an account-recovery surface, not a
      // "this device is mine" assertion. The checkbox is also hidden
      // when the user toggles to recovery mode, but we belt-and-
      // suspenders the `remember_device` flag here too.
      const verified = await submitMfaChallenge(code, {
        rememberDevice:
          trustedDeviceEligible && !usingRecovery && rememberDevice,
        challengeToken,
      });
      // UNI-70: persist the bearer token before flipping auth state.
      // Same reasoning as the verify-enroll path — cross-site browsers
      // drop the session cookie, so without the bearer the user lands
      // on the dashboard and every protected fetch 401s.
      setStoredSessionToken(verified.session_token);
      setSessionUser(verified.user);
      onVerified(verified.user.role);
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setError(cause.message);
      } else {
        setError("Could not verify the code. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="space-y-5 rounded-lg border bg-card p-6 shadow-sm"
      onSubmit={onSubmit}
      noValidate
    >
      <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
        <KeyRound className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">
          {usingRecovery
            ? "Enter one of your saved recovery codes (XXXXX-XXXXX). Each code works once."
            : "Enter the 6-digit code from your authenticator app."}
        </span>
      </div>

      <div className="space-y-2">
        <label htmlFor="mfa-challenge-code" className="text-sm font-medium">
          {usingRecovery ? "Recovery code" : "Verification code"}
        </label>
        <input
          id="mfa-challenge-code"
          inputMode={usingRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) =>
            setCode(usingRecovery ? e.target.value : e.target.value.replace(/\D+/g, ""))
          }
          disabled={submitting}
          maxLength={usingRecovery ? 32 : 6}
          className={cn(
            "flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-center font-mono text-base",
            usingRecovery ? "tracking-[0.15em]" : "tracking-[0.4em]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      {trustedDeviceEligible && !usingRecovery ? (
        <label
          className="flex items-start gap-2 text-xs text-muted-foreground"
          htmlFor="mfa-remember-device"
        >
          <input
            id="mfa-remember-device"
            type="checkbox"
            checked={rememberDevice}
            onChange={(e) => setRememberDevice(e.target.checked)}
            disabled={submitting}
            className="mt-0.5 h-4 w-4 rounded border border-input"
          />
          <span>
            Trust this device. Skip the verification code on future
            sign-ins from this browser and network. Use only on devices
            you control.
          </span>
        </label>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <Button
        type="submit"
        className="w-full"
        disabled={submitting || (usingRecovery ? code.length < 6 : code.length !== 6)}
      >
        {submitting ? "Verifying…" : "Verify and sign in"}
      </Button>

      <button
        type="button"
        className="w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => {
          setUsingRecovery((v) => !v);
          setCode("");
          setError(null);
        }}
      >
        {usingRecovery
          ? "Use my authenticator app instead"
          : "Use a recovery code instead"}
      </button>

      <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
        Back to sign in
      </Button>
    </form>
  );
}
