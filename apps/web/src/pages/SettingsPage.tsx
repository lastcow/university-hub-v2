// /app/settings — university, account, security/MFA, Mailgun status
// (UNI-15 + UNI-24).
//
// Account section is always shown to the signed-in user.
// University section is gated to super_admin / university_admin.
// Security section shows MFA enrollment state, recovery-code count, and
// (for non-mandatory roles) a disable button. The regenerate flow rotates
// recovery codes — old codes are immediately invalidated.
// Mailgun section displays per-var Configured / Missing configuration; the
// underlying API never returns secret values, so this page never has access
// to one and never echoes one.

import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Mail,
  Monitor,
  ShieldCheck,
  ShieldAlert,
  University,
  UserCircle,
  XCircle,
} from "lucide-react";

import type {
  MailgunStatusResponse,
  MailgunVarStatusEntry,
  MfaStatusResponse,
  SessionListItem,
  SessionListResponse,
  University as UniversityType,
} from "@university-hub/shared";

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
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import {
  disableMfa,
  getMfaStatus,
  regenerateRecoveryCodes,
} from "@/lib/mfa";
import {
  listMySessions,
  revokeAllOtherSessions,
  revokeMySession,
} from "@/lib/sessions";
import { getUniversity } from "@/lib/universities";
import {
  getMailgunStatus,
  updateAccountSettings,
  updateUniversitySettings,
} from "@/lib/settings";

type LoadStatus = "idle" | "loading" | "ok" | "error";

interface MailgunState {
  status: LoadStatus;
  data?: MailgunStatusResponse;
  error?: string;
}

interface UniState {
  status: LoadStatus;
  data?: UniversityType;
  error?: string;
}

const VAR_LABELS: Record<MailgunVarStatusEntry["key"], string> = {
  MAILGUN_API_KEY: "API key",
  MAILGUN_DOMAIN: "Sending domain",
  MAILGUN_FROM_EMAIL: "From email",
  MAILGUN_FROM_NAME: "From name",
  MAILGUN_REGION: "Region",
};

