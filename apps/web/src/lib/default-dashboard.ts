// Per-role default landing route after sign-in (epic UNI-1 §9, UNI-13).
//
// Each role has its own home: teachers/TAs/students/guests land on their own
// dashboards; admins/staff/faculty/viewer share the system dashboard. The
// SignInPage and the index `/app` route both consult this so a deep-linked
// `?from=` is preferred but the fallback respects the role.

import type { Role } from "@university-hub/shared";

export function defaultDashboardForRole(role: Role): string {
  switch (role) {
    case "teacher":
      return "/app/teacher/dashboard";
    case "teacher_assistant":
      return "/app/teacher-assistant/dashboard";
    case "student":
      return "/app/student/dashboard";
    case "guest":
      return "/app/guest/dashboard";
    default:
      // super_admin, university_admin, staff, faculty, viewer all share
      // the system overview dashboard.
      return "/app/dashboard";
  }
}
