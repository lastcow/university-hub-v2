import type { AuditAction } from "../types/audit-log.js";

export const AUDIT_ACTIONS = [
  "auth.sign_in",
  "auth.sign_out",
  "auth.rate_limited",
  "session.revoked",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "invitation.resent",
  "invitation.email_failed",
  "user.created",
  "user.updated",
  "user.role_changed",
  "user.status_changed",
  "university.created",
  "university.updated",
  "department.created",
  "department.updated",
  "department.deleted",
  "course.created",
  "course.updated",
  "course.deleted",
  "email.sent",
  "email.failed",
  "settings.updated",
  "mfa.enrolled",
  "mfa.challenge_passed",
  "mfa.challenge_failed",
  "mfa.disabled",
  "mfa.recovery_code_used",
  "mfa.recovery_codes_regenerated",
] as const;

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  "auth.sign_in": "Sign in",
  "auth.sign_out": "Sign out",
  "auth.rate_limited": "Sign-in rate limited",
  "session.revoked": "Session revoked",
  "invitation.created": "Invitation created",
  "invitation.accepted": "Invitation accepted",
  "invitation.revoked": "Invitation revoked",
  "invitation.resent": "Invitation resent",
  "invitation.email_failed": "Invitation email failed",
  "user.created": "User created",
  "user.updated": "User updated",
  "user.role_changed": "User role changed",
  "user.status_changed": "User status changed",
  "university.created": "University created",
  "university.updated": "University updated",
  "department.created": "Department created",
  "department.updated": "Department updated",
  "department.deleted": "Department deleted",
  "course.created": "Course created",
  "course.updated": "Course updated",
  "course.deleted": "Course deleted",
  "email.sent": "Email sent",
  "email.failed": "Email failed",
  "settings.updated": "Settings updated",
  "mfa.enrolled": "MFA enrolled",
  "mfa.challenge_passed": "MFA challenge passed",
  "mfa.challenge_failed": "MFA challenge failed",
  "mfa.disabled": "MFA disabled",
  "mfa.recovery_code_used": "MFA recovery code used",
  "mfa.recovery_codes_regenerated": "MFA recovery codes regenerated",
};

/**
 * Domain prefix → category. Used by the audit-logs UI to colour-code badges
 * (auth/invitation/user/etc.) without needing one variant per individual
 * action.
 */
export type AuditActionCategory =
  | "auth"
  | "session"
  | "invitation"
  | "user"
  | "university"
  | "department"
  | "course"
  | "email"
  | "settings"
  | "mfa";

export function auditActionCategory(action: AuditAction): AuditActionCategory {
  return action.split(".")[0] as AuditActionCategory;
}
