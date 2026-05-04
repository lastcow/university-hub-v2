import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";

import { useAuth } from "@/auth/AuthContext";
import { Sheet, SheetContent } from "@/components/ui/sheet";

import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell() {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // ProtectedRoute guards this layer, but the type is `SessionUser | null`
  // until the context resolves. After the guard, `user` is always present.
  if (!user) return null;

  return (
    <div className="flex min-h-screen bg-muted/40 text-foreground">
      <aside className="hidden w-64 shrink-0 border-r lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar role={user.role} />
        </div>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <Sidebar role={user.role} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar user={user} onOpenMobileNav={() => setMobileOpen(true)} />
        <main
          key={location.pathname}
          className="flex-1 px-4 py-6 lg:px-8 lg:py-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
