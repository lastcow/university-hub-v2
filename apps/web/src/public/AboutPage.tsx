import { Compass, HeartHandshake, Lightbulb, Target } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const VALUES = [
  {
    icon: Target,
    title: "Focused, not sprawling",
    body: "Universities don't need another all-purpose CMS. They need identity, access, academics, and the audit trail. We ship those with care and stop there.",
  },
  {
    icon: HeartHandshake,
    title: "Invitation-only, on purpose",
    body: "Open registration belongs on consumer products. For higher education, every account is sponsored, scoped, and accountable.",
  },
  {
    icon: Lightbulb,
    title: "Backend is the source of truth",
    body: "Permissions, status transitions, and business rules live in the backend. The frontend hides the things you can't do; the API enforces them.",
  },
  {
    icon: Compass,
    title: "Predictable in production",
    body: "Cloudflare Workers, D1, and Pages — a small, well-understood deployment surface that operations teams can actually reason about.",
  },
];

export function AboutPage() {
  return (
    <div>
      <section className="border-b bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              A purpose-built workspace for higher education
            </h1>
            <p className="mt-5 text-lg text-muted-foreground">
              University Hub exists to give institutions a polished, modern
              workspace that respects how universities actually run — by
              roles, by departments, by invitation. No sprawling features
              you'll never use, no compromises on access control.
            </p>
          </div>
        </div>
      </section>

      <section className="border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
            <div className="space-y-4">
              <h2 className="text-3xl font-semibold tracking-tight">
                Why we're building this
              </h2>
              <p className="text-muted-foreground">
                Most institutions are stitched together from spreadsheets,
                email threads, and a handful of legacy systems that were
                designed before SaaS existed. Faculty redo work that admins
                already did. Students wait days for access that should be
                automatic. Auditors can't find the trail when something goes
                wrong.
              </p>
              <p className="text-muted-foreground">
                University Hub starts from a different premise: identity and
                access first, then the academic structure, then the
                operational tooling on top — all with the same disciplined
                design language and the same backend-enforced permissions.
              </p>
            </div>

            <div className="space-y-4">
              <h2 className="text-3xl font-semibold tracking-tight">
                Who it's for
              </h2>
              <p className="text-muted-foreground">
                University administrators who want a clean way to onboard
                everyone — staff, faculty, teachers, teaching assistants,
                students, and external collaborators — without compromising
                on RBAC. Faculty and academic staff who want focused
                dashboards. Students who want a calm read-mostly view of
                their courses and profile.
              </p>
              <p className="text-muted-foreground">
                If you've ever audited a permissions matrix and felt a
                little nervous, this product is for you.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-b">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="mb-10 max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight">
              What we believe
            </h2>
            <p className="mt-3 text-muted-foreground">
              The choices below show up in every feature we build.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {VALUES.map((v) => (
              <Card key={v.title}>
                <CardHeader>
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <v.icon className="h-4 w-4" />
                  </div>
                  <CardTitle className="text-base">{v.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription>{v.body}</CardDescription>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="rounded-2xl border bg-card p-8 text-center shadow-sm sm:p-12">
            <h2 className="text-2xl font-semibold tracking-tight">
              We'd love to talk to your team
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
              Tell us about your institution and what you'd like to get out
              of a modern hub. We read every message.
            </p>
            <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild>
                <Link to="/contact">Get in touch</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/features">See features</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
