// Public POST /api/contact — accepts a contact-form submission, validates it
// with the shared zod schema, persists it to `contact_messages`, then asks
// Mailgun to send a notification email to the support inbox.
//
// Email failure does NOT fail the request: the row is already saved, the user
// gets a success response, and `email_logs` records the failure (UNI-9 §16).
// In dev with placeholder Mailgun secrets, that row will read
// `failed / mailgun_not_configured`.

import { contactMessageInputSchema } from "@university-hub/shared";

import { execute } from "../db/index.js";
import { sendContactNotificationEmail } from "../mail/index.js";
import type { RequestContext } from "../middleware/auth.js";
import { errorResponse, jsonOk } from "../utils/responses.js";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleCreateContactMessage(
  ctx: RequestContext,
): Promise<Response> {
  const raw = await readJson(ctx.request);
  const parsed = contactMessageInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_request", "Please check the form and try again.", {
      issues: parsed.error.flatten().fieldErrors,
    });
  }

  const id = crypto.randomUUID();
  const { name, email, message } = parsed.data;

  try {
    await execute(
      ctx.env.DB,
      `INSERT INTO contact_messages (id, name, email, message)
       VALUES (?, ?, ?, ?)`,
      [id, name, email, message],
    );
  } catch (cause) {
    console.error("contact_message_insert_failed", { cause });
    return errorResponse(
      500,
      "contact_persist_failed",
      "We couldn't record your message. Please try again in a moment.",
    );
  }

  // Notify the support inbox. The send writes its own `email_logs` row and
  // returns a `SendResult` we don't propagate to the user — a delivery
  // failure must never turn into a 5xx for the public form.
  const supportRecipient =
    (ctx.env.SUPPORT_EMAIL ?? "").trim() ||
    (ctx.env.MAILGUN_FROM_EMAIL ?? "").trim() ||
    "support@example.com";
  await sendContactNotificationEmail(ctx.env, {
    to: supportRecipient,
    contactMessageId: id,
    variables: {
      contact_name: name,
      contact_email: email,
      contact_message: message,
    },
  });

  return jsonOk({ id });
}
