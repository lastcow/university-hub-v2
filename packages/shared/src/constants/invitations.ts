import type { Role } from "../types/role.js";
import { ROLE_GROUPS, type RoleGroup } from "./roles.js";

/** Default invitation TTL — 7 days from creation. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Roles a given actor may invite (epic UNI-1 §11, §27). Backend authoritative;
 * the frontend uses the same helper to grey out roles the actor can't invite.
 *
 * Rules:
 * - super_admin can invite any role.
 * - university_admin can invite anyone *into their own university* — but never
 *   another super_admin (privilege escalation).
 * - everyone else cannot invite.
 */
export function rolesInvitableBy(actorRole: Role): readonly Role[] {
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
    return [
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
  return [];
}

export function canInvite(actorRole: Role): boolean {
  return rolesInvitableBy(actorRole).length > 0;
}

/**
 * Group invitable roles by the §27 selector groupings. Empty groups are
 * dropped so the UI doesn't render headings with no options.
 */
export function invitableRoleGroups(
  actorRole: Role,
): ReadonlyArray<{ group: RoleGroup; roles: readonly Role[] }> {
  const allowed = new Set(rolesInvitableBy(actorRole));
  const out: Array<{ group: RoleGroup; roles: readonly Role[] }> = [];
  for (const group of Object.keys(ROLE_GROUPS) as RoleGroup[]) {
    const roles = ROLE_GROUPS[group].filter((r) => allowed.has(r));
    if (roles.length > 0) out.push({ group, roles });
  }
  return out;
}

export const INVITATION_ROLE_GROUP_LABELS: Record<RoleGroup, string> = {
  admin: "Admin",
  operations: "Operations",
  academic: "Academic",
  learner: "Learner",
  external: "External",
};
