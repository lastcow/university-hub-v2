// /app/courses/new — super_admin or university_admin.

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import {
  COURSE_STATUSES,
  type CourseStatus,
  type DepartmentListItem,
  type University,
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
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { createCourse } from "@/lib/courses";
import { listDepartments } from "@/lib/departments";
import { listUniversities } from "@/lib/universities";

export function CourseNewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canCreate =
    user?.role === "super_admin" || user?.role === "university_admin";

  const [universities, setUniversities] = useState<University[]>([]);
  const [departments, setDepartments] = useState<DepartmentListItem[]>([]);
  const [universityId, setUniversityId] = useState<string>("");
  const [departmentId, setDepartmentId] = useState<string>("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<CourseStatus>("active");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!canCreate) return;
    const controller = new AbortController();
    listUniversities(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setUniversities(rows);
        if (rows.length === 1) setUniversityId(rows[0]!.id);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [canCreate]);

  // Re-fetch departments whenever the university changes (super_admin path);
  // university_admin always sees their own scope so this fires once on mount.
  useEffect(() => {
    if (!canCreate) return;
    const controller = new AbortController();
    listDepartments(
      universityId ? { university_id: universityId } : {},
      controller.signal,
    )
      .then((rows) => {
        if (controller.signal.aborted) return;
        setDepartments(rows);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [canCreate, universityId]);

  if (!canCreate) {
    return (
      <ErrorState
        title="Access denied"
        description="Only admins can create courses."
      />
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const created = await createCourse({
        ...(user?.role === "super_admin" ? { university_id: universityId } : {}),
        department_id: departmentId || null,
        name,
        code: code.trim() || null,
        description: description.trim() || null,
        status,
      });
      toast({
        title: "Course created",
        description: `${created.name} is ready.`,
        variant: "success",
      });
      navigate(`/app/courses/${created.id}`);
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
        setFormError("Could not create course. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <a href="/app/courses">
            <ArrowLeft className="h-4 w-4" />
            Back
          </a>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New course</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Course details</CardTitle>
          <CardDescription>
            Pick a department to keep the course discoverable in the directory.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            {user?.role === "super_admin" ? (
              <div className="space-y-2">
                <Label htmlFor="course-uni">University</Label>
                <select
                  id="course-uni"
                  required
                  value={universityId}
                  onChange={(e) => {
                    setUniversityId(e.target.value);
                    setDepartmentId("");
                  }}
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
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="course-dept">Department</Label>
              <select
                id="course-dept"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={submitting}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">Unassigned</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="course-name">Name</Label>
              <Input
                id="course-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                placeholder="e.g. Introduction to Algorithms"
                aria-invalid={fieldErrors.name ? "true" : "false"}
              />
              {fieldErrors.name ? (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.name}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="course-code">Code</Label>
              <Input
                id="course-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={submitting}
                placeholder="e.g. CS-201"
                aria-invalid={fieldErrors.code ? "true" : "false"}
              />
              {fieldErrors.code ? (
                <p className="text-xs font-medium text-destructive">
                  {fieldErrors.code}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="course-status">Status</Label>
              <select
                id="course-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as CourseStatus)}
                disabled={submitting}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {COURSE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="course-description">Description</Label>
              <textarea
                id="course-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitting}
                rows={4}
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
                onClick={() => navigate("/app/courses")}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create course"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
