import type { AUDIT_ACTIONS } from "../constants/audit-actions.js";
import type { Id, IsoDateString } from "./common.js";

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLog {
  id: Id;
  university_id: Id | null;
  actor_user_id: Id | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: Id | null;
  metadata_json: string | null;
  created_at: IsoDateString;
}
