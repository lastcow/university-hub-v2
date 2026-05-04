import type { Role } from "../types/role.js";

export const ROLES = [
  "super_admin",
  "university_admin",
  "staff",
  "faculty",
  "teacher",
  "teacher_assistant",
  "student",
  "guest",
  "viewer",
] as const;

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: "Super Admin",
  university_admin: "University Admin",
  staff: "Staff",
  faculty: "Faculty",
  teacher: "Teacher",
  teacher_assistant: "Teacher Assistant",
  student: "Student",
  guest: "Guest",
  viewer: "Viewer",
};

export const ROLE_GROUPS = {
  admin: ["super_admin", "university_admin"],
  operations: ["staff", "viewer"],
  academic: ["faculty", "teacher", "teacher_assistant"],
  learner: ["student"],
  external: ["guest"],
} as const satisfies Record<string, readonly Role[]>;

export type RoleGroup = keyof typeof ROLE_GROUPS;
