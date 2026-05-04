// Directory-access RBAC helpers (epic UNI-1 §11, §17).
//
// The academic directories — students, faculty, teachers, teacher_assistants —
// are read-only listings scoped to a single university. Per spec §17 they are
// readable by staff and the academic roles inside that university. Students,
// guests, and viewers cannot list the directories; students can still see
// their own profile via the role-specific dashboards (`/api/students/me`,
// `/app/student/my-profile`), which uses session identity rather than the
// directory permissions.

import type { Role } from "../types/role.js";

/** Roles allowed to *list* and *read by id* the academic directories. */
export const DIRECTORY_VIEWER_ROLES: readonly Role[] = [
  "super_admin",
  "university_admin",
  "staff",
  "faculty",
  "teacher",
  "teacher_assistant",
];

export function canViewDirectory(role: Role): boolean {
  return DIRECTORY_VIEWER_ROLES.includes(role);
}
