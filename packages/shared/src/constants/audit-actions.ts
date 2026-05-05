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
  "assessment.created",
  "assessment.updated",
  "assessment.deleted",
  "grade.created",
  "grade.changed",
  "analytics.viewed",
  "directory_info.updated",
  "disclosure_consent.granted",
  "disclosure_consent.revoked",
  "disclosure.released",
  "parent.sign_in_requested",
  "parent.sign_in_verified",
  "parent.sign_out",
  "email.sent",
  "email.failed",
  "settings.updated",
  "mfa.enrolled",
  "mfa.challenge_passed",
  "mfa.challenge_failed",
  "mfa.disabled",
  "mfa.recovery_code_used",
  "mfa.recovery_codes_regenerated",
  "mfa.trusted_device_granted",
  "mfa.trusted_device_revoked",
  "mfa.bypassed_via_trusted_device",
  "mfa.bypassed_via_revalidation_window",
  "mfa.device_seen",
  "legal.terms_accepted",
  "legal.document_updated",
  "escalation.contact_updated",
  "lms.provider_config.updated",
  "lms.provider_config.removed",
  "lms.connected",
  "lms.disconnected",
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
  "assessment.created": "Assessment created",
  "assessment.updated": "Assessment updated",
  "assessment.deleted": "Assessment deleted",
  "grade.created": "Grade recorded",
  "grade.changed": "Grade changed",
  "analytics.viewed": "Course analytics viewed",
  "directory_info.updated": "Directory-info opt-out updated",
  "disclosure_consent.granted": "Disclosure consent granted",
  "disclosure_consent.revoked": "Disclosure consent revoked",
  "disclosure.released": "Disclosure released",
  "parent.sign_in_requested": "Parent sign-in token requested",
  "parent.sign_in_verified": "Parent sign-in verified",
  "parent.sign_out": "Parent sign-out",
  "email.sent": "Email sent",
  "email.failed": "Email failed",
  "settings.updated": "Settings updated",
  "mfa.enrolled": "MFA enrolled",
  "mfa.challenge_passed": "MFA challenge passed",
  "mfa.challenge_failed": "MFA challenge failed",
  "mfa.disabled": "MFA disabled",
  "mfa.recovery_code_used": "MFA recovery code used",
  "mfa.recovery_codes_regenerated": "MFA recovery codes regenerated",
  "mfa.trusted_device_granted": "Trusted device granted",
  "mfa.trusted_device_revoked": "Trusted device revoked",
  "mfa.bypassed_via_trusted_device": "MFA bypassed via trusted device",
  "mfa.bypassed_via_revalidation_window": "MFA bypassed (recent challenge on this device)",
  "mfa.device_seen": "Device fingerprint recorded",
  "legal.terms_accepted": "Terms accepted",
  "legal.document_updated": "Legal document updated",
  "escalation.contact_updated": "Escalation contact updated",
  "lms.provider_config.updated": "LMS provider configured",
  "lms.provider_config.removed": "LMS provider removed",
  "lms.connected": "LMS account connected",
  "lms.disconnected": "LMS account disconnected",
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
  | "assessment"
  | "grade"
  | "analytics"
  | "email"
  | "settings"
  | "mfa"
  | "directory_info"
  | "disclosure_consent"
  | "disclosure"
  | "parent"
  | "legal"
  | "escalation"
  | "lms";

export function auditActionCategory(action: AuditAction): AuditActionCategory {
  return action.split(".")[0] as AuditActionCategory;
}
