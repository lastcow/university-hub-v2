import { Frown } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Frown className="h-6 w-6" />
      </div>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        404 — Not found
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">
        We couldn't find that page
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The page you were looking for doesn't exist, or it hasn't shipped yet.
        Real domain pages land in later issues.
      </p>
      <Button asChild className="mt-2">
        <Link to="/app/dashboard">Back to dashboard</Link>
      </Button>
    </div>
  );
}
