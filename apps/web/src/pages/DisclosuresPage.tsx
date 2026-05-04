// /app/disclosures — admin record-of-disclosure (FERPA §99.32) (UNI-32).
//
// Lists every release; the form below records a new release referencing one
// of the student's existing non-revoked consents. RBAC is super_admin /
// university_admin (worker also enforces).

import { useEffect, useMemo, useState, type FormEvent } from "react";

import {
  DISCLOSURE_DATA_CATEGORIES,
  DISCLOSURE_DATA_CATEGORY_LABELS,
  type DisclosureConsentListItem,
  type DisclosureDataCategory,
  type DisclosureLogListItem,
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
import { listStudents } from "@/lib/directories";
import {
  listDisclosureConsents,
  listDisclosures,
  recordDisclosure,
} from "@/lib/disclosures";
import { cn } from "@/lib/utils";

const ADMIN_ROLES: ReadonlySet<string> = new Set([
  "super_admin",
  "university_admin",
]);

interface ListState {
  status: "loading" | "ok" | "error";
  items: DisclosureLogListItem[];
  error?: string;
}

interface ConsentsState {
  status: "idle" | "loading" | "ok" | "error";
  items: DisclosureConsentListItem[];
  error?: string;
}

export function DisclosuresPage() {
  const { user } = useAuth();
  const [list, setList] = useState<ListState>({
    status: "loading",
    items: [],
  });
  const [students, setStudents] = useState<StudentListItem[]>([]);
  const [studentId, setStudentId] = useState<string>("");
  const [consents, setConsents] = useState<ConsentsState>({
    status: "idle",
    items: [],
  });
  const [consentId, setConsentId] = useState<string>("");
  const [releasedTo, setReleasedTo] = useState("");
  const [notes, setNotes] = useState("");
  const [categories, setCategories] = useState<DisclosureDataCategory[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user || !ADMIN_ROLES.has(user.role)) return;
    const controller = new AbortController();
    void Promise.all([
      listDisclosures({}, controller.signal),
      listStudents({}, controller.signal),
    ])
      .then(([logs, students]) => {
        if (controller.signal.aborted) return;
        setList({ status: "ok", items: logs.items });
        setStudents(students);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setList({
          status: "error",
          items: [],
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load disclosure log.",
        });
      });
    return () => controller.abort();
  }, [user]);

  useEffect(() => {
    if (!studentId) {
      setConsents({ status: "idle", items: [] });
      setConsentId("");
      return;
    }
    const controller = new AbortController();
    setConsents({ status: "loading", items: [] });
    listDisclosureConsents({ student_user_id: studentId }, controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        const active = items.filter((c) => c.active);
        setConsents({ status: "ok", items: active });
        setConsentId(active[0]?.id ?? "");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setConsents({
          status: "error",
          items: [],
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load consents for this student.",
        });
      });
    return () => controller.abort();
  }, [studentId]);

  const selectedConsent = useMemo(
    () => consents.items.find((c) => c.id === consentId),
    [consents.items, consentId],
  );

  // When the consent changes, reset the categories to the consent's full
  // covered set so the admin can deselect from there.
  useEffect(() => {
    if (selectedConsent) {
      setCategories([...selectedConsent.data_categories]);
    } else {
      setCategories([]);
    }
  }, [selectedConsent]);

  if (!user || !ADMIN_ROLES.has(user.role)) {
    return (
      <ErrorState
        title="Admins only"
        description="The disclosure log is restricted to super_admin and university_admin."
      />
    );
  }

  function toggleCategory(c: DisclosureDataCategory) {
    setCategories((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consentId || !releasedTo.trim() || categories.length === 0) {
      toast({
        title: "Missing information",
        description:
          "Pick a consent, name the recipient, and select at least one data category.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      const created = await recordDisclosure({
        consent_id: consentId,
        released_to: releasedTo.trim(),
        data_categories: categories,
        notes: notes.trim() ? notes.trim() : null,
      });
      toast({ title: "Disclosure recorded." });
      // Refresh the list — we don't have the joined names locally, so refetch
      // is simpler than synthesising the list item.
      const refreshed = await listDisclosures();
      setList({ status: "ok", items: refreshed.items });
      setReleasedTo("");
      setNotes("");
      void created;
    } catch (cause) {
      toast({
        title: "Could not record disclosure",
        description:
          cause instanceof ApiClientError
            ? cause.message
            : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Disclosure log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          FERPA §99.32 record of every release of a student's education
          records to a third party. Recording a release without a referenced
          non-revoked consent is rejected.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Record a new disclosure</CardTitle>
          <CardDescription>
            Pick a student, select one of their active consents, and record
            what was released to whom.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                <span className="font-medium">Student</span>
                <select
                  value={studentId}
                  onChange={(e) => setStudentId(e.target.value)}
                  className={cn(
                    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                  )}
                >
                  <option value="">Select…</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.user_id}>
                      {s.name} ({s.email})
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1 text-sm">
                <span className="font-medium">Active consent</span>
                <select
                  value={consentId}
                  onChange={(e) => setConsentId(e.target.value)}
                  disabled={!studentId || consents.status !== "ok"}
                  className={cn(
                    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  <option value="">
                    {consents.status === "loading"
                      ? "Loading consents…"
                      : consents.status === "ok" && consents.items.length === 0
                        ? "No active consents"
                        : "Select…"}
                  </option>
                  {consents.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.requester} — {c.purpose.slice(0, 60)}
                      {c.purpose.length > 60 ? "…" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="space-y-1 text-sm">
              <span className="font-medium">Released to</span>
              <input
                type="text"
                value={releasedTo}
                onChange={(e) => setReleasedTo(e.target.value)}
                placeholder="Scholarship Office, Dept. of Education, …"
                maxLength={200}
                className={cn(
                  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                )}
              />
            </label>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Data categories</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {DISCLOSURE_DATA_CATEGORIES.map((c) => {
                  const allowed =
                    !selectedConsent ||
                    selectedConsent.data_categories.includes(c);
                  return (
                    <label
                      key={c}
                      className={cn(
                        "flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm",
                        !allowed && "opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={categories.includes(c)}
                        disabled={!allowed}
                        onChange={() => toggleCategory(c)}
                      />
                      <span>{DISCLOSURE_DATA_CATEGORY_LABELS[c]}</span>
                    </label>
                  );
                })}
              </div>
              {selectedConsent ? (
                <p className="text-xs text-muted-foreground">
                  Categories outside the selected consent are disabled — only
                  the consent's covered set is releasable under it.
                </p>
              ) : null}
            </fieldset>

            <label className="space-y-1 text-sm">
              <span className="font-medium">Notes (optional)</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                maxLength={2000}
                className={cn(
                  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                )}
              />
            </label>

            <div className="flex justify-end">
              <Button type="submit" disabled={submitting}>
                {submitting ? "Recording…" : "Record disclosure"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recorded disclosures</CardTitle>
          <CardDescription>
            Append-only — recorded entries are never deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {list.status === "loading" ? (
            <Skeleton className="h-4 w-1/3" />
          ) : list.status === "error" ? (
            <p className="text-sm text-destructive">{list.error}</p>
          ) : list.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No disclosures recorded yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Student</th>
                  <th className="py-2 pr-3">Released to</th>
                  <th className="py-2 pr-3">Categories</th>
                  <th className="py-2 pr-3">Consent</th>
                  <th className="py-2 pr-3">Released by</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((row) => (
                  <tr key={row.id} className="border-t border-border align-top">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {new Date(row.released_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">
                        {row.student_name ?? "—"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {row.student_email ?? ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3">{row.released_to}</td>
                    <td className="py-2 pr-3">
                      <div className="flex flex-wrap gap-1">
                        {row.data_categories.map((cat) => (
                          <Badge key={cat} variant="outline">
                            {DISCLOSURE_DATA_CATEGORY_LABELS[cat]}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <div>{row.consent_requester ?? "—"}</div>
                      <div className="text-muted-foreground">
                        {row.consent_purpose
                          ? row.consent_purpose.slice(0, 60) +
                            (row.consent_purpose.length > 60 ? "…" : "")
                          : ""}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {row.released_by_name ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
