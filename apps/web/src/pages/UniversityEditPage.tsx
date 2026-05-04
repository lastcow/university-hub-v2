// /app/universities/:id/edit — super_admin or that university's admin only.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import {
  UNIVERSITY_STATUSES,
  type University,
  type UniversityStatus,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { getUniversity, updateUniversity } from "@/lib/universities";

interface State {
  status: "loading" | "ok" | "error";
  data?: University;
  error?: string;
}

export function UniversityEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [state, setState] = useState<State>({ status: "loading" });
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<UniversityStatus>("active");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getUniversity(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        setName(data.name);
        setSlug(data.slug ?? "");
        setStatus(data.status);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load university.",
        });
      });
    return () => controller.abort();
  }, [id]);

  const canEdit =
    state.data && user
      ? user.role === "super_admin" ||
        (user.role === "university_admin" && user.university_id === state.data.id)
      : false;

  if (state.status === "ok" && !canEdit) {
    return (
      <ErrorState
        title="Access denied"
        description="You don't have permission to edit this university."
      />
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!id) return;
    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const updated = await updateUniversity(id, {
        name,
        slug: slug.trim() || null,
        status,
      });
      toast({
        title: "University updated",
        description: `${updated.name} has been saved.`,
        variant: "success",
      });
      navigate(`/app/universities/${id}`);
    } catch (cause) {
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
      } else {
        setFormError("Could not update university. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to={id ? `/app/universities/${id}` : "/app/universities"}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Edit university</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load university" description={state.error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Edit details</CardTitle>
            <CardDescription>
              Updating these fields writes a `university.updated` audit row.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="uni-name">Name</Label>
                <Input
                  id="uni-name"
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
                <Label htmlFor="uni-slug">Slug</Label>
                <Input
                  id="uni-slug"
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

              <div className="space-y-2">
                <Label htmlFor="uni-status">Status</Label>
                <select
                  id="uni-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as UniversityStatus)}
                  disabled={submitting}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {UNIVERSITY_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
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
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => navigate(`/app/universities/${id}`)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
