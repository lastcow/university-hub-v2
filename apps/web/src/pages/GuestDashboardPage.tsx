// /app/guest/dashboard — limited dashboard for invited guests
// (epic UNI-1 §9, UNI-13). Backend enforces strict access — guests cannot read
// the directories or any management API.

import { LifeBuoy } from "lucide-react";

import { useAuth } from "@/auth/AuthContext";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";

export function GuestDashboardPage() {
  const { user } = useAuth();
  if (user?.role !== "guest") {
    return (
      <ErrorState
        title="Guests only"
        description="This dashboard is only available to guest accounts."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome, {user.name.split(" ")[0]}.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You have read-only guest access. Most workspace data isn't visible to
          guest accounts — your university admin will share resources with you
          here as they're published.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Shared resources</CardTitle>
          <CardDescription>
            Anything an admin shares with guests will appear in this section.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={LifeBuoy}
            title="Nothing to show yet"
            description="When your administrator publishes a guest-visible resource, it'll appear here."
          />
        </CardContent>
      </Card>
    </div>
  );
}
