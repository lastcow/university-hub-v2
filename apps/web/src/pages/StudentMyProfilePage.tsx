// /app/student/my-profile — student profile + FERPA controls (UNI-13, UNI-32).
//
// FERPA controls (UNI-32):
//   - Directory-info opt-out toggle (over-18 students only; under-18 sees a
//     read-only notice pointing them at the parent flow).
//   - Active disclosure consents list with revoke buttons.

import { useEffect, useState, type FormEvent } from "react";

import {
  DISCLOSURE_DATA_CATEGORY_LABELS,
  type DisclosureConsentListItem,
  type StudentListItem,
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
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { getMyStudent } from "@/lib/directories";
import {
  listDisclosureConsents,
  revokeDisclosureConsent,
  updateStudentDirectoryInfo,
} from "@/lib/disclosures";

interface ProfileState {
  status: "loading" | "ok" | "error";
  data?: StudentListItem;
  error?: string;
}

interface ConsentsState {
  status: "loading" | "ok" | "error";
  items: DisclosureConsentListItem[];
  error?: string;
}

export function StudentMyProfilePage() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<ProfileState>({ status: "loading" });
  const [consents, setConsents] = useState<ConsentsState>({
    status: "loading",
    items: [],
  });
  const [savingOptOut, setSavingOptOut] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== "student") return;
    const controller = new AbortController();
    setProfile({ status: "loading" });
    getMyStudent(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setProfile({ status: "ok", data });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setProfile({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load your profile.",
        });
      });
    return () => controller.abort();
  }, [user?.role]);

  useEffect(() => {
    if (user?.role !== "student") return;
    const controller = new AbortController();
    setConsents({ status: "loading", items: [] });
    listDisclosureConsents({ student_user_id: user.id }, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setConsents({ status: "ok", items });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setConsents({
          status: "error",
          items: [],
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load your disclosure consents.",
        });
      });
    return () => controller.abort();
  }, [user?.role, user?.id]);

  if (user?.role !== "student") {
    return (
      <ErrorState
        title="Students only"
        description="This page is only available to student accounts."
      />
    );
  }

  async function onToggleOptOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile.data) return;
    setSavingOptOut(true);
    try {
      const updated = await updateStudentDirectoryInfo(profile.data.id, {
        directory_info_opt_out: !profile.data.directory_info_opt_out,
      });
      setProfile({ status: "ok", data: updated });
      toast({
        title: updated.directory_info_opt_out
          ? "Directory information hidden"
          : "Directory information sharing enabled",
      });
    } catch (cause) {
      toast({
        title: "Could not update preference",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSavingOptOut(false);
    }
  }

  async function onRevoke(consent: DisclosureConsentListItem) {
    setRevokingId(consent.id);
    try {
      const updated = await revokeDisclosureConsent(consent.id);
      setConsents((prev) => ({
        ...prev,
        items: prev.items.map((c) =>
          c.id === consent.id
            ? {
                ...c,
                revoked_at: updated.revoked_at,
                revoked_by_user_id: updated.revoked_by_user_id,
                active: false,
              }
            : c,
        ),
      }));
      toast({ title: "Consent revoked." });
    } catch (cause) {
      toast({
        title: "Could not revoke consent",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Read-only profile fields — contact your university admin to request a
          change. FERPA controls below let you manage what we share.
        </p>
      </div>

      {profile.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : profile.status === "error" ? (
        <ErrorState title="Couldn't load profile" description={profile.error} />
      ) : profile.data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{profile.data.name}</CardTitle>
              <CardDescription>{profile.data.email}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <div>
                Student number:{" "}
                <span className="font-mono text-foreground">
                  {profile.data.student_number ?? "—"}
                </span>
              </div>
              <div>
                Department:{" "}
                <span className="text-foreground">
                  {profile.data.department_name ?? "Unassigned"}
                </span>
              </div>
              <div>
                University:{" "}
                <span className="text-foreground">
                  {profile.data.university_name ?? "—"}
                </span>
              </div>
              {profile.data.under_18 ? (
                <div>
                  <Badge variant="secondary">Under 18</Badge>
                  <span className="ml-2">
                    Some FERPA controls are managed by your parent or guardian
                    via{" "}
                    <code className="font-mono">/sign-in/parent</code>.
                  </span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Directory information</CardTitle>
              <CardDescription>
                FERPA lets us release "directory information" — your name,
                department, and similar fields — to third parties unless you
                opt out. Toggle this any time.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                onSubmit={onToggleOptOut}
                className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="text-sm">
                  Current status:{" "}
                  {profile.data.directory_info_opt_out ? (
                    <Badge variant="warning">Opted out</Badge>
                  ) : (
                    <Badge variant="success">Sharing allowed</Badge>
                  )}
                </div>
                {profile.data.under_18 ? (
                  <span className="text-xs text-muted-foreground">
                    Under-18 students cannot change this themselves — ask your
                    parent or guardian.
                  </span>
                ) : (
                  <Button
                    type="submit"
                    variant={
                      profile.data.directory_info_opt_out ? "outline" : "default"
                    }
                    disabled={savingOptOut}
                  >
                    {savingOptOut
                      ? "Saving…"
                      : profile.data.directory_info_opt_out
                        ? "Allow directory sharing"
                        : "Opt out of directory sharing"}
                  </Button>
                )}
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Disclosure consents</CardTitle>
              <CardDescription>
                Written consents you have granted for the institution to
                release your education records to a specific party. Revoke any
                that should no longer apply.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {consents.status === "loading" ? (
                <Skeleton className="h-4 w-1/3" />
              ) : consents.status === "error" ? (
                <p className="text-sm text-destructive">{consents.error}</p>
              ) : consents.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No disclosure consents on file.
                </p>
              ) : (
                <ul className="space-y-3">
                  {consents.items.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-md border border-border bg-muted/30 p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="flex-1">
                          <div className="font-medium text-foreground">
                            {c.requester}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Purpose: {c.purpose}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {c.data_categories.map((cat) => (
                              <Badge key={cat} variant="outline">
                                {DISCLOSURE_DATA_CATEGORY_LABELS[cat]}
                              </Badge>
                            ))}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            Granted{" "}
                            {new Date(c.granted_at).toLocaleString()}
                            {c.expires_at
                              ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}`
                              : ""}
                            {c.revoked_at
                              ? ` · revoked ${new Date(c.revoked_at).toLocaleString()}`
                              : ""}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          {c.active ? (
                            <Badge variant="success">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                          {c.active && !c.revoked_at ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={revokingId === c.id}
                              onClick={() => onRevoke(c)}
                            >
                              {revokingId === c.id ? "Revoking…" : "Revoke"}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
