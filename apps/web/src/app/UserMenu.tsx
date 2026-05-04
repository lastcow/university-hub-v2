import { useNavigate } from "react-router-dom";
import { LogOut, Moon, Settings, Sun, User as UserIcon } from "lucide-react";

import type { SessionUser } from "@university-hub/shared";
import { ROLE_LABELS } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/use-toast";
import { useTheme } from "@/lib/use-theme";

function initialsFor(user: SessionUser): string {
  const parts = user.name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return user.email.slice(0, 2).toUpperCase();
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
}

export function UserMenu({ user }: { user: SessionUser }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();

  async function handleSignOut() {
    try {
      await signOut();
      toast({
        title: "Signed out",
        description: "You have been signed out of University Hub.",
        variant: "success",
      });
    } catch {
      toast({
        title: "Sign out failed",
        description: "Could not contact the server. Please try again.",
        variant: "destructive",
      });
    } finally {
      navigate("/sign-in", { replace: true });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="flex h-10 items-center gap-2 px-2 text-sm font-normal hover:bg-accent"
          aria-label="Open user menu"
        >
          <Avatar>
            <AvatarFallback>{initialsFor(user)}</AvatarFallback>
          </Avatar>
          <div className="hidden flex-col items-start text-left leading-tight sm:flex">
            <span className="text-sm font-medium">{user.name}</span>
            <span className="text-xs text-muted-foreground">
              {ROLE_LABELS[user.role]}
            </span>
          </div>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">{user.name}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {user.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            toggleTheme();
          }}
          className="cursor-pointer"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            navigate("/app/settings");
          }}
          className="cursor-pointer"
        >
          <UserIcon className="h-4 w-4" />
          <span>Profile</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            navigate("/app/settings");
          }}
          className="cursor-pointer"
        >
          <Settings className="h-4 w-4" />
          <span>Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
