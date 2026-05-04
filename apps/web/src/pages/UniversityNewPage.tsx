// /app/universities/new — super_admin only.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

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
import { createUniversity } from "@/lib/universities";

export function UniversityNewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  if (!user || user.role !== "super_admin") {
    return (
      <ErrorState
        title="Access denied"
        description="Only super admins can create universities."
      />
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSubmitting(true);
    try {
      const created = await createUniversity({
        name,
        slug: slug.trim() || null,
      });
      toast({
        title: "University created",
        description: `${created.name} is now active.`,
        variant: "success",
      });
      navigate(`/app/universities/${created.id}`);
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
        setFormError("Could not create university. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <a href="/app/universities">
            <ArrowLeft className="h-4 w-4" />
            Back
          </a>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New university</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>University details</CardTitle>
          <CardDescription>
            The slug must be lowercase letters, numbers, and dashes. It's
            optional; leave it blank to skip.
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
                placeholder="e.g. demo-university"
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
              <Button
                type="button"
                variant="ghost"
                onClick={() => navigate("/app/universities")}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create university"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
