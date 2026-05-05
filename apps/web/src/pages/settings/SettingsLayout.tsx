// Two-pane Settings layout (UNI-58 §A): in-page side nav on the left,
// section content on the right via <Outlet />. Each section gets its own
// URL — e.g. /app/settings/account, /app/settings/security — so deep
// links work and the back button feels right. On viewports below `md`
// the side nav collapses to a top dropdown so the content has the full
// width. Role-gated sections are filtered here, then enforced again at
// the route component (`RequireRole`) so a deep-link by a role that
// shouldn't see the section doesn't crash with an auth error.

import { useMemo, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  ChevronDown,
  FileText,
  Link2,
  Lock,
  Mail,
  Settings as SettingsIcon,
  ShieldCheck,
  University as UniversityIcon,
  UserCircle,
  type LucideIcon,
} from "lucide-react";

import type { Role } from "@university-hub/shared";

import { useAuth } from "@/auth/AuthContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface SettingsSection {
  /** URL slug appended to /app/settings/. */
  slug: string;
  label: string;
  /** Short description shown in the side nav tooltip / mobile dropdown. */
  description?: string;
  icon: LucideIcon;
  /** Roles that may access the section. Empty / undefined = all roles. */
  roles?: readonly Role[];
}

const ADMIN: readonly Role[] = ["super_admin", "university_admin"];
const SUPER_ADMIN_ONLY: readonly Role[] = ["super_admin"];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    slug: "account",
    label: "Account",
    description: "Display name, password, FERPA links",
    icon: UserCircle,
  },
  {
    slug: "security",
    label: "Security & sessions",
    description: "MFA, active sessions, trusted devices",
    icon: Lock,
  },
  {
    slug: "university",
    label: "University",
    description: "Edit the deploy's university record",
    icon: UniversityIcon,
    roles: ADMIN,
  },
  {
    slug: "integrations",
    label: "Integrations",
    description: "Canvas LMS connection",
    icon: Link2,
  },
  {
    slug: "legal",
    label: "Legal",
    description: "Privacy policy & terms",
    icon: FileText,
    roles: ADMIN,
  },
  {
    slug: "system",
    label: "System",
    description: "Trust window & escalation contacts",
    icon: ShieldCheck,
    roles: SUPER_ADMIN_ONLY,
  },
  {
    slug: "mailgun",
    label: "Mailgun",
    description: "Email delivery configuration",
    icon: Mail,
    roles: SUPER_ADMIN_ONLY,
  },
];

export function visibleSettingsSections(role: Role): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(
    (s) => !s.roles || s.roles.includes(role),
  );
}

export function SettingsLayout(): ReactNode {
  const { user } = useAuth();
  const location = useLocation();

  const sections = useMemo(
    () => (user ? visibleSettingsSections(user.role) : []),
    [user?.role],
  );

  const activeSection = sections.find((s) =>
    location.pathname.startsWith(`/app/settings/${s.slug}`),
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <SettingsIcon className="h-6 w-6 text-muted-foreground" />
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account, security, and the platform configuration.
        </p>
      </div>

      <div className="md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-left text-sm font-medium shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Choose a settings section"
            >
              <span className="flex items-center gap-2">
                {activeSection ? (
                  <activeSection.icon className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <SettingsIcon className="h-4 w-4 text-muted-foreground" />
                )}
                <span>{activeSection?.label ?? "Settings"}</span>
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[220px]">
            {sections.map((section) => (
              <DropdownMenuItem key={section.slug} asChild>
                <NavLink
                  to={`/app/settings/${section.slug}`}
                  className={({ isActive }) =>
                    cn(
                      "flex w-full cursor-pointer items-center gap-2",
                      isActive ? "font-semibold" : "",
                    )
                  }
                >
                  <section.icon className="h-4 w-4 text-muted-foreground" />
                  <span>{section.label}</span>
                </NavLink>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid gap-6 md:grid-cols-[14rem_1fr] lg:grid-cols-[16rem_1fr]">
        <nav
          aria-label="Settings sections"
          className="hidden md:block"
        >
          <ul className="sticky top-6 flex flex-col gap-1">
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <li key={section.slug}>
                  <NavLink
                    to={`/app/settings/${section.slug}`}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isActive
                          ? "bg-primary text-primary-foreground"
                          : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                      )
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{section.label}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
