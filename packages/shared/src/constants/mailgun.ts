export const MAILGUN_TEMPLATES = {
  invitation: "university_hub_invitation",
  invitation_resend: "university_hub_invitation_resend",
  welcome: "university_hub_welcome",
  password_reset: "university_hub_password_reset",
  contact_notification: "university_hub_contact_notification",
  account_status_changed: "university_hub_account_status_changed",
} as const;

export type MailgunTemplateKey = keyof typeof MAILGUN_TEMPLATES;
