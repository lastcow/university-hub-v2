// /app/courses/:id/edit — super_admin or that university's admin only.

import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import {
  COURSE_STATUSES,
  type CourseListItem,
  type CourseStatus,
  type DepartmentListItem,
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
import { getCourse, updateCourse } from "@/lib/courses";
import { listDepartments } from "@/lib/departments";

interface State {
  status: "loading" | "ok" | "error";
  data?: CourseListItem;
  error?: string;
}

export function CourseEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [state, setState] = useState<State>({ status: "loading" });
  const [departments, setDepartments] = useState<DepartmentListItem[]>([]);
  const [departmentId, setDepartmentId] = useState<string>("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<CourseStatus>("active");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    getCourse(id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ok", data });
        setDepartmentId(data.department_id ?? "");
        setName(data.name);
        setCode(data.code ?? "");
        setDescription(data.description ?? "");
        setStatus(data.status);
        return listDepartments(
          { university_id: data.university_id },
          controller.signal,
        );
      })
      .then((rows) => {
        if (!rows || controller.signal.aborted) return;
        setDepartments(rows);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error:
            cause instanceof ApiClientError
              ? cause.message
              : "Could not load course.",
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
        description="You don't have permission to edit this course."
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
      const updated = await updateCourse(id, {
        department_id: departmentId || null,
        name,
        code: code.trim() || null,
        description: description.trim() || null,
        status,
      });
      toast({
        title: "Course updated",
        description: `${updated.name} has been saved.`,
        variant: "success",
      });
      navigate(`/app/courses/${id}`);
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
        setFormError("Could not update course. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link to={id ? `/app/courses/${id}` : "/app/courses"}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Edit course</h1>
      </div>

      {state.status === "loading" ? (
        <Card className="space-y-3 p-6">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
        </Card>
      ) : state.status === "error" ? (
        <ErrorState title="Couldn't load course" description={state.error} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Edit details</CardTitle>
            <CardDescription>
              Saving writes a `course.updated` audit row.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
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
                  onClick={() => navigate(`/app/courses/${id}`)}
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
