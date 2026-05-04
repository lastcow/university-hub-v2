import {
  BookOpen,
  Building2,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  Mail,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface FeatureSection {
  title: string;
  blurb: string;
  features: Array<{
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    body: string;
  }>;
}

const SECTIONS: FeatureSection[] = [
  {
    title: "Administration",
    blurb:
      "Full-fledged controls for super admins and university admins — the people running the institution day-to-day.",
    features: [
      {
        icon: Building2,
        title: "Universities & departments",
        body: "Create, edit, and archive universities. Organize departments under each one with assigned staff and faculty.",
      },
      {
        icon: Users,
        title: "User directory",
        body: "Search and filter users by role and status. Toggle activation, change roles, and view per-user audit history.",
      },
      {
        icon: ShieldCheck,
        title: "Backend RBAC",
        body: "Every protected API verifies session, role, and university scope. Frontend visibility is convenience — the API is canonical.",
      },
      {
        icon: ScrollText,
        title: "Audit logs",
        body: "Sign-ins, invitation lifecycle, role changes, course CRUD, and email outcomes — all timestamped and queryable.",
      },
    ],
  },
  {
    title: "Academics",
    blurb:
      "Departments, courses, and assignments built around how universities actually structure their programs.",
    features: [
      {
        icon: ClipboardList,
        title: "Departments & courses",
        body: "Departments scope faculty and staff. Courses associate with departments, with assignment roles for faculty, teachers, and TAs.",
      },
      {
        icon: BookOpen,
        title: "Faculty, teacher & TA workflows",
        body: "Dedicated dashboards for academic staff with course rosters, student lists, and TA-assisted classes.",
      },
      {
        icon: LayoutDashboard,
        title: "Role-aware dashboards",
        body: "Every role lands on a dashboard tailored to what they're allowed to do — no irrelevant menus, no broken links.",
      },
    ],
  },
  {
    title: "Students",
    blurb:
      "A focused, read-most experience for students and a simple guest mode for invited external collaborators.",
    features: [
      {
        icon: GraduationCap,
        title: "Student dashboard",
        body: "My courses and my profile — a clean view of what a student is enrolled in and how to reach their teachers.",
      },
      {
        icon: Users,
        title: "Guest access",
        body: "External collaborators get a limited, read-only dashboard with shared resources, never the full admin surface.",
      },
    ],
  },
  {
    title: "Invitations & email",
    blurb:
      "Invitation-only onboarding backed by Mailgun templates and full delivery telemetry.",
    features: [
      {
        icon: Mail,
        title: "Invitation lifecycle",
        body: "Issue, resend, and revoke invitations. Tokens are single-use, hashed at rest, and validated server-side on acceptance.",
      },
      {
        icon: ScrollText,
        title: "Email logs",
        body: "Per-attempt records: recipient, template, Mailgun message ID, status, and failure reason — restricted to admins.",
      },
    ],
  },
];

export function FeaturesPage() {
  return (
    <div>
      <section className="border-b bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Everything a university workspace needs
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              A focused product instead of a sprawling one — with deliberate
              role boundaries, clean academic structure, and an audit-grade
              backend.
            </p>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-6xl space-y-16 px-4 py-16 lg:px-6 lg:py-20">
        {SECTIONS.map((section) => (
          <section key={section.title}>
            <div className="mb-8 max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {section.title}
              </h2>
              <p className="mt-2 text-muted-foreground">{section.blurb}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.features.map((f) => (
                <Card key={f.title}>
                  <CardHeader>
                    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <f.icon className="h-4 w-4" />
                    </div>
                    <CardTitle className="text-base">{f.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CardDescription>{f.body}</CardDescription>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))}

        <div className="rounded-2xl border bg-card p-8 text-center shadow-sm sm:p-12">
          <h2 className="text-2xl font-semibold tracking-tight">
            Want to see it for your institution?
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Drop us a note — we'll walk you through the platform and answer
            any questions about the deployment model.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button asChild>
              <Link to="/contact">Contact us</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/sign-in">Sign in</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
