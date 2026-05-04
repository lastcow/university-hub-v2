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

/**
 * Row returned by `GET /api/audit-logs`. The raw `metadata_json` text column
 * is parsed server-side into `metadata` so the admin UI doesn't have to
 * `JSON.parse` (and risk choking on legacy nulls / malformed rows).
 * `metadata_raw` is kept around for the rare case where parsing failed.
 *
 * `actor_*` and `university_name` are joined on for table rendering.
 */
export interface AuditLogListItem {
  id: Id;
  university_id: Id | null;
  university_name: string | null;
  actor_user_id: Id | null;
  actor_name: string | null;
  actor_email: string | null;
  action: AuditAction;
  entity_type: string | null;
  entity_id: Id | null;
  metadata: Record<string, unknown> | null;
  metadata_raw: string | null;
  created_at: IsoDateString;
}

export interface AuditLogListResponse {
  items: AuditLogListItem[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
