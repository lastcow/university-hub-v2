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
  ExternalLink,
  FileText,
  KeyRound,
  Laptop,
  Lock,
  LogOut,
  Mail,
  Monitor,
  PhoneCall,
  Scale,
  ShieldCheck,
  ShieldAlert,
  University,
  UserCircle,
  XCircle,
} from "lucide-react";
import { Link } from "react-router-dom";

import type {
  EscalationContact,
  EscalationContactsResponse,
  LegalAdminDocument,
  LegalAdminResponse,
  LegalDocumentKind,
  MailgunStatusResponse,
  MailgunVarStatusEntry,
  MfaStatusResponse,
  Role,
  SessionListItem,
  SessionListResponse,
  SystemSettingsResponse,
  TrustedDeviceListItem,
  TrustedDeviceListResponse,
  University as UniversityType,
} from "@university-hub/shared";
import { LEGAL_DOCUMENT_KIND_LABELS } from "@university-hub/shared";

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
  listEscalationContacts,
  updateEscalationContact,
} from "@/lib/escalation-contacts";
import { getLegalAdmin, updateLegalDocument } from "@/lib/legal";
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
import {
  getSystemSettings,
  listMyTrustedDevices,
  revokeAllMyTrustedDevices,
  revokeMyTrustedDevice,
  updateSystemSettings,
} from "@/lib/trusted-devices";
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
  const canSeeMailgun = user?.role === "super_admin";

  const [mailgun, setMailgun] = useState<MailgunState>({ status: "idle" });
  const [uni, setUni] = useState<UniState>({ status: "idle" });

  // -------------------------------------------------------------------------
  // Mailgun status — super_admin only. The endpoint returns 403 for everyone
  // else; mirroring that gate on the client keeps the section out of the UI
  // entirely instead of flashing a permission error toast.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!canSeeMailgun) {
      setMailgun({ status: "idle" });
      return;
    }
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
  }, [canSeeMailgun]);

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
        userRole={user?.role ?? null}
      />

      <SecuritySection />

      <ActiveSessionsSection />

      <TrustedDevicesSection userRole={user?.role ?? null} />

      {user?.role === "super_admin" ? <SystemSettingsSection /> : null}

      {canEditUniversity ? <LegalSection /> : null}

      {user?.role === "super_admin" ? <EscalationContactsSection /> : null}

      {canSeeMailgun ? <MailgunSection state={mailgun} /> : null}
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
  userRole,
}: {
  currentName: string;
  onSaved: () => void;
  userRole: string | null;
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

        <div className="mt-6 border-t pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Legal &amp; FERPA
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
              <Link
                to="/privacy"
                className="inline-flex items-center gap-1.5 text-foreground hover:text-primary"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link
                to="/terms"
                className="inline-flex items-center gap-1.5 text-foreground hover:text-primary"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Terms of Service
              </Link>
            </li>
            {userRole ? (
              <li>
                <Link
                  to={ferpaDisclosuresHrefForRole(userRole)}
                  className="inline-flex items-center gap-1.5 text-foreground hover:text-primary"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View FERPA-related disclosures about me
                </Link>
              </li>
            ) : null}
          </ul>
        </div>
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
// Legal admin (UNI-34) — Privacy Policy + ToS overrides per customer
// ---------------------------------------------------------------------------

interface LegalState {
  status: LoadStatus;
  data?: LegalAdminResponse;
  error?: string;
}

const LEGAL_KINDS: LegalDocumentKind[] = ["terms", "privacy"];

function LegalSection() {
  const [state, setState] = useState<LegalState>({ status: "idle" });

  const load = () => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, status: "loading" }));
    getLegalAdmin(controller.signal)
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
              : "Could not load legal documents.",
        });
      });
    return controller;
  };

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyUpdate(kind: LegalDocumentKind, updated: LegalAdminDocument) {
    setState((prev) => {
      if (prev.status !== "ok" || !prev.data) return prev;
      return {
        ...prev,
        data: {
          ...prev.data,
          documents: { ...prev.data.documents, [kind]: updated },
        },
      };
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Scale className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Legal</CardTitle>
        </div>
        <CardDescription>
          Override the default Terms of Service and Privacy Policy for your
          university. Changes are audit-logged. Bumping the version forces a
          re-acceptance prompt on every user's next sign-in. Customers must
          have their own counsel review before going live.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {state.status === "loading" || state.status === "idle" ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load legal documents"
            description={state.error}
          />
        ) : state.data ? (
          <>
            {state.data.contact_email ? (
              <p className="text-xs text-muted-foreground">
                Contact-email placeholder ({"{{contact_email}}"}) renders as{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                  {state.data.contact_email}
                </code>
                . University placeholder ({"{{university_name}}"}) renders as{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                  {state.data.university_name ?? "your university"}
                </code>
                .
              </p>
            ) : (
              <p className="text-xs text-amber-700">
                <strong>Heads up:</strong> the <code>SUPPORT_EMAIL</code>{" "}
                environment variable is not set, so the {"{{contact_email}}"}{" "}
                placeholder will render as a generic phrase. Configure it via
                <code className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
                  wrangler secret put SUPPORT_EMAIL
                </code>
                .
              </p>
            )}
            {LEGAL_KINDS.map((kind) => (
              <LegalDocumentEditor
                key={kind}
                kind={kind}
                document={state.data!.documents[kind]}
                onUpdate={(updated) => applyUpdate(kind, updated)}
              />
            ))}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function LegalDocumentEditor({
  kind,
  document: doc,
  onUpdate,
}: {
  kind: LegalDocumentKind;
  document: LegalAdminDocument;
  onUpdate: (updated: LegalAdminDocument) => void;
}) {
  const [body, setBody] = useState(doc.body_md);
  const [versionBump, setVersionBump] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBody(doc.body_md);
  }, [doc.body_md]);

  const dirty = body !== doc.body_md;

  async function onSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateLegalDocument(kind, {
        body_md: body,
        version_bump: versionBump,
      });
      toast({
        title: `${LEGAL_DOCUMENT_KIND_LABELS[kind]} saved`,
        description: versionBump
          ? `Bumped to v${updated.version} — users will be asked to re-accept.`
          : `Saved as v${updated.version} (silent edit, no re-acceptance).`,
        variant: "success",
      });
      setVersionBump(false);
      onUpdate(updated);
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : "Couldn't save changes. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium">
            {LEGAL_DOCUMENT_KIND_LABELS[kind]}
          </p>
          <Badge variant={doc.is_overridden ? "default" : "outline"}>
            {doc.is_overridden ? `Custom · v${doc.version}` : `Default · v${doc.version}`}
          </Badge>
        </div>
        <Link
          to={`/${kind}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
        >
          <ExternalLink className="h-3 w-3" /> Preview
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Last updated{" "}
        {new Date(doc.updated_at).toLocaleString()}
        {doc.updated_by_name ? ` by ${doc.updated_by_name}` : ""}.
      </p>

      <div className="mt-3 space-y-2">
        <Label htmlFor={`legal-${kind}-body`}>Markdown body</Label>
        <textarea
          id={`legal-${kind}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={saving}
          rows={14}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-6 shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          spellCheck="false"
        />
        <p className="text-xs text-muted-foreground">
          Supports headings, paragraphs, bullet lists, links, and emphasis.
          Placeholders {"{{university_name}}"} and {"{{contact_email}}"} are
          rendered at display time.
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label
          htmlFor={`legal-${kind}-bump`}
          className="flex items-start gap-2 text-xs text-foreground"
        >
          <input
            id={`legal-${kind}-bump`}
            type="checkbox"
            checked={versionBump}
            onChange={(e) => setVersionBump(e.target.checked)}
            disabled={saving}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-input text-primary focus:ring-2 focus:ring-ring focus:ring-offset-0"
          />
          <span className="leading-snug">
            Bump version (forces all users to re-accept on next sign-in)
          </span>
        </label>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || !dirty}
            size="sm"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Escalation contacts (UNI-40) — runtime-configurable owners + escalation
// table for the breach-response runbook (`docs/incident-response.md`).
// Super_admin only — the SaaS operator's on-call entry shouldn't be silently
// rewriteable by a customer's university_admin.
// ---------------------------------------------------------------------------

interface EscalationContactsState {
  status: LoadStatus;
  data?: EscalationContactsResponse;
  error?: string;
}

function EscalationContactsSection() {
  const [state, setState] = useState<EscalationContactsState>({
    status: "idle",
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    listEscalationContacts(controller.signal)
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
              : "Could not load escalation contacts.",
        });
      });
    return () => controller.abort();
  }, []);

  function applyUpdated(updated: EscalationContact) {
    setState((prev) => {
      if (prev.status !== "ok" || !prev.data) return prev;
      const next = prev.data.contacts.map((c) =>
        c.role_key === updated.role_key ? updated : c,
      );
      return {
        ...prev,
        data: {
          contacts: next,
          any_mockup: next.some((c) => c.is_mockup),
        },
      };
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <PhoneCall className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Owners &amp; escalation contacts</CardTitle>
        </div>
        <CardDescription>
          Source of truth for the breach-response runbook (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">
            docs/incident-response.md
          </code>
          ). Replace every mockup row with real names, working emails, and
          after-hours phone numbers before opening to real students. Edits are
          audit-logged. Super-admin only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.status === "loading" || state.status === "idle" ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load escalation contacts"
            description={state.error}
          />
        ) : state.data ? (
          <>
            {state.data.any_mockup ? (
              <div
                role="alert"
                className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-100"
              >
                <strong>Launch blocker.</strong> One or more rows still carry
                seeded mockup contents (RFC 2606 <code>*@example.*</code>{" "}
                emails or the +1-555-01xx fictional phone range). Replace
                every mockup row with real, callable contacts before opening
                to real students. Per the runbook, finding mockup rows during
                a real incident is itself an S2 finding.
              </div>
            ) : (
              <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-900/30 dark:text-emerald-100">
                <strong>All rows populated with real contacts.</strong> Re-run
                a tabletop drill (5 minutes — &ldquo;can I reach the FERPA
                officer&rdquo;) when the lineup changes.
              </div>
            )}

            <div className="space-y-3">
              {state.data.contacts.map((contact) => (
                <EscalationContactEditor
                  key={contact.role_key}
                  contact={contact}
                  onUpdate={applyUpdated}
                />
              ))}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function EscalationContactEditor({
  contact,
  onUpdate,
}: {
  contact: EscalationContact;
  onUpdate: (updated: EscalationContact) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [roleLabel, setRoleLabel] = useState(contact.role_label);
  const [personName, setPersonName] = useState(contact.person_name);
  const [email, setEmail] = useState(contact.email);
  const [phone, setPhone] = useState(contact.phone);
  const [notes, setNotes] = useState(contact.notes);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!editing) {
      setRoleLabel(contact.role_label);
      setPersonName(contact.person_name);
      setEmail(contact.email);
      setPhone(contact.phone);
      setNotes(contact.notes);
      setFormError(null);
      setFieldErrors({});
    }
  }, [contact, editing]);

  async function onSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const updated = await updateEscalationContact(contact.role_key, {
        role_label: roleLabel,
        person_name: personName,
        email,
        phone,
        notes,
      });
      toast({
        title: "Contact updated",
        description: updated.is_mockup
          ? `${updated.role_label} saved — still flagged as mockup. Replace example.* email or +1-555-01xx phone before launch.`
          : `${updated.role_label} saved.`,
        variant: updated.is_mockup ? "warning" : "success",
      });
      onUpdate(updated);
      setEditing(false);
    } catch (cause) {
      handleFormError(cause, setFormError, setFieldErrors);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={
        "rounded-md border p-4 " +
        (contact.is_mockup
          ? "border-amber-300/80 bg-amber-50/40 dark:border-amber-800/60 dark:bg-amber-950/20"
          : "border-border")
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="text-sm font-medium">{contact.role_label}</p>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            {contact.role_key}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {contact.is_mockup ? (
            <Badge variant="warning">Mockup — replace before launch</Badge>
          ) : (
            <Badge variant="success">Real contact</Badge>
          )}
          {!editing ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          ) : null}
        </div>
      </div>

      {!editing ? (
        <div className="mt-3 grid gap-1 text-sm sm:grid-cols-3">
          <div className="sm:col-span-1">
            <p className="text-xs text-muted-foreground">Name</p>
            <p>{contact.person_name}</p>
          </div>
          <div className="sm:col-span-1">
            <p className="text-xs text-muted-foreground">Email</p>
            <p className="break-all">{contact.email}</p>
          </div>
          <div className="sm:col-span-1">
            <p className="text-xs text-muted-foreground">After-hours phone</p>
            <p>{contact.phone}</p>
          </div>
          {contact.notes ? (
            <div className="sm:col-span-3">
              <p className="text-xs text-muted-foreground">Notes</p>
              <p className="text-sm text-foreground/90">{contact.notes}</p>
            </div>
          ) : null}
          <div className="sm:col-span-3 text-xs text-muted-foreground">
            Last updated {new Date(contact.updated_at).toLocaleString()}
            {contact.updated_by_name ? ` by ${contact.updated_by_name}` : ""}.
          </div>
        </div>
      ) : (
        <form onSubmit={onSave} className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`ec-${contact.role_key}-label`}>
                Role label
              </Label>
              <Input
                id={`ec-${contact.role_key}-label`}
                value={roleLabel}
                onChange={(e) => setRoleLabel(e.target.value)}
                disabled={saving}
              />
              {fieldErrors.role_label ? (
                <p className="text-xs text-destructive">
                  {fieldErrors.role_label}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`ec-${contact.role_key}-name`}>Name</Label>
              <Input
                id={`ec-${contact.role_key}-name`}
                value={personName}
                onChange={(e) => setPersonName(e.target.value)}
                disabled={saving}
              />
              {fieldErrors.person_name ? (
                <p className="text-xs text-destructive">
                  {fieldErrors.person_name}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`ec-${contact.role_key}-email`}>Email</Label>
              <Input
                id={`ec-${contact.role_key}-email`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={saving}
              />
              {fieldErrors.email ? (
                <p className="text-xs text-destructive">{fieldErrors.email}</p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`ec-${contact.role_key}-phone`}>
                After-hours phone
              </Label>
              <Input
                id={`ec-${contact.role_key}-phone`}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={saving}
                placeholder="+1-555-0142"
              />
              {fieldErrors.phone ? (
                <p className="text-xs text-destructive">{fieldErrors.phone}</p>
              ) : null}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`ec-${contact.role_key}-notes`}>
              Notes (optional)
            </Label>
            <textarea
              id={`ec-${contact.role_key}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={saving}
              rows={2}
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {fieldErrors.notes ? (
              <p className="text-xs text-destructive">{fieldErrors.notes}</p>
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
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
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

function ferpaDisclosuresHrefForRole(role: string): string {
  if (role === "student") return "/app/student/my-profile";
  if (role === "super_admin" || role === "university_admin") {
    return "/app/disclosures";
  }
  return "/app/disclosures";
}

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

// ---------------------------------------------------------------------------
// Trusted devices (UNI-47)
// ---------------------------------------------------------------------------

type TrustedDevicesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: TrustedDeviceListResponse }
  | { status: "error"; error: string };

function TrustedDevicesSection({ userRole }: { userRole: Role | null }) {
  const [state, setState] = useState<TrustedDevicesState>({ status: "idle" });
  const [revoking, setRevoking] = useState(false);

  const reload = () => {
    const controller = new AbortController();
    setState({ status: "loading" });
    listMyTrustedDevices(controller.signal)
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
              : "Could not load trusted devices.",
        });
      });
    return controller;
  };

  useEffect(() => {
    const controller = reload();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only `university_admin` can ever earn a trusted-device row today, so
  // showing this section to other roles would just dangle an empty list
  // forever. Render nothing for ineligible roles to keep the page tidy.
  if (userRole !== "university_admin" && userRole !== "super_admin") {
    return null;
  }

  const items =
    state.status === "ok" ? state.data.trusted_devices : ([] as TrustedDeviceListItem[]);
  const trustWindow = state.status === "ok" ? state.data.trust_window_days : null;

  const handleRevoke = async (id: string) => {
    setRevoking(true);
    try {
      await revokeMyTrustedDevice(id);
      toast({ title: "Trusted device revoked" });
      reload();
    } catch (cause) {
      toast({
        title: "Could not revoke trusted device",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setRevoking(false);
    }
  };

  const handleRevokeAll = async () => {
    if (!confirm("Revoke trust on every remembered device?")) return;
    setRevoking(true);
    try {
      const result = await revokeAllMyTrustedDevices();
      toast({
        title: "Trusted devices cleared",
        description: `${result.revoked_count} device(s) will re-prompt for MFA on next sign-in.`,
      });
      reload();
    } catch (cause) {
      toast({
        title: "Could not revoke trusted devices",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Laptop className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Trusted devices</CardTitle>
        </div>
        <CardDescription>
          Devices you've asked the system to remember after signing in. The
          MFA challenge is skipped on these devices when the cookie is
          intact and the request comes from the same IP.
          {trustWindow != null
            ? ` New trusts last for ${trustWindow} day${trustWindow === 1 ? "" : "s"}.`
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "loading" || state.status === "idle" ? (
          <Skeleton className="h-16 w-full" />
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load trusted devices"
            description={state.error}
          />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trusted devices on file. The MFA challenge will run on every
            sign-in.
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <p className="font-mono text-xs text-muted-foreground">
                      {item.user_agent_excerpt ?? "Unknown device"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      IP {item.ip_excerpt ?? "unknown"} · trusted{" "}
                      {new Date(item.created_at).toLocaleDateString()} · expires{" "}
                      {new Date(item.expires_at).toLocaleDateString()}
                      {item.last_used_at
                        ? ` · last used ${new Date(item.last_used_at).toLocaleDateString()}`
                        : " · never used"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={revoking}
                    onClick={() => void handleRevoke(item.id)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revoking}
                onClick={() => void handleRevokeAll()}
              >
                Revoke all
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// System settings (super_admin only)
// ---------------------------------------------------------------------------

type SystemSettingsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; data: SystemSettingsResponse }
  | { status: "error"; error: string };

function SystemSettingsSection() {
  const [state, setState] = useState<SystemSettingsState>({ status: "idle" });
  const [days, setDays] = useState<string>("30");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    getSystemSettings(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        setDays(String(data.mfa_trusted_device_days));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load system settings.",
        });
      });
    return () => controller.abort();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const value = Number.parseInt(days, 10);
    if (!Number.isFinite(value) || value < 1 || value > 90) {
      setError("Trust window must be between 1 and 90 days.");
      return;
    }
    setSaving(true);
    try {
      const updated = await updateSystemSettings({
        mfa_trusted_device_days: value,
      });
      setState({ status: "ok", data: updated });
      setDays(String(updated.mfa_trusted_device_days));
      toast({ title: "System settings saved" });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError
          ? cause.message
          : "Could not update system settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <CardTitle>System security</CardTitle>
        </div>
        <CardDescription>
          Single-tenant system settings. Reducing the trust window does not
          retroactively shrink existing trusted-device rows — only newly-
          granted ones use the new value. To force everyone to re-MFA, use
          the per-user "Revoke all" action above or rotate{" "}
          <code className="font-mono text-xs">SESSION_SECRET</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "loading" || state.status === "idle" ? (
          <Skeleton className="h-16 w-full" />
        ) : state.status === "error" ? (
          <ErrorState
            title="Couldn't load system settings"
            description={state.error}
          />
        ) : (
          <form className="space-y-3" onSubmit={onSubmit}>
            <div className="space-y-1">
              <Label htmlFor="mfa-trusted-device-days">
                Trusted-device window (days)
              </Label>
              <Input
                id="mfa-trusted-device-days"
                type="number"
                min={1}
                max={90}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={saving}
                className="max-w-xs"
              />
              <p className="text-xs text-muted-foreground">
                Between 1 and 90 days. Default 30. Only applies to{" "}
                <code className="font-mono">university_admin</code>;{" "}
                <code className="font-mono">super_admin</code> always
                completes MFA.
              </p>
            </div>
            {error ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
