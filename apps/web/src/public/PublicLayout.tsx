// Slim public top nav + footer that wraps all marketing routes (`/`,
// `/features`, `/about`, `/contact`). Distinct from the protected `AppShell`
// (no sidebar, no role context) but uses the exact same Tailwind/shadcn
// design tokens so visually they read as one product.

import { useEffect, useState } from "react";
import { Menu } from "lucide-react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { PublicFooter } from "./PublicFooter";
import { PUBLIC_NAV } from "./nav";

export function PublicLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { status } = useAuth();
  const isAuthed = status === "authenticated";

  // Close the mobile drawer on route change.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 lg:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <span
              aria-hidden
              className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
            >
              U
            </span>
            University Hub
          </Link>

          <nav
            aria-label="Primary"
            className="ml-6 hidden items-center gap-1 md:flex"
          >
            {PUBLIC_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden items-center gap-2 md:flex">
              {isAuthed ? (
                <Button asChild size="sm">
                  <Link to="/app/dashboard">Open dashboard</Link>
                </Button>
              ) : (
                <>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/sign-in">Sign in</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link to="/accept-invitation">Accept invitation</Link>
                  </Button>
                </>
              )}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="right" className="w-72">
          <div className="mt-6 flex flex-col gap-1">
            {PUBLIC_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
            <div className="mt-4 flex flex-col gap-2 border-t pt-4">
              {isAuthed ? (
                <Button asChild>
                  <Link to="/app/dashboard">Open dashboard</Link>
                </Button>
              ) : (
                <>
                  <Button asChild variant="outline">
                    <Link to="/sign-in">Sign in</Link>
                  </Button>
                  <Button asChild>
                    <Link to="/accept-invitation">Accept invitation</Link>
                  </Button>
                </>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <main key={location.pathname} className="flex-1">
        <Outlet />
      </main>

      <PublicFooter />
    </div>
  );
}
