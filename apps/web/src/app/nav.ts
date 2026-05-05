// Role-aware navigation manifest. Frontend convenience only — the Worker
// enforces RBAC on every protected endpoint (epic UNI-1 §11). Items list
// the roles that may *see* the link; backend authorization is the source of
// truth for what those roles may actually do.
//
// Each role lands on its own default dashboard via /app (see
// `lib/default-dashboard.ts` and `pages/DefaultDashboardRedirect`); the
// Overview section's Dashboard link points to that role's home, while the
// "My workspace" section adds role-specific sub-pages.

import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Building2,
  ClipboardList,
  GraduationCap,
  LayoutDashboard,
  LifeBuoy,
  Link2,
  Mail,
  Send,
  Settings,
  Users,
  UserSquare2,
} from "lucide-react";

import { ROLES, type Role } from "@university-hub/shared";

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

const SYSTEM_DASHBOARD_ROLES: readonly Role[] = [
  "super_admin",
  "university_admin",
  "staff",
  "faculty",
  "viewer",
];

const ADMIN_ONLY: readonly Role[] = ["super_admin", "university_admin"];

// Roles that see the Students / Teacher-Assistants directories. Faculty and
// teachers need these to find people in courses they teach (the backend
// scopes those lists to the actor's course assignments).
const DIRECTORY_VIEWERS: readonly Role[] = [
  "super_admin",
  "university_admin",
  "staff",
  "faculty",
  "teacher",
  "teacher_assistant",
];

// The Faculty and Teachers directories are admin/ops surfaces — they list
// peers by university, which faculty/teachers/TAs don't need (and shouldn't
// be browsing as a directory of co-workers). Keep them visible only to the
// roles that actually administer staffing.
const PEER_DIRECTORY_VIEWERS: readonly Role[] = [
  "super_admin",
  "university_admin",
  "staff",
];

// Departments / courses are visible to anyone academic. Editing is gated
// server-side; the listing itself is read-only for non-admins.
const ACADEMIC_BROWSE: readonly Role[] = [
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
        roles: SYSTEM_DASHBOARD_ROLES,
      },
      {
        label: "Dashboard",
        to: "/app/teacher/dashboard",
        icon: LayoutDashboard,
        roles: ["teacher"],
      },
      {
        label: "Dashboard",
        to: "/app/teacher-assistant/dashboard",
        icon: LayoutDashboard,
        roles: ["teacher_assistant"],
      },
      {
        label: "Dashboard",
        to: "/app/student/dashboard",
        icon: LayoutDashboard,
        roles: ["student"],
      },
      {
        label: "Dashboard",
        to: "/app/guest/dashboard",
        icon: LayoutDashboard,
        roles: ["guest"],
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
        roles: ACADEMIC_BROWSE,
      },
      {
        label: "Courses",
        to: "/app/courses",
        icon: BookOpen,
        roles: ACADEMIC_BROWSE,
      },
    ],
  },
  {
    label: "Directories",
    items: [
      {
        label: "Students",
        to: "/app/students",
        icon: GraduationCap,
        roles: DIRECTORY_VIEWERS,
      },
      {
        label: "Faculty",
        to: "/app/faculty",
        icon: UserSquare2,
        roles: PEER_DIRECTORY_VIEWERS,
      },
      {
        label: "Teachers",
        to: "/app/teachers",
        icon: UserSquare2,
        roles: PEER_DIRECTORY_VIEWERS,
      },
      {
        label: "Teacher assistants",
        to: "/app/teacher-assistants",
        icon: LifeBuoy,
        roles: DIRECTORY_VIEWERS,
      },
    ],
  },
  {
    label: "My workspace",
    items: [
      {
        label: "My courses",
        to: "/app/teacher/courses",
        icon: BookOpen,
        roles: ["teacher"],
      },
      {
        label: "My students",
        to: "/app/teacher/students",
        icon: GraduationCap,
        roles: ["teacher"],
      },
      {
        label: "My courses",
        to: "/app/teacher-assistant/courses",
        icon: BookOpen,
        roles: ["teacher_assistant"],
      },
      {
        label: "My courses",
        to: "/app/student/my-courses",
        icon: BookOpen,
        roles: ["student"],
      },
      {
        label: "My grades",
        to: "/app/student/my-grades",
        icon: ClipboardList,
        roles: ["student"],
      },
      {
        label: "My profile",
        to: "/app/student/my-profile",
        icon: UserSquare2,
        roles: ["student"],
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
        label: "Grade access log",
        to: "/app/audit-logs/grade-access",
        icon: ClipboardList,
        roles: ADMIN_ONLY,
      },
      {
        label: "Disclosures",
        to: "/app/disclosures",
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
        // LMS integrations (UNI-54). Any authenticated user role can land
        // on the page — admins see the full list of providers their
        // university has enabled; other roles see whatever providers they
        // already have a connection for. Access control on the underlying
        // endpoints is enforced server-side.
        label: "Integrations",
        to: "/app/integrations",
        icon: Link2,
        roles: ROLES,
      },
      {
        // Account settings are always available to the signed-in user; the
        // page itself gates the university + Mailgun sections by role.
        label: "Settings",
        to: "/app/settings",
        icon: Settings,
        roles: ROLES,
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
