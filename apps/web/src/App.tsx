import { useState } from "react";
import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HealthCheck } from "@/components/HealthCheck";
import { getStoredTheme, toggleTheme, type Theme } from "@/lib/theme";

export default function App() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme());

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <span className="text-sm font-semibold tracking-tight">
            University Hub
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={() => setTheme((t) => toggleTheme(t))}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      <main className="container flex flex-col items-start gap-6 py-16">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            University Hub v2
          </h1>
          <p className="max-w-prose text-muted-foreground">
            Toolchain placeholder. Real pages, auth, and dashboard land in later
            issues.
          </p>
        </div>
        <Button>shadcn Button works</Button>
        <HealthCheck />
      </main>
    </div>
  );
}
