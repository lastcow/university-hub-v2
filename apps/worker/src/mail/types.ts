// Shared types for the Mailgun email service.
//
// `SendResult` is a discriminated union so callers can branch on `ok` without
// catching exceptions — the service module never throws raw Mailgun errors at
// callers (epic UNI-1 §16). Reasons are stable, machine-readable strings;
// human-facing copy is the caller's responsibility.

import type { EmailType } from "@university-hub/shared";

/** Free-form bag of template variables sent to Mailgun (`h:X-Mailgun-Variables`). */
export type TemplateVariables = Record<string, string | number | boolean | null | undefined>;

export type SendFailureReason =
  | "mailgun_not_configured"
  | "mailgun_http_error"
  | "mailgun_network_error"
  | "mailgun_invalid_response";

export type SendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; reason: SendFailureReason; detail?: string };

/** Optional pointer back to whatever entity triggered the send (invitation, user, ...). */
export interface RelatedEntity {
  type: string;
  id: string;
}

/** Common parameters every send* function accepts. */
export interface SendBaseInput {
  to: string;
  variables?: TemplateVariables;
  universityId?: string | null;
  relatedEntity?: RelatedEntity | null;
}

export interface InvitationSendInput extends SendBaseInput {
  invitationId: string;
}

export interface PasswordResetSendInput extends SendBaseInput {
  userId?: string | null;
}

export interface AccountStatusChangedSendInput extends SendBaseInput {
  userId?: string | null;
}

export interface ContactNotificationSendInput extends SendBaseInput {
  contactMessageId?: string | null;
}

/** Internal shape used by the central HTTP boundary. */
export interface MailgunSendRequest {
  type: EmailType;
  templateName: string;
  to: string;
  variables: TemplateVariables;
}
