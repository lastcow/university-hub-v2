// Mailgun email service (epic UNI-1 §13). Six functions, one per template,
// each:
//   1. enriches the caller-supplied variables with `app_name` / `app_base_url`
//      / `support_email` so templates can rely on them being present,
//   2. dispatches through the central `sendViaMailgun` HTTP boundary,
//   3. records exactly one `email_logs` row (sent or failed) per attempt,
//   4. returns a `SendResult` so callers can react without catching errors.
//
// Variable schema is intentionally open: each call site supplies whatever the
// template needs. The base set we always include is documented per function.

import { MAILGUN_TEMPLATES, type EmailType } from "@university-hub/shared";

import type { Env } from "../env.js";

import { writeEmailLog } from "./email-logs.js";
import { sendViaMailgun, type SendViaMailgunOptions } from "./mailgun.js";
import type {
  AccountStatusChangedSendInput,
  ContactNotificationSendInput,
  InvitationSendInput,
  PasswordResetSendInput,
  RelatedEntity,
  SendBaseInput,
  SendResult,
  TemplateVariables,
} from "./types.js";

export type {
  AccountStatusChangedSendInput,
  ContactNotificationSendInput,
  InvitationSendInput,
  PasswordResetSendInput,
  SendBaseInput,
  SendFailureReason,
  SendResult,
  TemplateVariables,
} from "./types.js";
export { sendViaMailgun, readMailgunConfig } from "./mailgun.js";
export { writeEmailLog } from "./email-logs.js";

interface DispatchInput {
  env: Env;
  type: EmailType;
  templateName: string;
  to: string;
  variables: TemplateVariables;
  universityId?: string | null;
  relatedEntity?: RelatedEntity | null;
  options?: SendViaMailgunOptions;
}

/**
 * Single internal entry point used by every send* function. Performs the
 * Mailgun call, then records the outcome to `email_logs`. Logging happens
 * even when Mailgun is unconfigured — the row is `failed` with reason
 * `mailgun_not_configured`, which is what the dev experience shows when
 * placeholder secrets are in play.
 */
async function dispatch(input: DispatchInput): Promise<SendResult> {
  const result = await sendViaMailgun(
    input.env,
    {
      type: input.type,
      templateName: input.templateName,
      to: input.to,
      variables: input.variables,
    },
    input.options,
  );

  await writeEmailLog(input.env.DB, {
    type: input.type,
    recipient: input.to,
    templateName: input.templateName,
    status: result.ok ? "sent" : "failed",
    mailgunMessageId: result.ok ? result.messageId : null,
    error: result.ok ? null : describeFailure(result),
    universityId: input.universityId ?? null,
    relatedEntityType: input.relatedEntity?.type ?? null,
    relatedEntityId: input.relatedEntity?.id ?? null,
  });

  return result;
}

function describeFailure(result: Extract<SendResult, { ok: false }>): string {
  // Persist a stable code first so admins can filter on it; append a sanitized
  // detail when we have one. Detail is already capped in mailgun.ts.
  if (result.detail) return `${result.reason}: ${result.detail}`;
  return result.reason;
}

function baseVariables(env: Env): TemplateVariables {
  return {
    app_name: env.APP_NAME ?? "University Hub",
    app_base_url: env.APP_BASE_URL ?? "",
    support_email: env.SUPPORT_EMAIL ?? "",
  };
}

function mergeVariables(
  env: Env,
  recipientEmail: string,
  extra: TemplateVariables | undefined,
): TemplateVariables {
  // Caller-supplied variables win over defaults, so a call site can override
  // `recipient_email` or `app_name` for a specific send if needed.
  return {
    ...baseVariables(env),
    recipient_email: recipientEmail,
    ...(extra ?? {}),
  };
}

export interface SendOptions {
  /** Test seam — overrides `globalThis.fetch` for the Mailgun HTTP call. */
  options?: SendViaMailgunOptions;
}

export async function sendInvitationEmail(
  env: Env,
  input: InvitationSendInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "invitation",
    templateName: MAILGUN_TEMPLATES.invitation,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity: input.relatedEntity ?? { type: "invitation", id: input.invitationId },
    options: opts.options,
  });
}

export async function sendInvitationResentEmail(
  env: Env,
  input: InvitationSendInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "invitation_resend",
    templateName: MAILGUN_TEMPLATES.invitation_resend,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity: input.relatedEntity ?? { type: "invitation", id: input.invitationId },
    options: opts.options,
  });
}

export async function sendWelcomeEmail(
  env: Env,
  input: SendBaseInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "welcome",
    templateName: MAILGUN_TEMPLATES.welcome,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity: input.relatedEntity ?? null,
    options: opts.options,
  });
}

export async function sendPasswordResetEmail(
  env: Env,
  input: PasswordResetSendInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "password_reset",
    templateName: MAILGUN_TEMPLATES.password_reset,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity:
      input.relatedEntity ?? (input.userId ? { type: "user", id: input.userId } : null),
    options: opts.options,
  });
}

export async function sendContactNotificationEmail(
  env: Env,
  input: ContactNotificationSendInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "contact_notification",
    templateName: MAILGUN_TEMPLATES.contact_notification,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity:
      input.relatedEntity ??
      (input.contactMessageId ? { type: "contact_message", id: input.contactMessageId } : null),
    options: opts.options,
  });
}

export async function sendAccountStatusChangedEmail(
  env: Env,
  input: AccountStatusChangedSendInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "account_status_changed",
    templateName: MAILGUN_TEMPLATES.account_status_changed,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity:
      input.relatedEntity ?? (input.userId ? { type: "user", id: input.userId } : null),
    options: opts.options,
  });
}

export async function sendParentSignInEmail(
  env: Env,
  input: SendBaseInput,
  opts: SendOptions = {},
): Promise<SendResult> {
  return dispatch({
    env,
    type: "parent_sign_in",
    templateName: MAILGUN_TEMPLATES.parent_sign_in,
    to: input.to,
    variables: mergeVariables(env, input.to, input.variables),
    universityId: input.universityId,
    relatedEntity: input.relatedEntity ?? null,
    options: opts.options,
  });
}
