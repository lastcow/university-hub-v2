// Role-aware navigation manifest. Frontend convenience only — the Worker
// enforces RBAC on every protected endpoint (epic UNI-1 §11). Items list
// the roles that may *see* the link; backend authorization is the source of
// truth for what those roles may actually do.
//
// Real domain pages (`/app/universities`, `/app/users`, etc.) land in
// UNI-11+; for now most items point to placeholder routes inside the shell
// so the nav reflects the eventual IA. Each item also flags a route the
// dashboard knows is "not implemented yet" so unknown routes render the
// not-found UX state instead of bouncing back to /app/dashboard.

import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Building2,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  Send,
  Settings,
  Users,
  UserSquare2,
} from "lucide-react";

import type { Role } from "@university-hub/shared";

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  roles: readonly Role[];
}

export interface NavSection {
  label: string;
  items: readonly NavItem[];
}

const ALL_STAFF: readonly Role[] = [
  "super_admin",
  "university_admin",
  "staff",
  "faculty",
  "teacher",
  "teacher_assistant",
  "viewer",
];

const ADMIN_ONLY: readonly Role[] = ["super_admin", "university_admin"];

const ACADEMIC: readonly Role[] = [
  "super_admin",
  "university_admin",
  "staff",
  "faculty",
  "teacher",
  "teacher_assistant",
];

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: "Overview",
    items: [
      {
        label: "Dashboard",
        to: "/app/dashboard",
        icon: LayoutDashboard,
        roles: [
          "super_admin",
          "university_admin",
          "staff",
          "faculty",
          "teacher",
          "teacher_assistant",
          "student",
          "guest",
          "viewer",
        ],
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        label: "Universities",
        to: "/app/universities",
        icon: Building2,
        roles: ["super_admin"],
      },
      {
        label: "Users",
        to: "/app/users",
        icon: Users,
        roles: ADMIN_ONLY,
      },
      {
        label: "Invitations",
        to: "/app/invitations",
        icon: Send,
        roles: ADMIN_ONLY,
      },
    ],
  },
  {
    label: "Academic",
    items: [
      {
        label: "Departments",
        to: "/app/departments",
        icon: ClipboardList,
        roles: ACADEMIC,
      },
      {
        label: "Courses",
        to: "/app/courses",
        icon: BookOpen,
        roles: ACADEMIC,
      },
      {
        label: "Students",
        to: "/app/students",
        icon: GraduationCap,
        roles: ALL_STAFF,
      },
      {
        label: "Faculty",
        to: "/app/faculty",
        icon: UserSquare2,
        roles: ACADEMIC,
      },
    ],
  },
  {
    label: "My Workspace",
    items: [
      {
        label: "My courses",
        to: "/app/student/my-courses",
        icon: BookOpen,
        roles: ["student"],
      },
      {
        label: "My profile",
        to: "/app/student/my-profile",
        icon: UserSquare2,
        roles: ["student"],
      },
      {
        label: "Teacher dashboard",
        to: "/app/teacher/dashboard",
        icon: LayoutDashboard,
        roles: ["teacher"],
      },
      {
        label: "TA dashboard",
        to: "/app/teacher-assistant/dashboard",
        icon: LayoutDashboard,
        roles: ["teacher_assistant"],
      },
      {
        label: "Guest dashboard",
        to: "/app/guest/dashboard",
        icon: LifeBuoy,
        roles: ["guest"],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Audit logs",
        to: "/app/audit-logs",
        icon: ClipboardList,
        roles: ADMIN_ONLY,
      },
      {
        label: "Email logs",
        to: "/app/email-logs",
        icon: Mail,
        roles: ADMIN_ONLY,
      },
      {
        label: "Settings",
        to: "/app/settings",
        icon: Settings,
        roles: ADMIN_ONLY,
      },
    ],
  },
];

export function visibleSections(role: Role): NavSection[] {
  return NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.roles.includes(role)),
    }))
    .filter((section) => section.items.length > 0);
}
