// /app/settings — university, account, Mailgun status (UNI-15).
//
// Account section is always shown to the signed-in user.
// University section is gated to super_admin / university_admin.
// Mailgun section displays per-var Configured / Missing configuration; the
// underlying API never returns secret values, so this page never has access
// to one and never echoes one.

import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  University,
  UserCircle,
  XCircle,
} from "lucide-react";

import type {
  MailgunStatusResponse,
  MailgunVarStatusEntry,
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
// Security / session placeholder
// ---------------------------------------------------------------------------

function SecuritySection() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Security & sessions</CardTitle>
        </div>
        <CardDescription>
          Single-session-per-user with HttpOnly session cookies. Multi-device
          session management is planned for a future release.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium">This session</p>
            <p className="text-muted-foreground">
              You're signed in via a secure HttpOnly cookie. To revoke this
              session, sign out from the user menu.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
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
