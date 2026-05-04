// Public /contact — collects name + email + message and POSTs to /api/contact.
// The Worker validates with the shared zod schema, persists to D1, and returns
// success. We surface server-side validation errors per-field, fall back to a
// generic toast on transport errors, and show an inline success state once
// the message has been recorded.

import { useState, type FormEvent } from "react";
import { CheckCircle2, Mail, MessageSquare, ShieldCheck } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import { ApiClientError } from "@/lib/api";
import { submitContactMessage } from "@/lib/contact";
import { cn } from "@/lib/utils";

type FieldErrors = Partial<Record<"name" | "email" | "message", string>>;

interface ApiValidationDetails {
  issues?: Record<string, string[] | undefined>;
}

const SIDEBAR = [
  {
    icon: ShieldCheck,
    title: "Invitation-only platform",
    body: "We don't sell you anything from this form. Real conversations only.",
  },
  {
    icon: Mail,
    title: "We read every message",
    body: "A real person responds — typically within a couple of business days.",
  },
];

function readFieldErrors(error: ApiClientError): FieldErrors {
  const next: FieldErrors = {};
  const details = error.details as ApiValidationDetails | undefined;
  const issues = details?.issues;
  if (!issues) return next;
  for (const key of ["name", "email", "message"] as const) {
    const list = issues[key];
    if (Array.isArray(list) && typeof list[0] === "string") {
      next[key] = list[0];
    }
  }
  return next;
}

export function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  function clearFieldError(field: keyof FieldErrors) {
    if (!fieldErrors[field]) return;
    setFieldErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  function resetForm() {
    setName("");
    setEmail("");
    setMessage("");
    setFieldErrors({});
    setSubmitted(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setFieldErrors({});
    setSubmitting(true);
    try {
      await submitContactMessage({ name, email, message });
      setSubmitted(true);
      toast({
        title: "Message sent",
        description: "Thanks — we'll get back to you soon.",
        variant: "success",
      });
    } catch (cause) {
      if (cause instanceof ApiClientError) {
        if (cause.status === 400) {
          const issues = readFieldErrors(cause);
          if (Object.keys(issues).length > 0) {
            setFieldErrors(issues);
          } else {
            toast({
              title: "Please check the form",
              description: cause.message,
              variant: "destructive",
            });
          }
        } else {
          toast({
            title: "Couldn't send your message",
            description: cause.message,
            variant: "destructive",
          });
        }
      } else {
        toast({
          title: "Couldn't send your message",
          description: "Please try again in a moment.",
          variant: "destructive",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <section className="border-b bg-muted/30">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 lg:px-6 lg:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Talk to us
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              Tell us about your university and what you're looking for. We'll
              get back to you soon.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-16 lg:grid-cols-3 lg:px-6 lg:py-20">
          <div className="space-y-6 lg:col-span-1">
            {SIDEBAR.map((item) => (
              <div key={item.title} className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <item.icon className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold">{item.title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.body}
                  </p>
                </div>
              </div>
            ))}
            <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
              <p>
                Already have an invitation? Head to the sign-in page and use
                the link from your email.
              </p>
            </div>
          </div>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>
                {submitted ? "Message received" : "Send us a message"}
              </CardTitle>
              <CardDescription>
                {submitted
                  ? "Thanks for reaching out — we'll be in touch."
                  : "Fill in the form and we'll route it to the right person on our side."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {submitted ? (
                <div
                  data-testid="contact-success"
                  className="space-y-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-6 text-sm"
                >
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                    <div className="space-y-1">
                      <p className="font-medium text-foreground">
                        Your message has been recorded.
                      </p>
                      <p className="text-muted-foreground">
                        A team member will follow up shortly. If your enquiry
                        is urgent, please mention that in any follow-up.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button onClick={resetForm} variant="outline" size="sm">
                      <MessageSquare className="h-4 w-4" />
                      Send another message
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={onSubmit} noValidate className="space-y-5">
                  <div className="space-y-2">
                    <Label htmlFor="contact-name">Name</Label>
                    <Input
                      id="contact-name"
                      autoComplete="name"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        clearFieldError("name");
                      }}
                      disabled={submitting}
                      aria-invalid={fieldErrors.name ? "true" : "false"}
                      aria-describedby={
                        fieldErrors.name ? "contact-name-error" : undefined
                      }
                      className={cn(
                        fieldErrors.name &&
                          "border-destructive focus-visible:ring-destructive",
                      )}
                      required
                      maxLength={120}
                    />
                    {fieldErrors.name ? (
                      <p
                        id="contact-name-error"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.name}
                      </p>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="contact-email">Email</Label>
                    <Input
                      id="contact-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        clearFieldError("email");
                      }}
                      disabled={submitting}
                      aria-invalid={fieldErrors.email ? "true" : "false"}
                      aria-describedby={
                        fieldErrors.email ? "contact-email-error" : undefined
                      }
                      className={cn(
                        fieldErrors.email &&
                          "border-destructive focus-visible:ring-destructive",
                      )}
                      required
                    />
                    {fieldErrors.email ? (
                      <p
                        id="contact-email-error"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.email}
                      </p>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="contact-message">Message</Label>
                    <textarea
                      id="contact-message"
                      value={message}
                      onChange={(e) => {
                        setMessage(e.target.value);
                        clearFieldError("message");
                      }}
                      disabled={submitting}
                      aria-invalid={fieldErrors.message ? "true" : "false"}
                      aria-describedby={
                        fieldErrors.message
                          ? "contact-message-error"
                          : undefined
                      }
                      required
                      maxLength={4000}
                      rows={6}
                      className={cn(
                        "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
                        "placeholder:text-muted-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                        fieldErrors.message &&
                          "border-destructive focus-visible:ring-destructive",
                      )}
                      placeholder="Tell us about your institution, what you're trying to solve, and how we can help."
                    />
                    {fieldErrors.message ? (
                      <p
                        id="contact-message-error"
                        className="text-xs font-medium text-destructive"
                      >
                        {fieldErrors.message}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-end">
                    <Button type="submit" disabled={submitting}>
                      {submitting ? "Sending…" : "Send message"}
                    </Button>
                  </div>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
