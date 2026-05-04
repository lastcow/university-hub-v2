import { ShieldOff } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function AccessDeniedPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <ShieldOff className="h-6 w-6" />
      </div>
      <p className="text-xs font-semibold uppercase tracking-wider text-destructive">
        403 — Access denied
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">
        You don't have permission to view this page
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Frontend hides nav items by role, but the backend always enforces
        access. If you think this is a mistake, contact a university admin.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/app/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
