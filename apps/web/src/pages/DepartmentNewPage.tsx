// /app/departments/new — super_admin or university_admin.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import type { University } from "@university-hub/shared";

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
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { createDepartment } from "@/lib/departments";
import { listUniversities } from "@/lib/universities";

export function DepartmentNewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate =
    user?.role === "super_admin" || user?.role === "university_admin";

  const [universities, setUniversities] = useState<University[]>([]);
  const [universityId, setUniversityId] = useState<string>("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // super_admin must pick a university; university_admin is locked to their
  // own. Loading the list serves both — university_admin will get back a
  // single-row list anyway and we use the first id to seed the value.
  useEffect(() => {
    if (!canCreate) return;
    const controller = new AbortController();
    listUniversities(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setUniversities(rows);
        if (rows.length === 1) setUniversityId(rows[0]!.id);
      })
      .catch(() => {
        // Non-fatal: the form still works for super_admin once they paste an id.
      });
    return () => controller.abort();
  }, [canCreate]);

  if (!canCreate) {
    return (
      <ErrorState
        title="Access denied"
        description="Only admins can create departments."
      />
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const created = await createDepartment({
        ...(user?.role === "super_admin" ? { university_id: universityId } : {}),
        name,
        code: code.trim() || null,
        description: description.trim() || null,
      });
      toast({
        title: "Department created",
        description: `${created.name} is ready for courses.`,
        variant: "success",
      });
      navigate(`/app/departments/${created.id}`);
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
        setFormError("Could not create department. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <a href="/app/departments">
            <ArrowLeft className="h-4 w-4" />
            Back
          </a>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New department</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Department details</CardTitle>
          <CardDescription>
            The code is optional but makes courses easier to scan in tables.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            {user?.role === "super_admin" ? (
              <div className="space-y-2">
                <Label htmlFor="dept-uni">University</Label>
                <select
                  id="dept-uni"
                  required
                  value={universityId}
                  onChange={(e) => setUniversityId(e.target.value)}
                  disabled={submitting}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="" disabled>
                    Select a university…
                  </option>
                  {universities.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
                {fieldErrors.university_id ? (
                  <p className="text-xs font-medium text-destructive">
                    {fieldErrors.university_id}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="dept-name">Name</Label>
              <Input
                id="dept-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                placeholder="e.g. Computer Science"
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
                placeholder="e.g. CS"
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
                placeholder="Optional summary for the directory."
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
                onClick={() => navigate("/app/departments")}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create department"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