export function SettingsPage() {
  const { user, refresh } = useAuth();

  const canEditUniversity =
    user?.role === "super_admin" || user?.role === "university_admin";

  const [mailgun, setMailgun] = useState<MailgunState>({ status: "idle" });
  const [uni, setUni] = useState<UniState>({ status: "idle" });

  // -------------------------------------------------------------------------
  // Mailgun status
  // -------------------------------------------------------------------------
  useEffect(() => {
    const controller = new AbortController();
    setMailgun({ status: "loading" });
    getMailgunStatus(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setMailgun({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setMailgun({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load Mailgun status.",
        });
      });
    return () => controller.abort();
  }, []);

  // -------------------------------------------------------------------------
  // University (only when the user belongs to one)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!user?.university_id || !canEditUniversity) {
      setUni({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setUni({ status: "loading" });
    getUniversity(user.university_id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setUni({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setUni({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load university.",
        });
      });
    return () => controller.abort();
  }, [user?.university_id, canEditUniversity]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account, university details, and email delivery
          configuration.
        </p>
      </div>

      {canEditUniversity && user?.university_id ? (
        <UniversitySection
          state={uni}
          onSaved={(saved) => setUni({ status: "ok", data: saved })}
        />
      ) : null}

      <AccountSection
        currentName={user?.name ?? ""}
        onSaved={() => {
          void refresh();
        }}
      />

      <SecuritySection />

      <ActiveSessionsSection />

      <MailgunSection state={mailgun} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// University settings
// ---------------------------------------------------------------------------

function UniversitySection({
  state,
  onSaved,
}: {
  state: UniState;
  onSaved: (uni: UniversityType) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (state.status === "ok" && state.data) {
      setName(state.data.name);
      setSlug(state.data.slug ?? "");
    }
  }, [state.status, state.data]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const updated = await updateUniversitySettings({
        name,
        slug: slug.trim() || null,
      });
      toast({
        title: "University settings saved",
        description: `${updated.name} has been updated.`,
        variant: "success",
      });
      onSaved(updated);
    } catch (cause) {
      handleFormError(cause, setFormError, setFieldErrors);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <University className="h-5 w-5 text-muted-foreground" />
          <CardTitle>University</CardTitle>
        </div>
        <CardDescription>
          Visible to admins only. Saving writes a `settings.updated` audit row.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === "loading" || state.status === "idle" ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load university"
            description={state.error}
          />
        ) : !state.data ? (
          <p className="text-sm text-muted-foreground">
            You aren't associated with a university yet.
          </p>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-uni-name">Name</Label>
              <Input
                id="settings-uni-name"
                required
                value={name}
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
              <Label htmlFor="settings-uni-slug">Slug</Label>
              <Input
                id="settings-uni-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={submitting}
                placeholder="optional"
                aria-invalid={fieldErrors.slug ? "true" : "false"}
              />
              {fieldErrors.slug ? (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.slug}
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

            <div className="flex items-center justify-end gap-2">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------

function AccountSection({
  currentName,
  onSaved,
}: {
  currentName: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setName(currentName);
  }, [currentName]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});

    const wantsPasswordChange =
      currentPassword.length > 0 ||
      newPassword.length > 0 ||
      confirmPassword.length > 0;

    if (wantsPasswordChange) {
      if (!currentPassword) {
        setFieldErrors({ current_password: "Current password is required." });
        return;
      }
      if (newPassword.length < 8) {
        setFieldErrors({
          new_password: "New password must be at least 8 characters.",
        });
        return;
      }
      if (newPassword !== confirmPassword) {
        setFieldErrors({ confirm_password: "Passwords don't match." });
        return;
      }
    }

    const nameChanged = name !== currentName;
    if (!nameChanged && !wantsPasswordChange) {
      setFormError("Update at least one field to save.");
      return;
    }

    setSubmitting(true);
    try {
      await updateAccountSettings({
        ...(nameChanged ? { name } : {}),
        ...(wantsPasswordChange
          ? {
              current_password: currentPassword,
              new_password: newPassword,
            }
          : {}),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({
        title: "Account updated",
        description: wantsPasswordChange
          ? "Your password has been changed."
          : "Your profile has been saved.",
        variant: "success",
      });
      onSaved();
    } catch (cause) {
      if (
        cause instanceof ApiClientError &&
        cause.code === "wrong_current_password"
      ) {
        setFieldErrors({ current_password: cause.message });
      } else {
        handleFormError(cause, setFormError, setFieldErrors);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <UserCircle className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Account</CardTitle>
        </div>
        <CardDescription>
          Update your display name or change your password. Password changes
          require your current password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="settings-account-name">Name</Label>
            <Input
              id="settings-account-name"
              required
              value={name}
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

          <div className="rounded-md border border-border bg-muted/30 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <span>Change password</span>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="settings-current-password">
                  Current password
                </Label>
                <Input
                  id="settings-current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={fieldErrors.current_password ? "true" : "false"}
                />
                {fieldErrors.current_password ? (
                  <p className="text-xs font-medium text-destructive">
                    {fieldErrors.current_password}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-new-password">New password</Label>
                <Input
                  id="settings-new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={fieldErrors.new_password ? "true" : "false"}
                />
                {fieldErrors.new_password ? (
                  <p className="text-xs font-medium text-destructive">
                    {fieldErrors.new_password}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="settings-confirm-password">
                  Confirm new password
                </Label>
                <Input
                  id="settings-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={fieldErrors.confirm_password ? "true" : "false"}
                />
                {fieldErrors.confirm_password ? (
                  <p className="text-xs font-medium text-destructive">
                    {fieldErrors.confirm_password}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {formError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {formError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Security / MFA (UNI-24)
// ---------------------------------------------------------------------------

interface MfaState {
  status: LoadStatus;
  data?: MfaStatusResponse;
  error?: string;
}

function SecuritySection() {
  const [mfa, setMfa] = useState<MfaState>({ status: "idle" });
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const reload = () => {
    const controller = new AbortController();
    setMfa({ status: "loading" });
    getMfaStatus(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setMfa({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setMfa({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load MFA status.",
        });
      });
    return controller;
  };

  useEffect(() => {
    const controller = reload();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Security &amp; sessions</CardTitle>
        </div>
        <CardDescription>
          Two-factor authentication (TOTP) protects your account in addition
          to your password. Your session uses an HttpOnly cookie; sign out
          from the user menu to revoke it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {mfa.status === "loading" || mfa.status === "idle" ? (
          <Skeleton className="h-24 w-full" />
        ) : mfa.status === "error" ? (
          <ErrorState
            title="Couldn't load MFA status"
            description={mfa.error}
          />
        ) : mfa.data ? (
          <MfaStatusBlock
            data={mfa.data}
            onChanged={() => {
              setNewCodes(null);
              reload();
            }}
            onRegenerated={(codes) => {
              setNewCodes(codes);
              reload();
            }}
          />
        ) : null}

        {newCodes ? (
          <RecoveryCodesPanel codes={newCodes} onDismiss={() => setNewCodes(null)} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function MfaStatusBlock({
  data,
  onChanged,
  onRegenerated,
}: {
  data: MfaStatusResponse;
  onChanged: () => void;
  onRegenerated: (codes: string[]) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          {data.enrolled ? (
            <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600" />
          ) : (
            <ShieldAlert className="mt-0.5 h-5 w-5 text-amber-600" />
          )}
          <div className="space-y-1">
            <p className="font-medium">
              Two-factor authentication{" "}
              {data.enrolled ? (
                <span className="text-emerald-700">enabled</span>
              ) : data.required ? (
                <span className="text-amber-700">required at next sign-in</span>
              ) : (
                <span className="text-muted-foreground">not set up</span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {data.enrolled
                ? `${data.recovery_codes_remaining} recovery code${data.recovery_codes_remaining === 1 ? "" : "s"} remaining.`
                : data.required
                  ? "Your role requires MFA. You'll be guided through enrollment the next time you sign in."
                  : "Optional. Enroll on your next sign-in if you'd like the extra protection."}
            </p>
            {data.enabled_at ? (
              <p className="text-xs text-muted-foreground">
                Enabled {new Date(data.enabled_at).toLocaleDateString()}.
              </p>
            ) : null}
          </div>
        </div>
        {data.required ? <Badge variant="warning">Required</Badge> : null}
      </div>

      {data.enrolled ? (
        <MfaActions data={data} onChanged={onChanged} onRegenerated={onRegenerated} />
      ) : null}
    </div>
  );
}

function MfaActions({
  data,
  onChanged,
  onRegenerated,
}: {
  data: MfaStatusResponse;
  onChanged: () => void;
  onRegenerated: (codes: string[]) => void;
}) {
  const [mode, setMode] = useState<"idle" | "regenerate" | "disable">("idle");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setMode("idle");
    setPassword("");
    setError(null);
  };

  async function onConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "regenerate") {
        const res = await regenerateRecoveryCodes(password);
        toast({
          title: "Recovery codes rotated",
          description: "Old codes are no longer accepted.",
          variant: "success",
        });
        onRegenerated(res.recovery_codes);
      } else if (mode === "disable") {
        await disableMfa(password);
        toast({
          title: "MFA disabled",
          description:
            "Two-factor authentication has been turned off for your account.",
          variant: "success",
        });
        onChanged();
      }
      reset();
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        setError(cause.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "idle") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setMode("regenerate")}
        >
          Regenerate recovery codes
        </Button>
        {!data.required ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setMode("disable")}
          >
            Disable MFA
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form
      onSubmit={onConfirm}
      noValidate
      className="space-y-3 rounded-md border border-border p-4"
    >
      <p className="text-sm font-medium">
        {mode === "regenerate"
          ? "Confirm with your password to rotate recovery codes"
          : "Confirm with your password to disable MFA"}
      </p>
      <p className="text-xs text-muted-foreground">
        {mode === "regenerate"
          ? "Your existing recovery codes will stop working immediately."
          : "After disabling, only your password will be required to sign in."}
      </p>
      <div className="space-y-2">
        <Label htmlFor="mfa-confirm-password">Password</Label>
        <Input
          id="mfa-confirm-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={submitting}
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
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={submitting || !password}>
          {submitting
            ? "Working…"
            : mode === "regenerate"
              ? "Rotate recovery codes"
              : "Disable MFA"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={reset}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RecoveryCodesPanel({
  codes,
  onDismiss,
}: {
  codes: string[];
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="text-sm font-medium">
        New recovery codes — save these now
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        We will not show these codes again. Each one works exactly once.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1.5 font-mono text-xs">
        {codes.map((code) => (
          <li
            key={code}
            className="rounded bg-background px-2 py-1 text-center"
          >
            {code}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
          I've saved them
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active sessions (UNI-26)
// ---------------------------------------------------------------------------

interface SessionsState {
  status: LoadStatus;
  data?: SessionListResponse;
  error?: string;
}

function ActiveSessionsSection() {
  const [state, setState] = useState<SessionsState>({ status: "idle" });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  const reload = () => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, status: "loading" }));
    listMySessions(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load active sessions.",
        });
      });
    return controller;
  };

  useEffect(() => {
    const controller = reload();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRevoke(sessionId: string) {
    setBusyId(sessionId);
    try {
      await revokeMySession(sessionId);
      toast({
        title: "Session revoked",
        description: "That device will be signed out on its next request.",
        variant: "success",
      });
      reload();
    } catch (cause) {
      toast({
        title: "Could not revoke session",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function onSignOutAll() {
    setSigningOutAll(true);
    try {
      const res = await revokeAllOtherSessions();
      toast({
        title:
          res.revoked_count === 0
            ? "No other sessions to sign out"
            : `Signed out ${res.revoked_count} other session${res.revoked_count === 1 ? "" : "s"}`,
        description: "Your current device stays signed in.",
        variant: "success",
      });
      reload();
    } catch (cause) {
      toast({
        title: "Could not sign out other devices",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSigningOutAll(false);
    }
  }

  const sessions = state.data?.sessions ?? [];
  const hasOthers = sessions.some((s) => !s.is_current);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Active sessions</CardTitle>
        </div>
        <CardDescription>
          Devices currently signed in to your account. Sessions go idle after
          the configured timeout and re-authenticate after the absolute window.
          Revoke any session you don't recognize.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.status === "loading" || state.status === "idle" ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load sessions"
            description={state.error}
          />
        ) : (
          <>
            <ul className="divide-y divide-border rounded-md border border-border">
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  busy={busyId === session.id}
                  onRevoke={() => onRevoke(session.id)}
                />
              ))}
              {sessions.length === 0 ? (
                <li className="px-4 py-3 text-sm text-muted-foreground">
                  No active sessions.
                </li>
              ) : null}
            </ul>
            {state.data ? (
              <p className="text-xs text-muted-foreground">
                Idle timeout {formatDuration(state.data.idle_timeout_seconds)}.
                Absolute timeout{" "}
                {formatDuration(state.data.absolute_timeout_seconds)}.
              </p>
            ) : null}
            <div className="flex items-center justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={onSignOutAll}
                disabled={!hasOthers || signingOutAll}
                className="gap-2"
              >
                <LogOut className="h-4 w-4" />
                {signingOutAll ? "Signing out…" : "Sign out all other devices"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SessionRow({
  session,
  busy,
  onRevoke,
}: {
  session: SessionListItem;
  busy: boolean;
  onRevoke: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <Laptop className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <span className="truncate">
              {session.user_agent_excerpt ?? "Unknown device"}
            </span>
            {session.is_current ? (
              <Badge variant="success">This device</Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Started {new Date(session.started_at).toLocaleString()} · Last
            active {new Date(session.last_activity_at).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">
            IP {session.ip_excerpt ?? "—"}
          </p>
        </div>
      </div>
      {!session.is_current ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onRevoke}
          disabled={busy}
        >
          {busy ? "Revoking…" : "Revoke"}
        </Button>
      ) : null}
    </li>
  );
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0 && minutes === 0 && seconds === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0 && seconds === 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Mailgun status
// ---------------------------------------------------------------------------

function MailgunSection({ state }: { state: MailgunState }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Mailgun</CardTitle>
        </div>
        <CardDescription>
          Read-only status of the email delivery configuration. Secret values
          are never returned by the API — the worker reports only `Configured`
          or `Missing configuration` per variable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === "loading" || state.status === "idle" ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load Mailgun status"
            description={state.error}
          />
        ) : !state.data ? null : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">Overall:</span>
              {state.data.configured ? (
                <Badge variant="success">All required vars set</Badge>
              ) : (
                <Badge variant="warning">Missing configuration</Badge>
              )}
            </div>
            <ul className="divide-y divide-border rounded-md border border-border">
              {state.data.variables.map((entry) => (
                <li
                  key={entry.key}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex flex-col">
                    <span className="font-mono text-xs text-muted-foreground">
                      {entry.key}
                      {entry.optional ? " (optional)" : ""}
                    </span>
                    <span className="text-sm font-medium">
                      {VAR_LABELS[entry.key]}
                    </span>
                    {entry.key === "MAILGUN_REGION" && entry.value ? (
                      <span className="text-xs text-muted-foreground">
                        Value: {entry.value}
                      </span>
                    ) : null}
                  </div>
                  <StatusBadge status={entry.status} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: "Configured" | "Missing configuration" }) {
  if (status === "Configured") {
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Configured
      </Badge>
    );
  }
  return (
    <Badge variant="warning" className="gap-1">
      <XCircle className="h-3 w-3" />
      Missing configuration
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function handleFormError(
  cause: unknown,
  setFormError: (msg: string | null) => void,
  setFieldErrors: (errs: Record<string, string>) => void,
) {
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
    return;
  }
  setFormError("Something went wrong. Please try again.");
}
