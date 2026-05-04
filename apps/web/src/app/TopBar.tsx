import { Menu, Moon, Sun } from "lucide-react";

import type { SessionUser } from "@university-hub/shared";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/use-theme";

import { Breadcrumbs } from "./Breadcrumbs";
import { UserMenu } from "./UserMenu";

interface TopBarProps {
  user: SessionUser;
  onOpenMobileNav: () => void;
}

export function TopBar({ user, onOpenMobileNav }: TopBarProps) {
  const [theme, toggleTheme] = useTheme();

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <div className="hidden flex-1 lg:block">
        <Breadcrumbs />
      </div>
      <div className="flex flex-1 lg:hidden">
        <span className="text-sm font-semibold">University Hub</span>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="hidden sm:inline-flex"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
        <UserMenu user={user} />
      </div>
    </header>
  );
}
