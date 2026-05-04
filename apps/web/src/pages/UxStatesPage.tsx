// /app/ux — gallery of every UX state required by epic UNI-1 §26, in one
// place so QA can verify them without bouncing between pages. Real domain
// pages reuse the same primitives and patterns shown here.

import { Link } from "react-router-dom";
import { Inbox, Send, Sparkles, ShieldOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/use-toast";

function Demo({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{number}</Badge>
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function UxStatesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">UX states</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Reference gallery for the seven UX states from epic §26. Every page in
          University Hub should reach for these primitives.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Demo
          number={1}
          title="Loading"
          description="Skeleton placeholders while data is in-flight."
        >
          <div className="space-y-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        </Demo>

        <Demo
          number={2}
          title="Empty"
          description="Friendly nudge when the dataset is genuinely empty."
        >
          <EmptyState
            icon={Inbox}
            title="No invitations yet"
            description="Send your first invitation to populate this list."
            action={
              <Button size="sm">
                <Send className="h-4 w-4" />
                Send invitation
              </Button>
            }
          />
        </Demo>

        <Demo
          number={3}
          title="Error"
          description="Recoverable failure with a clear retry."
        >
          <ErrorState
            title="Couldn't load this section"
            description="The server returned an error. Check your connection and try again."
            action={
              <Button size="sm" variant="outline">
                Retry
              </Button>
            }
          />
        </Demo>

        <Demo
          number={4}
          title="Success toast"
          description="Confirmation of a positive side-effect."
        >
          <Button
            onClick={() =>
              toast({
                title: "Saved",
                description: "Your changes are live.",
                variant: "success",
              })
            }
          >
            <Sparkles className="h-4 w-4" />
            Show success toast
          </Button>
        </Demo>

        <Demo
          number={5}
          title="Validation errors"
          description="Inline, accessible field-level errors."
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const value = String(data.get("email") ?? "").trim();
              if (!value || !value.includes("@")) {
                toast({
                  title: "Validation failed",
                  description: "Enter a valid email address.",
                  variant: "destructive",
                });
                return;
              }
              toast({
                title: "Looks good",
                description: `Would invite ${value}.`,
                variant: "success",
              });
            }}
            className="space-y-3"
            noValidate
          >
            <div className="space-y-2">
              <Label htmlFor="ux-email">Email</Label>
              <Input
                id="ux-email"
                name="email"
                placeholder="not-an-email"
                aria-describedby="ux-email-help"
              />
              <p id="ux-email-help" className="text-xs text-muted-foreground">
                Submit with an empty or malformed value to see the error toast.
              </p>
            </div>
            <Button type="submit" size="sm">
              Validate
            </Button>
          </form>
        </Demo>

        <Demo
          number={6}
          title="Access denied"
          description="403 surface for restricted resources."
        >
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Visit the canonical access-denied page below, or trigger the
              quick-action variant on the dashboard.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/access-denied">
                <ShieldOff className="h-4 w-4" />
                Open access-denied page
              </Link>
            </Button>
          </div>
        </Demo>

        <Demo
          number={7}
          title="Not found"
          description="404 surface for unknown routes."
        >
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Any unknown <span className="font-mono">/app/*</span> path renders
              the dedicated NotFound page.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to="/app/this-page-does-not-exist">
                Trigger 404 demo
              </Link>
            </Button>
          </div>
        </Demo>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Reusable primitives</CardTitle>
          <CardDescription>
            Tables, badges, and forms share the same tokens so every page lands
            consistent.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Dev Super Admin</TableCell>
                <TableCell>Super Admin</TableCell>
                <TableCell>
                  <Badge variant="success">Active</Badge>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Dev Teacher</TableCell>
                <TableCell>Teacher</TableCell>
                <TableCell>
                  <Badge variant="success">Active</Badge>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Dev Student</TableCell>
                <TableCell>Student</TableCell>
                <TableCell>
                  <Badge variant="warning">Pending</Badge>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
