// Single source of truth for "does this role have to do MFA?".
//
// Per UNI-24: TOTP MFA is mandatory for `super_admin` and `university_admin`.
// Other roles may optionally enroll later (out of scope for this issue).

import type { Role } from "@university-hub/shared";

const MFA_REQUIRED_ROLES = new Set<Role>(["super_admin", "university_admin"]);

export function roleRequiresMfa(role: Role): boolean {
  return MFA_REQUIRED_ROLES.has(role);
}
