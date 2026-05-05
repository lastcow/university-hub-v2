// Single source of truth for "does this role have to do MFA?".
//
// UNI-24 originally scoped mandatory MFA to `super_admin` and
// `university_admin`. UNI-49 generalizes that: every authenticated role
// must enroll in TOTP on first sign-in.
//
// Roles split into two posture buckets:
//
//   - alwaysChallenge  → MFA challenge on every sign-in (admins).
//   - riskBased        → MFA challenge only when the request comes from
//                        a previously-unseen device fingerprint OR the
//                        most recent successful MFA on that fingerprint
//                        is older than `mfa_revalidation_days`.
//
// Anonymous-session callers (parents on the FERPA surface) don't have a
// `users` row so they don't go through this gate at all.

import type { Role } from "@university-hub/shared";

const ALWAYS_CHALLENGE_ROLES = new Set<Role>([
  "super_admin",
  "university_admin",
]);

/**
 * Every authenticated role is required to enroll in MFA. This drives the
 * "force enrollment on first sign-in" gate in routes/auth.ts.
 *
 * Kept as a function (rather than `true`) so it stays readable at
 * call-sites and so future per-deployment policy (e.g. an anonymous
 * `viewer` role exempted on a given customer) can land here without
 * touching every caller.
 */
export function roleRequiresMfa(_role: Role): boolean {
  return true;
}

/**
 * `true` for roles that re-challenge on every sign-in regardless of the
 * device fingerprint (UNI-49 stricter posture for admins). The risk-
 * based gate does not apply.
 */
export function roleAlwaysChallenges(role: Role): boolean {
  return ALWAYS_CHALLENGE_ROLES.has(role);
}

/**
 * `true` for roles that go through the risk-based gate: MFA only when
 * the device fingerprint is unseen or the MFA window has expired.
 */
export function roleUsesRiskBasedMfa(role: Role): boolean {
  return roleRequiresMfa(role) && !roleAlwaysChallenges(role);
}
