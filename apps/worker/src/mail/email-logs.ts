// Writer for the `email_logs` table (migration 0002). Every send attempt —
// success OR failure — produces one row (epic UNI-1 §13, §16).
//
// Failures here are swallowed and console.error'd: a logging miss should never
// break the user-facing flow that produced the email. We never include
// secrets (API key, raw error bodies) in the persisted row — `error` is a
// short stable code or a sanitized string from the central HTTP boundary.

import type { EmailLogStatus, EmailType } from "@university-hub/shared";

import { execute } from "../db/index.js";

export interface EmailLogInput {
  type: EmailType;
  recipient: string;
  templateName: string | null;
  status: EmailLogStatus;
  mailgunMessageId?: string | null;
  error?: string | null;
  universityId?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
}

export async function writeEmailLog(db: D1Database, input: EmailLogInput): Promise<void> {
  try {
    await execute(
      db,
      `INSERT INTO email_logs
         (id, university_id, recipient_email, type, template_name,
          status, mailgun_message_id, error,
          related_entity_type, related_entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.universityId ?? null,
        input.recipient,
        input.type,
        input.templateName,
        input.status,
        input.mailgunMessageId ?? null,
        input.error ?? null,
        input.relatedEntityType ?? null,
        input.relatedEntityId ?? null,
      ],
    );
  } catch (cause) {
    console.error("email_log_insert_failed", { type: input.type, status: input.status, cause });
  }
}
