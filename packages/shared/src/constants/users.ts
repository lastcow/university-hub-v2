// User-management RBAC helpers (epic UNI-1 §10, §11, §28).
//
// These power both the Worker (authoritative) and the admin UI (affordances).
// Rules:
//   - super_admin can manage any user and assign any role / status.
//   - university_admin can manage users within their own university, but:
//       * may NOT manage a super_admin,
//       * may NOT manage another university_admin (sibling escalation),
//       * may NOT promote anyone to super_admin (privilege escalation),
//       * may NOT promote anyone to university_admin (peer escalation).
//   - everyone else cannot manage users.

import type { Role } from "../types/role.js";

/** Roles a manager may *assign* on `PATCH /api/users/:id/role`. */
export function rolesAssignableBy(actorRole: Role): readonly Role[] {
  if (actorRole === "super_admin") {
    return [
      "super_admin",
      "university_admin",
      "staff",
      "faculty",
      "teacher",
      "teacher_assistant",
      "student",
      "guest",
      "viewer",
    ];
  }
  if (actorRole === "university_admin") {
    // university_admin can move users within their university across non-admin
    // roles. They cannot create new admins of any kind.
    return [
      "staff",
      "faculty",
      "teacher",
      "teacher_assistant",
      "student",
      "guest",
      "viewer",
    ];
  }
  return [];
}

export function canManageUsers(actorRole: Role): boolean {
  return actorRole === "super_admin" || actorRole === "university_admin";
}

/**
 * Whether the actor may modify the target user at all (profile / status / role).
 * University scoping is applied separately by the route handler.
 */
export function canManageTargetUser(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "super_admin") return true;
  if (actorRole === "university_admin") {
    return targetRole !== "super_admin" && targetRole !== "university_admin";
  }
  return false;
}

/**
 * Whether the actor may assign `newRole` to a user. Combine with
 * `canManageTargetUser` to also enforce that the *current* role is in scope.
 */
export function canAssignRole(actorRole: Role, newRole: Role): boolean {
  return rolesAssignableBy(actorRole).includes(newRole);
}
