// Audit log writer. Inserts a row into `audit_logs` for important actions.
// Failures are swallowed and logged — auditing should never block the user
// action that produced it.

import type { AuditAction } from "@university-hub/shared";

import { execute } from "../db/index.js";

export interface AuditLogInput {
  action: AuditAction;
  actorUserId?: string | null;
  universityId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function writeAuditLog(db: D1Database, input: AuditLogInput): Promise<void> {
  try {
    await execute(
      db,
      `INSERT INTO audit_logs
         (id, university_id, actor_user_id, action, entity_type, entity_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.universityId ?? null,
        input.actorUserId ?? null,
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
  } catch (cause) {
    console.error("audit_log_insert_failed", { action: input.action, cause });
  }
}
