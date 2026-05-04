import { GraduationCap } from "lucide-react";
import { NavLink } from "react-router-dom";

import type { Role } from "@university-hub/shared";

import { cn } from "@/lib/utils";

import { visibleSections } from "./nav";

interface SidebarProps {
  role: Role;
  onNavigate?: () => void;
}

export function Sidebar({ role, onNavigate }: SidebarProps) {
  const sections = visibleSections(role);

  return (
    <aside className="flex h-full w-full flex-col bg-card text-card-foreground">
      <div className="flex h-16 items-center gap-2 border-b px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <GraduationCap className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold">University Hub</span>
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Admin
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-5">
          {sections.map((section) => (
            <li key={section.label}>
              <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {section.label}
              </p>
              <ul className="flex flex-col gap-1">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        end
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          cn(
                            "group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                            isActive
                              ? "bg-primary text-primary-foreground"
                              : "text-foreground/80 hover:bg-accent hover:text-accent-foreground",
                          )
                        }
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t px-5 py-3 text-[11px] text-muted-foreground">
        University Hub v2 · {new Date().getFullYear()}
      </div>
    </aside>
  );
}
