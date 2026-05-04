// /app/departments/:id/edit — super_admin or that university's admin only.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import type { DepartmentListItem } from "@university-hub/shared";

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
import { getDepartment, updateDepartment } from "@/lib/departments";

interface State {
  status: "loading" | "ok" | "error";
  data?: DepartmentListItem;
  error?: string;
}

export function DepartmentEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [state, setState] = useState<State>({ status: "loading" });
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getDepartment(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        setName(data.name);
        setCode(data.code ?? "");
        setDescription(data.description ?? "");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load department.",
        });
      });
    return () => controller.abort();
  }, [id]);

  const canEdit =
    state.data && user
      ? user.role === "super_admin" ||
        (user.role === "university_admin" &&
          user.university_id === state.data.university_id)
      : false;

  if (state.status === "ok" && !canEdit) {
    return (
      <ErrorState
        title="Access denied"
        description="You don't have permission to edit this department."
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
      const updated = await updateDepartment(id, {
        name,
        code: code.trim() || null,
        description: description.trim() || null,
      });
      toast({
        title: "Department updated",
        description: `${updated.name} has been saved.`,
        variant: "success",
      });
      navigate(`/app/departments/${id}`);
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
        setFormError("Could not update department. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to={id ? `/app/departments/${id}` : "/app/departments"}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Edit department</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load department" description={state.error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Edit details</CardTitle>
            <CardDescription>
              Saving writes a `department.updated` audit row.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="dept-name">Name</Label>
                <Input
                  id="dept-name"
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
                <Label htmlFor="dept-code">Code</Label>
                <Input
                  id="dept-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={submitting}
                  placeholder="optional"
                  aria-invalid={fieldErrors.code ? "true" : "false"}
                />
                {fieldErrors.code ? (
                  <p className="text-xs font-medium text-destructive">
                    {fieldErrors.code}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="dept-description">Description</Label>
                <textarea
                  id="dept-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={submitting}
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
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
                  onClick={() => navigate(`/app/departments/${id}`)}
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
