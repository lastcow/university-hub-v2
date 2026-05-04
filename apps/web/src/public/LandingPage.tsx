import {
  ArrowRight,
  CheckCircle2,
  GraduationCap,
  Mail,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const HIGHLIGHTS = [
  {
    icon: Users,
    title: "Roles & rosters",
    body: "Super admins, university admins, faculty, teachers, TAs, students, and guests — each with the right scope, never more.",
  },
  {
    icon: Mail,
    title: "Invitation-only access",
    body: "No public sign-up. Admins issue secure invitations; users redeem them and the system provisions the right role automatically.",
  },
  {
    icon: GraduationCap,
    title: "Academic structure",
    body: "Universities, departments, and courses with clean associations, role-aware dashboards, and teacher / student views.",
  },
  {
    icon: ShieldCheck,
    title: "Backend RBAC",
    body: "Permissions are enforced server-side on every request. The UI hides what you can't do, but the API is the source of truth.",
  },
];

const STEPS = [
  {
    title: "Admin invites the right people",
    body: "Issue invitations by role and email — the system signs and emails a single-use link.",
  },
  {
    title: "Recipient creates an account",
    body: "Token-validated acceptance with backend-enforced expiry and role assignment.",
  },
  {
    title: "Everyone lands in the right place",
    body: "Role-aware dashboards for admins, faculty, teachers, TAs, students, and guests.",
  },
];

export function LandingPage() {
  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden border-b">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background"
        />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-20 lg:px-6 lg:py-28">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="secondary" className="mb-4">
              <Sparkles className="h-3 w-3" />
              Invitation-only platform for higher education
            </Badge>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              Run your university like a modern{" "}
              <span className="text-primary">SaaS platform.</span>
            </h1>
            <p className="mt-6 text-lg text-muted-foreground">
              University Hub gives administrators, faculty, teachers, and
              students one polished, role-aware workspace — with secure
              invitation onboarding, audit-grade RBAC, and a clean academic
              data model.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/sign-in">
                  Sign in
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/accept-invitation">Accept invitation</Link>
              </Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Don't have an invitation? Ask your university administrator —
              public sign-up is intentionally disabled.
            </p>
          </div>
        </div>
      </section>

      {/* Highlights */}
      <section className="border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Built for the way universities actually work
            </h2>
            <p className="mt-3 text-muted-foreground">
              A focused feature set: identity, access, academic structure, and
              the audit trail your institution needs.
            </p>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {HIGHLIGHTS.map((item) => (
              <Card key={item.title}>
                <CardHeader>
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <CardTitle className="text-base">{item.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{item.body}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Button asChild variant="link">
              <Link to="/features">
                See every feature
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Onboarding without the chaos
            </h2>
            <p className="mt-3 text-muted-foreground">
              From the first invitation to a fully provisioned account, every
              step is signed, scoped, and logged.
            </p>
          </div>
          <ol className="mt-12 grid gap-6 md:grid-cols-3">
            {STEPS.map((step, idx) => (
              <li
                key={step.title}
                className="rounded-lg border bg-card p-6 shadow-sm"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {idx + 1}
                </div>
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Trust strip */}
      <section className="border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-12 lg:px-6">
          <div className="grid gap-6 sm:grid-cols-3">
            {[
              "Backend-enforced permissions on every request",
              "Single-use invitation tokens — never stored in plain text",
              "Audit log of every consequential admin action",
            ].map((line) => (
              <div key={line} className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <p className="text-sm text-foreground">{line}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section>
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="rounded-2xl border bg-card p-8 text-center shadow-sm sm:p-12">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Ready to bring your campus on board?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
              We'd love to hear about your institution. Tell us what you're
              looking for and we'll get back to you.
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/contact">Talk to us</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/about">About University Hub</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
