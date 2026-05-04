// Settings page (epic UNI-1 §9 #13, §17, §29). The Mailgun status endpoint
// returns ONLY status strings per variable — never the secret value itself —
// plus the `MAILGUN_REGION` plain value if configured (region is not a
// secret). Anything else here is summary metadata safe for the settings UI.

export type MailgunVarStatus = "Configured" | "Missing configuration";

export type MailgunVarKey =
  | "MAILGUN_API_KEY"
  | "MAILGUN_DOMAIN"
  | "MAILGUN_FROM_EMAIL"
  | "MAILGUN_FROM_NAME"
  | "MAILGUN_REGION";

export interface MailgunVarStatusEntry {
  key: MailgunVarKey;
  status: MailgunVarStatus;
  /** Only set for `MAILGUN_REGION`, which is not a secret. Always null otherwise. */
  value: string | null;
  /** True for `MAILGUN_REGION`; false for the four required vars. */
  optional: boolean;
}

export interface MailgunStatusResponse {
  /** True only when every required var is present (region is optional). */
  configured: boolean;
  variables: MailgunVarStatusEntry[];
}

export interface SystemStatusResponse {
  app_env: string;
  app_name: string;
  app_base_url: string | null;
  mailgun_configured: boolean;
  database_ok: boolean;
}
