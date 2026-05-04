import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/AuthContext";

export function DashboardPlaceholder() {
  const { user, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <span className="text-sm font-semibold tracking-tight">
            University Hub
          </span>
          <div className="flex items-center gap-3 text-sm">
            {user ? (
              <span className="text-muted-foreground">
                {user.name} · {user.role}
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void signOut();
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="container flex flex-col items-start gap-3 py-16">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="max-w-prose text-muted-foreground">
          Signed in. The full dashboard layout lands in the next issue.
        </p>
      </main>
    </div>
  );
}
