export const USER_STATUSES = [
  "active",
  "inactive",
  "suspended",
  "pending",
] as const;

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "expired",
  "revoked",
] as const;

export const UNIVERSITY_STATUSES = [
  "active",
  "inactive",
  "archived",
] as const;

export const COURSE_STATUSES = ["active", "inactive", "archived"] as const;

export const CONTACT_MESSAGE_STATUSES = [
  "new",
  "reviewed",
  "archived",
] as const;

export const EMAIL_LOG_STATUSES = ["sent", "failed", "pending"] as const;

export const COURSE_ASSIGNMENT_ROLES = [
  "faculty",
  "teacher",
  "teacher_assistant",
  "student",
  "viewer",
] as const;

export const EMAIL_TYPES = [
  "invitation",
  "invitation_resend",
  "welcome",
  "password_reset",
  "contact_notification",
  "account_status_changed",
] as const;
